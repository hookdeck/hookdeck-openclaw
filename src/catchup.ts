import type { HookdeckClient } from "./hookdeck/client.js";
import type { Logger } from "./ingress/handler.js";

/**
 * Recovers events that arrived while no listener was attached.
 *
 * A CLI destination is not durable when disconnected: with no session attached
 * the events become `CLI_DISCONNECTED` ignored events and the request is
 * discarded — not queued, not retried. Two regimes matter, and they are the
 * opposite way round from intuition:
 *
 *  - An **abnormal** disconnect gets a ~2 minute server-side grace window, and
 *    events in it are created for real, failing as `CLI_UNAVAILABLE` and
 *    staying in the normal retry pipeline. Recoverable for free.
 *  - A **clean** shutdown tombstones the session immediately and forfeits that
 *    window. Which is why shutdown pauses the connection before stopping the
 *    listener rather than just exiting politely.
 *
 * This is a REPLAY, not a retry, and the difference matters: there are no
 * events to retry, because Hookdeck discarded the requests without creating
 * any. Re-ingesting them mints new event ids, which the dedup ledger has no
 * way to relate to anything it has seen — so the query below is scoped to
 * requests that produced no event at all rather than to a bare time window.
 *
 * Replay is also the only path that can be scoped to an outage window:
 * `bulk/ignored-events/retry` accepts only `{cause, webhook_id,
 * transformation_id}` with no date filter, and there is no project-wide
 * `GET /ignored-events` to enumerate with.
 */

export interface CatchUpQueryParams {
  sinceMs: number;
  untilMs?: number;
  sourceId?: string;
}

/** What Hookdeck reported about a replay batch once it settled. */
export interface BatchOutcome {
  /** True once Hookdeck reported the batch finished. */
  complete: boolean;
  replayed?: number;
  planned?: number;
  /** Set when the outcome could not be established. */
  unknown?: string;
}

/**
 * Waits for a bulk replay to finish, within a bound.
 *
 * Bounded because this runs when a tunnel reconnects: a batch that never
 * completes must not hold the transport's recovery path open indefinitely. A
 * timeout is reported as unknown rather than as success.
 */
async function waitForBatch(
  options: CatchUpOptions,
  batchId: string,
): Promise<BatchOutcome> {
  const deadline =
    (options.now ?? Date.now)() + (options.verifyTimeoutMs ?? 30_000);
  const sleep =
    options.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));

  while ((options.now ?? Date.now)() < deadline) {
    const batch = await options.client.getBulkReplay(batchId);
    if (!batch.ok) {
      options.logger.warn(
        `catch-up replay was requested but its progress could not be read: ${batch.message}`,
      );
      return { complete: false, unknown: batch.message };
    }

    if (batch.data.completed_at != null || batch.data.in_progress === false) {
      const replayed = batch.data.completed_count;
      const planned = batch.data.estimated_count;
      const short =
        replayed !== undefined && planned !== undefined && replayed < planned;

      const line = `catch-up replay finished: ${replayed ?? "?"} of ${planned ?? "?"} request(s) replayed`;
      if (short) {
        options.logger.warn(
          `${line}. The shortfall arrived during the outage and was not recovered — ` +
            `replay it explicitly, or check it is still within Hookdeck's retention.`,
        );
      } else {
        options.logger.info(line);
      }

      return {
        complete: true,
        ...(replayed !== undefined ? { replayed } : {}),
        ...(planned !== undefined ? { planned } : {}),
      };
    }
    await sleep(1000);
  }

  // Not an error, but not a success either: saying which is the whole point.
  options.logger.warn(
    `catch-up replay ${batchId} had not finished within the wait, so whether every ` +
      `missed request was recovered is unknown. Check the batch in the Hookdeck dashboard.`,
  );
  return { complete: false, unknown: "timed out waiting for the batch" };
}

export function buildCatchUpQuery(
  params: CatchUpQueryParams,
): Record<string, unknown> {
  return {
    /**
     * Requests that produced NO EVENT AT ALL — the only filter that catches
     * every way a request can be stranded.
     *
     * Measured against a live project, because the two disconnect regimes look
     * different and only one of them was covered before:
     *
     *   tunnel never existed        events_count 0, ignored_count 1
     *   tunnel connected then died  events_count 0, ignored_count 0
     *
     * The second is the hard-crash case, and it matches neither
     * `ignored_count >= 1` nor `cli_events_count: 0` — that field is not
     * populated when no CLI event was ever created, so filtering on it
     * excludes precisely the case catch-up exists for.
     */
    events_count: 0,
    ingested_at: {
      gte: new Date(params.sinceMs).toISOString(),
      ...(params.untilMs !== undefined
        ? { lte: new Date(params.untilMs).toISOString() }
        : {}),
    },
    ...(params.sourceId !== undefined ? { source_id: params.sourceId } : {}),
  };
}

export interface CatchUpOptions {
  client: HookdeckClient;
  logger: Logger;
  connectionId: string;
  sinceMs: number;
  untilMs?: number;
  sourceId?: string;
  /** Below this, an outage is not worth a bulk operation. */
  minGapMs?: number;
  /** Set false to skip waiting for the batch and the post-replay check. */
  verify?: boolean;
  /** How long to wait for the batch before reporting the outcome unknown. */
  verifyTimeoutMs?: number;
  /** Injectable for tests, so waiting costs no wall-clock. */
  sleep?(ms: number): Promise<void>;
  now?(): number;
}

export type CatchUpResult =
  | { ran: false; reason: "gap_too_small" | "no_connection" }
  | {
      ran: true;
      batchId?: string;
      estimated?: number;
      /** What Hookdeck reported once the batch finished. */
      recovered?: BatchOutcome;
    }
  | { ran: false; reason: "failed"; message: string };

export const DEFAULT_MIN_GAP_MS = 30_000;

export async function runCatchUp(
  options: CatchUpOptions,
): Promise<CatchUpResult> {
  const now = options.now ?? Date.now;
  const until = options.untilMs ?? now();
  const gap = until - options.sinceMs;

  if (gap < (options.minGapMs ?? DEFAULT_MIN_GAP_MS)) {
    return { ran: false, reason: "gap_too_small" };
  }
  if (options.connectionId.length === 0) {
    return { ran: false, reason: "no_connection" };
  }

  const query = buildCatchUpQuery({
    sinceMs: options.sinceMs,
    untilMs: until,
    ...(options.sourceId !== undefined ? { sourceId: options.sourceId } : {}),
  });

  options.logger.info(
    `catching up on events missed during a ${Math.round(gap / 1000)}s outage`,
  );

  const result = await options.client.bulkReplayRequests({
    query,
    // `target` is required on replay; without it Hookdeck fans out to every
    // currently-active connection on the source, which is not what we mean.
    target: { webhook_ids: [options.connectionId] },
  });

  if (!result.ok) {
    // Never fatal to startup: ingress works regardless, and a failed catch-up
    // is better than a Gateway that will not boot.
    options.logger.warn(`catch-up replay failed: ${result.message}`);
    return { ran: false, reason: "failed", message: result.message };
  }

  // Waited for, because the replay call returns as soon as the batch is
  // accepted. The batch's own counts are the evidence of recovery: a replay
  // re-ingests each request as a NEW request with new events, leaving the
  // original at events_count 0 forever — so re-reading the window can never
  // show recovery, however long you wait for it.
  const batch =
    result.data.id !== undefined && options.verify !== false
      ? await waitForBatch(options, result.data.id)
      : undefined;

  // Checked, not assumed. A bulk replay reports what it queued rather than
  // what it recovered, so without this the only honest claim would be "a
  // replay was requested".
  return {
    ran: true,
    ...(result.data.id !== undefined ? { batchId: result.data.id } : {}),
    ...(result.data.estimated_count !== undefined
      ? { estimated: result.data.estimated_count }
      : {}),
    ...(batch !== undefined ? { recovered: batch } : {}),
  };
}

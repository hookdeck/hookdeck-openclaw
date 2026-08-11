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

export function buildCatchUpQuery(
  params: CatchUpQueryParams,
): Record<string, unknown> {
  return {
    // Requests that produced no CLI event and at least one ignored event: the
    // signature of "arrived while nothing was listening".
    cli_events_count: 0,
    ignored_count: { gte: 1 },
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
  now?(): number;
}

export type CatchUpResult =
  | { ran: false; reason: "gap_too_small" | "no_connection" }
  | { ran: true; batchId?: string; estimated?: number }
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

  return {
    ran: true,
    ...(result.data.id !== undefined ? { batchId: result.data.id } : {}),
    ...(result.data.estimated_count !== undefined
      ? { estimated: result.data.estimated_count }
      : {}),
  };
}

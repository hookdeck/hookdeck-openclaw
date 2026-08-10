import { runCatchUp } from "../catchup.js";
import {
  requireClient,
  isError,
  MIN_RETENTION_DAYS,
  RETENTION_NOTE,
  type ToolDeps,
} from "./deps.js";

/**
 * `hookdeck_replay` — re-delivers specific events, or a scoped bulk replay of
 * requests nothing was listening for. Always scoped, and a dry run until
 * confirmed, because an unscoped retry-everything costs real money.
 */

export interface ReplayResult {
  ok: boolean;
  note?: string;
  dryRun?: boolean;
  /** `events` for explicit ids, `bulk` for a scoped window. */
  mode?: "events" | "bulk";
  outcomes?: { eventId: string; ok: boolean; error?: string }[];
  /** Ids beyond the per-call cap, which were NOT retried. */
  dropped?: number;
  /** True when a rate limit stopped the batch before every id was tried. */
  stoppedEarly?: boolean;
  /** Ids Hookdeck no longer has, which usually means retention. */
  notFound?: number;
  retentionNote?: string;
  retentionWarning?: string;
  transportNote?: string;
  batchId?: string | null;
  estimated?: number | null;
}

export async function replayHandler(
  deps: ToolDeps,
  params: {
    eventIds?: string[];
    routeId?: string;
    sinceMinutes?: number;
    confirm?: boolean;
  },
): Promise<ReplayResult> {
  const client = requireClient(deps);
  if (isError(client)) return { ok: false, note: client.error };

  if (params.eventIds !== undefined && params.eventIds.length > 0) {
    const MAX_EVENT_IDS = 100;
    const accepted = params.eventIds.slice(0, MAX_EVENT_IDS);
    const dropped = params.eventIds.length - accepted.length;
    const outcomes = [];
    let aged = 0;
    let rateLimited: number | undefined;
    for (const id of accepted) {
      const result = await client.retryEvent(id);
      if (!result.ok && result.code === "not_found") aged += 1;
      outcomes.push({
        eventId: id,
        ok: result.ok,
        ...(result.ok ? {} : { error: result.message }),
      });

      // Stop rather than finish the loop. Every remaining call would fail the
      // same way, and a list of generic errors invites a caller to re-submit
      // the whole batch.
      if (!result.ok && result.code === "rate_limited") {
        rateLimited = result.retryAfterSeconds;
        break;
      }
    }
    return {
      ok: true,
      mode: "events" as const,
      outcomes,
      // Never truncate quietly: a caller who passed 250 ids and saw "ok" would
      // reasonably believe all 250 were retried.
      ...(dropped > 0
        ? {
            dropped,
            note: `Only the first ${MAX_EVENT_IDS} ids were retried; ${dropped} were not. Call again with the rest.`,
          }
        : {}),
      // A 404 on retry is almost always retention, not a typo, and an agent
      // will otherwise re-try the same dead ids.
      ...(aged > 0 ? { notFound: aged, retentionNote: RETENTION_NOTE } : {}),
      ...(rateLimited !== undefined || outcomes.length < accepted.length
        ? {
            stoppedEarly: true,
            note:
              `Hookdeck rate-limited this batch after ${outcomes.length} of ${accepted.length}. ` +
              `Nothing after that was retried. Wait${
                rateLimited !== undefined ? ` ${rateLimited}s` : ""
              } and call again with the remaining ids.`,
          }
        : {}),
    };
  }

  if (params.routeId === undefined || params.sinceMinutes === undefined) {
    return {
      ok: false,
      note: "Provide eventIds, or routeId plus sinceMinutes to scope a bulk replay.",
    };
  }

  const cursor = deps.cursors.get(params.routeId);
  if (cursor?.connectionId === undefined) {
    return {
      ok: false,
      note: `No connection id known for route '${params.routeId}'.`,
    };
  }

  // The bulk query matches requests that produced NO event and at least one
  // ignored event: the signature of "arrived while no CLI session was
  // attached". An HTTP destination is always reachable, so it never produces
  // that shape, and a bulk replay there would report success having replayed
  // nothing.
  if (deps.config.transport.mode === "http") {
    return {
      ok: false,
      note:
        `Bulk replay recovers requests that arrived while no CLI tunnel was listening, and an ` +
        `HTTP destination never produces that shape — this would report success having replayed ` +
        `nothing. A failed HTTP delivery stays in Hookdeck's own retry pipeline instead; pass ` +
        `eventIds to retry specific events.`,
    };
  }

  // `none` leaves the transport to the operator, who may well be running a
  // tunnel of their own, so the query can still match. Say what it looks for
  // rather than guessing.
  const transportNote =
    deps.config.transport.mode === "none"
      ? "transport.mode is 'none', so this matched only if something CLI-shaped was listening: " +
        "the query looks for requests that produced no event and at least one ignored event."
      : undefined;

  // Past retention there is nothing left to replay, whatever the window says.
  // Warn rather than refuse: we cannot see the project's plan from here, and
  // guessing a limit an operator has paid to exceed would be worse.
  const beyondShortestRetention =
    params.sinceMinutes > MIN_RETENTION_DAYS * 24 * 60;

  // An unscoped retry-everything costs real money, so a filtered replay is a
  // dry run until explicitly confirmed.
  if (params.confirm !== true) {
    return {
      ok: false,
      dryRun: true,
      note:
        `Would replay requests for route '${params.routeId}' from the last ${params.sinceMinutes} minute(s) ` +
        `that produced no CLI event. Re-run with confirm: true to execute.`,
      ...(beyondShortestRetention ? { retentionWarning: RETENTION_NOTE } : {}),
    };
  }

  const now = deps.now ?? Date.now;
  const result = await runCatchUp({
    client,
    logger: deps.logger,
    connectionId: cursor.connectionId,
    sinceMs: now() - params.sinceMinutes * 60_000,
    minGapMs: 0,
    now,
  });

  return result.ran
    ? {
        ok: true,
        mode: "bulk" as const,
        batchId: result.batchId ?? null,
        estimated: result.estimated ?? null,
        ...(beyondShortestRetention
          ? { retentionWarning: RETENTION_NOTE }
          : {}),
      }
    : { ok: false, note: `replay did not run: ${result.reason}` };
}

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

export async function replayHandler(
  deps: ToolDeps,
  params: {
    eventIds?: string[];
    routeId?: string;
    sinceMinutes?: number;
    confirm?: boolean;
  },
) {
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
      mode: "events",
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
        mode: "bulk",
        batchId: result.batchId ?? null,
        estimated: result.estimated ?? null,
        ...(beyondShortestRetention
          ? { retentionWarning: RETENTION_NOTE }
          : {}),
      }
    : { ok: false, note: `replay did not run: ${result.reason}` };
}

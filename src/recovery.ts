import type { EventRetrier } from "./hookdeck/client.js";
import type { Logger } from "./ingress/handler.js";
import type { DeadLetterLog } from "./store/deadletter.js";
import type { Ledger } from "./store/ledger.js";

/**
 * Boot-time reconciliation of orphaned work.
 *
 * A `running` row owned by a previous process instance is an orphan by
 * definition — the process that owned it is gone, so its outcome is unknown.
 * Rather than guessing, we hand it back to Hookdeck with
 * `POST /events/{id}/retry` and let the normal pipeline re-run it.
 *
 * This is the payoff of putting an event gateway in front: Hookdeck IS the
 * durable work queue, so the plugin never needs to build one. That matters
 * concretely here, because OpenClaw's own durable queue (`openChannelIngressQueue`)
 * is gated to bundled and trusted-official plugins and unavailable to us.
 *
 * The corollary, stated where operators will look rather than buried in a
 * comment: recovery can re-run an event whose dispatch completed in the instant
 * before the crash. That is the at-least-once contract the whole design already
 * assumes, not a new hazard — but it is the kind of thing discovered via a
 * duplicate side effect at 2am.
 */

export interface ReconcileOptions {
  ledger: Ledger;
  deadLetter: DeadLetterLog;
  logger: Logger;
  /** Absent when no API key is configured; recovery then records only. */
  client?: EventRetrier | undefined;
  /** Stops a crash loop from storming the API. */
  maxEvents?: number;
  enabled?: boolean;
}

export interface ReconcileSummary {
  found: number;
  retried: number;
  failed: number;
  /** Beyond `maxEvents`, or no client configured. */
  skipped: number;
}

export const DEFAULT_MAX_RECOVERY_EVENTS = 50;

export async function reconcileOrphans(options: ReconcileOptions): Promise<ReconcileSummary> {
  const { ledger, deadLetter, logger, client } = options;
  const maxEvents = options.maxEvents ?? DEFAULT_MAX_RECOVERY_EVENTS;
  const summary: ReconcileSummary = { found: 0, retried: 0, failed: 0, skipped: 0 };

  const orphans = ledger.listOrphans();
  summary.found = orphans.length;
  if (orphans.length === 0) return summary;

  if (options.enabled === false) {
    summary.skipped = orphans.length;
    logger.warn(
      `${orphans.length} interrupted event(s) found but recovery is disabled; they will not be re-run`,
    );
    return summary;
  }

  logger.info(`reconciling ${orphans.length} interrupted event(s) from a previous run`);

  // Oldest first: if the budget truncates, the events closest to falling out of
  // Hookdeck's retention window are the ones that get recovered.
  const ordered = [...orphans].sort((a, b) => a.updatedAt - b.updatedAt);

  for (const [index, row] of ordered.entries()) {
    // Settle the row first, whatever happens next. Leaving it `running` would
    // make the next boot treat it as an orphan again, forever.
    await ledger.settle(row.eventId, "failed");

    if (index >= maxEvents || client === undefined) {
      summary.skipped += 1;
      await deadLetter.record({
        eventId: row.eventId,
        ...(row.routeId !== undefined ? { routeId: row.routeId } : {}),
        code: "interrupted",
        reason:
          client === undefined
            ? "dispatch interrupted by shutdown; no API key configured, so it was not re-queued"
            : `dispatch interrupted by shutdown; beyond the recovery budget of ${maxEvents}`,
        retriesCancelled: false,
        lastAttempt: false,
        attemptCount: row.attempt,
      });
      continue;
    }

    const result = await client.retryEvent(row.eventId);
    if (result.ok) {
      summary.retried += 1;
      logger.debug(`re-queued interrupted event ${row.eventId}`);
      continue;
    }

    summary.failed += 1;
    await deadLetter.record({
      eventId: row.eventId,
      ...(row.routeId !== undefined ? { routeId: row.routeId } : {}),
      code: "recovery_failed",
      reason: `could not re-queue interrupted event: ${result.message}`,
      retriesCancelled: false,
      lastAttempt: false,
      attemptCount: row.attempt,
    });
    logger.warn(`could not re-queue interrupted event ${row.eventId}: ${result.message}`);
  }

  if (summary.skipped > 0 && client !== undefined) {
    logger.warn(
      `recovery budget reached: ${summary.skipped} interrupted event(s) were recorded but not re-queued`,
    );
  }

  return summary;
}

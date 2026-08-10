import { requireClient, isError, type ToolDeps } from "./deps.js";
import { summariseIssue, resolveConnectionNames } from "./issues.js";

/**
 * `hookdeck_recent_deliveries` — "did anything break overnight?"
 *
 * Hookdeck Issues are the dead-letter queue, so they are the primary source.
 * The local log only adds what Issues structurally cannot contain: failures
 * that happened after we already answered 2xx, which Hookdeck recorded as
 * successful deliveries.
 */

export async function recentDeliveriesHandler(
  deps: ToolDeps,
  params: { routeId?: string; limit?: number },
) {
  // Clamped at both ends: a negative limit reaches `slice(0, -1)` and returns
  // nearly the whole log, which is what the cap exists to prevent.
  const limit = Math.min(Math.max(params.limit ?? 20, 1), 100);

  // Filter first, then limit: filtering a pre-truncated page silently returns
  // fewer rows than asked for.
  const local = deps.deadLetter
    .list(500)
    .filter((r) => params.routeId === undefined || r.routeId === params.routeId)
    .slice(0, limit);

  // Joined rather than returned separately: Hookdeck's view and ours disagree
  // precisely when something interesting happened.
  const rows = local.map((entry) => {
    const row =
      entry.eventId !== undefined ? deps.ledger.get(entry.eventId) : undefined;
    return {
      eventId: entry.eventId ?? null,
      routeId: entry.routeId ?? null,
      ourCode: entry.code,
      reason: entry.reason,
      retriesCancelled: entry.retriesCancelled,
      lastAttempt: entry.lastAttempt,
      ledgerStatus: row?.status ?? null,
      attempt: row?.attempt ?? entry.attemptCount ?? null,
      at: new Date(entry.createdAt).toISOString(),
      hookdeckVisible: entry.hookdeckVisible === true,
    };
  });

  // Hookdeck's Issues ARE the dead-letter queue: a delivery issue with
  // strategy `final_attempt` means exactly "this event is not coming back",
  // with notifications and an acknowledge/resolve lifecycle attached.
  // Summarised by the same function `hookdeck_issues` uses. This had its own
  // copy, which read `issue_type` — the API field is `type` — so the primary
  // triage tool reported every open issue as type `null`, unable to say whether
  // a delivery, a transformation or backpressure had failed. One mapping, one
  // place to be wrong.
  let issues: ReturnType<typeof summariseIssue>[] | null = null;
  let issuesNote: string | undefined;
  if (deps.client !== undefined) {
    const result = await deps.client.listIssues({
      status: "OPENED",
      limit: limit,
    });
    if (result.ok) {
      const names = await resolveConnectionNames(deps.client, result.data);
      issues = result.data.map((i) => summariseIssue(i, names));
    } else {
      issuesNote = `Could not read Hookdeck Issues: ${result.message}`;
    }
  } else {
    issuesNote =
      "No API key configured, so Hookdeck Issues — the actual dead-letter queue — could not be read. " +
      "Only locally-recorded outcomes are shown below.";
  }

  const postAck = rows.filter((r) => r.hookdeckVisible !== true);

  return {
    source: deps.source,
    // The real DLQ.
    openIssues: issues,
    /**
     * Failures Hookdeck cannot see, because we had already answered 2xx when
     * they happened. No Issue will ever open for these.
     */
    unreportedFailures: postAck,
    /** Local mirror of failures Hookdeck also recorded; prefer the Issue. */
    locallyRecorded: rows.filter((r) => r.hookdeckVisible === true),
    ...(issuesNote !== undefined ? { note: issuesNote } : {}),
    ...(issues !== null && issues.length === 0 && postAck.length === 0
      ? {
          summary:
            "No open Hookdeck Issues and nothing failed after acknowledgement. Successful " +
            "deliveries leave no local record by design, so this means nothing has been given " +
            "up on rather than that nothing arrived.",
        }
      : {}),
  };
}

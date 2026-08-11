/**
 * Deduplication.
 *
 * The trap this rule exists to avoid: Hookdeck redelivers a FAILED event under
 * the SAME event id. So deduplicating on event id alone blocks every legitimate
 * retry — the receiver looks idempotent while quietly never retrying anything.
 *
 * The rule is therefore about the attempt number, not the identity:
 *
 *   Admit when the attempt number is greater than the highest attempt already
 *   recorded for that event id. Otherwise reject as a duplicate.
 *
 *   When the attempt header is absent, admit only if the previous run for that
 *   event is recorded as failed.
 *
 * Both inputs — the event id and the attempt count — arrive in unsigned
 * headers, since the HMAC covers only the body. An absurd attempt count would
 * otherwise retire every legitimate redelivery of that event as a duplicate,
 * so one is treated as no attempt count at all.
 *
 * Storage is the host's business; this rule is not.
 */

/**
 * Above this, an attempt count is not believable.
 *
 * Hookdeck's own ceiling is 50 automatic attempts, and manual retries and
 * replays add few enough that a five-digit count means the header is wrong or
 * hostile, not that an event has genuinely been tried that often.
 */
export const MAX_PLAUSIBLE_ATTEMPT = 10_000;

export type LedgerStatus = "running" | "succeeded" | "failed" | "exhausted";

export interface LedgerRow {
  eventId: string;
  /** Highest attempt number seen for this event. */
  attempt: number;
  /** How many times we have actually dispatched work for it. */
  runCount: number;
  status: LedgerStatus;
  updatedAt: number;
  /**
   * Which process instance owns this row. A `running` row whose owner is not
   * the current instance is an orphan by definition — the process that owned it
   * is gone — which is what makes boot reconciliation a rule rather than a
   * judgement call.
   */
  owner?: string;
  routeId?: string;
  /** Times we have asked Hookdeck to redeliver after a failed agent run. */
  agentRetries?: number;
}

export type AdmissionDecision =
  | {
      admit: true;
      reason: "first_delivery" | "attempt_advanced" | "previous_failed";
    }
  | {
      admit: false;
      reason:
        "duplicate_attempt" | "in_flight" | "already_succeeded" | "exhausted";
    };

/**
 * Discards an attempt count we do not believe.
 *
 * Applied wherever the header is used, not only when admitting: recording an
 * implausible value would raise the bar above every real redelivery of that
 * event and retire them all as duplicates. The header is unsigned, so this is
 * reachable by anyone who can replay a captured body.
 */
export function plausibleAttempt(
  attemptCount: number | undefined,
): number | undefined {
  if (attemptCount === undefined) return undefined;
  return attemptCount > MAX_PLAUSIBLE_ATTEMPT ? undefined : attemptCount;
}

export function decideAdmission(
  row: LedgerRow | undefined,
  rawAttemptCount: number | undefined,
): AdmissionDecision {
  const attemptCount = plausibleAttempt(rawAttemptCount);

  if (row === undefined) return { admit: true, reason: "first_delivery" };

  if (attemptCount !== undefined) {
    if (attemptCount > row.attempt)
      return { admit: true, reason: "attempt_advanced" };
    // Same or lower attempt number. Report the most useful reason for the
    // operator rather than a bare "duplicate".
    if (row.status === "running") return { admit: false, reason: "in_flight" };
    if (row.status === "succeeded")
      return { admit: false, reason: "already_succeeded" };
    if (row.status === "exhausted")
      return { admit: false, reason: "exhausted" };
    return { admit: false, reason: "duplicate_attempt" };
  }

  // No attempt header. The only safe re-admission is a previous run we know
  // failed. `running` is unknown-outcome, `succeeded` is done, and `exhausted`
  // means we already gave up deliberately.
  if (row.status === "failed")
    return { admit: true, reason: "previous_failed" };
  if (row.status === "running") return { admit: false, reason: "in_flight" };
  if (row.status === "succeeded")
    return { admit: false, reason: "already_succeeded" };
  return { admit: false, reason: "exhausted" };
}

/** Terminal rows may be pruned on a TTL. `running` rows never may — they are
 * the only record of work whose outcome we do not know, and boot-time
 * reconciliation depends on finding them. */
export function isPrunable(
  row: LedgerRow,
  now: number,
  ttlMs: number,
): boolean {
  if (row.status === "running") return false;
  return now - row.updatedAt > ttlMs;
}

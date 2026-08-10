/**
 * Response planning: what we answer Hookdeck, and therefore what Hookdeck does
 * next. Every status code in this file is chosen for its downstream effect, not
 * for HTTP tidiness.
 *
 *   2xx  -> delivered, no retry
 *   4xx  -> retried by default (any non-2xx is), which is usually NOT what we
 *           want for permanently-invalid input; see `cancelRetries`
 *   5xx  -> retried, and this is the case retries exist for
 *
 * `Retry-After` overrides the connection's retry rule entirely and needs no
 * rule configured. `Retry-After: -1` cancels all further automatic retries.
 */

/**
 * The closed allowlist of situations permitted to cancel retries.
 *
 * The test for membership is precise, and stricter than "this request is
 * invalid": **a retry of this exact event can never succeed, whatever the
 * operator changes.** Hookdeck replays the stored request byte-for-byte, so
 * anything baked into that request — its method, content type, size, or an
 * unparseable body — will fail identically on every attempt.
 *
 * Deliberately absent, because an operator fix makes a later retry of the SAME
 * event succeed:
 *
 *  - an unknown route (add or enable the route, and the retry matches);
 *  - a missing signature header (set the destination's auth to
 *    HOOKDECK_SIGNATURE — Hookdeck computes the signature at delivery time, so
 *    retries are then signed);
 *  - a missing event id (fix `headerPrefix` and the retry parses);
 *  - a missing or unresolvable secret, or a storage failure.
 */
export const CANCEL_REASONS = [
  "bad_method",
  "bad_content_type",
  "too_large",
  "malformed_json",
  "invalid_envelope",
  "forbidden_action",
  "flow_revision_conflict",
  "flow_not_managed",
  "agent_input_invalid",
  "signature_cancel_mode",
] as const;

export type CancelReason = (typeof CANCEL_REASONS)[number];

export type RetryDirective =
  | { kind: "none" }
  | { kind: "after"; seconds: number }
  | { kind: "cancel"; reason: CancelReason };

export interface ResponsePlan {
  status: number;
  /** Machine-readable outcome code, echoed in the JSON body. */
  code: string;
  message?: string;
  retry: RetryDirective;
  /** Whether to append a local dead-letter record before responding. */
  deadLetter: boolean;
}

const NO_RETRY: RetryDirective = { kind: "none" };

export function ok(code: string, message?: string): ResponsePlan {
  return { status: 200, code, message, retry: NO_RETRY, deadLetter: false };
}

export function accepted(code: string, message?: string): ResponsePlan {
  return { status: 202, code, message, retry: NO_RETRY, deadLetter: false };
}

/**
 * Statuses the pipeline may emit expecting Hookdeck to retry.
 *
 * This list and the connection's `response_status_codes` rule are two halves of
 * one contract, and drift between them is silent data loss: we answer 404
 * expecting a redelivery, the rule does not cover 404, and the event is simply
 * gone with nothing recording that a choice was made. It is the quieter cousin
 * of an over-broad retry cancellation — at least a cancellation is auditable.
 *
 * Typing `retryable()` and `deferFor()` to this union means emitting an
 * uncovered status is a compile error rather than a production surprise.
 *
 * 400 is here because two of our 400s are recoverable: a missing signature
 * header (the operator sets the destination's auth to HOOKDECK_SIGNATURE and
 * retries arrive signed, since Hookdeck signs at delivery time) and a missing
 * event id (correcting `headerPrefix` makes the retry parse). Malformed JSON is
 * also a 400 but goes through `cancelRetries`, so it is retired deliberately
 * rather than by omission.
 *
 * 413 is deliberately absent: the body limit is a plugin constant, not operator
 * config, so no change makes that event succeed.
 */
export const RETRYABLE_STATUSES = [400, 401, 404, 408, 409, 429, 500, 502, 503] as const;
export type RetryableStatus = (typeof RETRYABLE_STATUSES)[number];

/**
 * Ask Hookdeck to come back in `seconds`.
 *
 * Use this ONLY where the condition is expected to clear in seconds — capacity,
 * an in-flight duplicate, a Gateway still booting.
 *
 * `Retry-After` overrides the connection's retry rule entirely, which makes it a
 * budget hazard on anything that might persist: at 30s a side, the 50-attempt
 * ceiling is spent in 25 minutes and the event is gone, where the connection's
 * exponential rule would have spread those attempts across up to a week. For a
 * failure an operator has to notice and fix, that difference is the difference
 * between recovering the event and losing it.
 */
export function deferFor(
  status: RetryableStatus,
  code: string,
  seconds: number,
  message?: string,
): ResponsePlan {
  return { status, code, retry: { kind: "after", seconds }, message, deadLetter: false };
}

/**
 * A failure retried on Hookdeck's own schedule. The right choice whenever the
 * cause might persist, precisely because exponential backoff stretches the
 * attempt budget out far enough for a human to intervene.
 */
export function retryable(status: RetryableStatus, code: string, message?: string): ResponsePlan {
  return { status, code, retry: NO_RETRY, message, deadLetter: false };
}

/**
 * The SOLE producer of a retry-cancelling response. Routing every cancellation
 * through one function is what makes the blast radius auditable: each call site
 * must name a reason from the allowlist, and each emission is logged and
 * counted by the caller.
 *
 * Always dead-letters. If we are telling Hookdeck to stop trying, the payload
 * has to survive locally or it is simply lost.
 */
export function cancelRetries(
  reason: CancelReason,
  status: number,
  message?: string,
): ResponsePlan {
  return { status, code: reason, retry: { kind: "cancel", reason }, message, deadLetter: true };
}

export interface RenderRetryAfterOptions {
  /**
   * Kill switch. When false, cancellations degrade to "no Retry-After header",
   * which leaves Hookdeck's normal retry rules in force. Default behaviour is
   * then byte-identical to the sibling Hermes and n8n plugins.
   */
  allowRetryCancel: boolean;
}

export function renderRetryAfterHeader(
  plan: ResponsePlan,
  opts: RenderRetryAfterOptions,
): string | undefined {
  switch (plan.retry.kind) {
    case "none":
      return undefined;
    case "after":
      return String(Math.max(0, Math.round(plan.retry.seconds)));
    case "cancel":
      return opts.allowRetryCancel ? "-1" : undefined;
  }
}

/**
 * The connection's `response_status_codes` rule, derived from the statuses we
 * actually emit so the two cannot drift apart. `doctor` asserts the live rule
 * still covers this set.
 */
export const RETRYABLE_STATUS_CODES: readonly string[] = [
  ...RETRYABLE_STATUSES.filter((s) => s < 500).map(String),
  "500-599",
];

export function isRetryableStatus(status: number): boolean {
  return (RETRYABLE_STATUSES as readonly number[]).includes(status) || status >= 500;
}

export function planToBody(plan: ResponsePlan, extra?: Record<string, unknown>): string {
  return JSON.stringify({
    ok: plan.status < 400,
    code: plan.code,
    ...(plan.message ? { message: plan.message } : {}),
    ...extra,
  });
}

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
  "flow_not_found_exhausted",
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
export function deferFor(status: number, code: string, seconds: number, message?: string): ResponsePlan {
  return { status, code, retry: { kind: "after", seconds }, message, deadLetter: false };
}

/**
 * A failure retried on Hookdeck's own schedule. The right choice whenever the
 * cause might persist, precisely because exponential backoff stretches the
 * attempt budget out far enough for a human to intervene.
 */
export function retryable(status: number, code: string, message?: string): ResponsePlan {
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

/** Status codes we can emit that Hookdeck must be configured to retry. */
export const RETRYABLE_STATUS_CODES = ["500-599", "429", "408"] as const;

export function isRetryableStatus(status: number): boolean {
  return status >= 500 || status === 429 || status === 408;
}

export function planToBody(plan: ResponsePlan, extra?: Record<string, unknown>): string {
  return JSON.stringify({
    ok: plan.status < 400,
    code: plan.code,
    ...(plan.message ? { message: plan.message } : {}),
    ...extra,
  });
}

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
 * The closed allowlist of situations permitted to cancel retries. Anything a
 * config change could fix is deliberately absent — a missing secret, an
 * unresolvable secretRef or a storage failure must stay retryable so the event
 * survives in Hookdeck and lands once the operator fixes it.
 */
export const CANCEL_REASONS = [
  "unknown_route",
  "bad_method",
  "bad_content_type",
  "too_large",
  "not_hookdeck",
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

/** A transient failure: ask Hookdeck to come back in `seconds`. */
export function retryAfter(status: number, code: string, seconds: number, message?: string): ResponsePlan {
  return { status, code, retry: { kind: "after", seconds }, message, deadLetter: false };
}

/** A failure we want retried on Hookdeck's own schedule. */
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

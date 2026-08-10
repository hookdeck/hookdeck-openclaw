import { matchRoute } from "../plugin/config-parse.js";
import type { HookdeckPluginConfig, RouteConfig } from "../plugin/config-types.js";
import { decideAdmission } from "../protocol/admission.js";
import { parseHookdeckDelivery, type HookdeckDelivery } from "../protocol/delivery.js";
import {
  cancelRetries,
  ok,
  planToBody,
  renderRetryAfterHeader,
  deferFor,
  retryable,
  type ResponsePlan,
} from "../protocol/outcome.js";
import { verifyHookdeckSignature } from "../protocol/signature.js";
import type { Dispatcher } from "../dispatch/types.js";
import { evaluateFilters } from "../protocol/filters.js";
import type { DeadLetterLog } from "../store/deadletter.js";
import type { InFlightRegistry } from "../store/in-flight.js";
import type { Ledger } from "../store/ledger.js";
import {
  readRawBody,
  DEFAULT_BODY_TIMEOUT_MS,
  DEFAULT_MAX_BODY_BYTES,
  type RawBodySource,
} from "./raw-body.js";

export interface Logger {
  debug(msg: string): void;
  info(msg: string): void;
  warn(msg: string): void;
}

export interface HandlerDeps {
  config: HookdeckPluginConfig;
  /** Resolved per request so secret rotation takes effect without a restart. */
  resolveSigningSecret(routeId: string, route: RouteConfig): Promise<string | undefined>;
  dispatcherFor(routeId: string, route: RouteConfig): Dispatcher;
  ledger: Ledger;
  inFlight: InFlightRegistry;
  logger: Logger;
  deadLetter?: DeadLetterLog | undefined;
  now?(): number;
  maxBodyBytes?: number;
  bodyTimeoutMs?: number;
  /** Incremented on every retry cancellation, surfaced by `status`. */
  onRetryCancel?(reason: string, routeId: string | undefined): void;
}

export interface IncomingDelivery {
  method?: string;
  url?: string;
  headers: Record<string, string | string[] | undefined>;
  stream: RawBodySource;
}

export interface HandledDelivery {
  plan: ResponsePlan;
  extra: Record<string, unknown>;
  routeId?: string;
  delivery?: HookdeckDelivery;
}

function contentTypeIsJson(headers: Record<string, string | string[] | undefined>): boolean {
  const raw = headers["content-type"];
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (typeof value !== "string") return false;
  const mime = value.split(";", 1)[0]?.trim().toLowerCase() ?? "";
  return mime === "application/json" || mime.endsWith("+json");
}

function pathnameOf(url: string | undefined): string {
  if (!url) return "/";
  const q = url.indexOf("?");
  return q === -1 ? url : url.slice(0, q);
}

/**
 * The ordered request pipeline. Every status code is chosen for what Hookdeck
 * does next, not for HTTP tidiness — see `src/protocol/outcome.ts`.
 *
 * Two orderings are load-bearing and easy to get wrong:
 *
 *  - Signature verification happens BEFORE admission control, so a flood of
 *    unsigned junk cannot consume delivery capacity.
 *  - Admission control happens BEFORE any ledger write. Nothing is recorded for
 *    a deferred event: recording it would make Hookdeck's redelivery look like a
 *    duplicate, and the event would vanish.
 */
async function runPipeline(
  deps: HandlerDeps,
  req: IncomingDelivery,
): Promise<HandledDelivery> {
  const { config, logger } = deps;

  const cancel = (
    reason: Parameters<typeof cancelRetries>[0],
    status: number,
    message: string,
    routeId?: string,
    delivery?: HookdeckDelivery,
  ): HandledDelivery => {
    deps.onRetryCancel?.(reason, routeId);
    logger.warn(`retry-cancel [${reason}] ${message}`);
    return {
      plan: cancelRetries(reason, status, message),
      extra: {},
      ...(routeId !== undefined ? { routeId } : {}),
      ...(delivery !== undefined ? { delivery } : {}),
    };
  };

  // 1. Method.
  if ((req.method ?? "").toUpperCase() !== "POST") {
    return cancel("bad_method", 405, `expected POST, got ${req.method ?? "(none)"}`);
  }

  // 2. Route match.
  const pathname = pathnameOf(req.url);
  const matched = matchRoute(config, pathname);
  if (matched === undefined) {
    // Retryable, not cancelled: adding or enabling the route makes a later
    // retry of this same event succeed. No Retry-After, so the connection's
    // exponential rule spreads the attempts far enough for someone to notice.
    logger.warn(`no enabled route for '${pathname}'`);
    return { plan: retryable(404, "unknown_route", `no enabled route for '${pathname}'`), extra: {} };
  }
  const { routeId, route } = matched;

  // 3. Content type.
  if (!contentTypeIsJson(req.headers)) {
    return cancel("bad_content_type", 415, "expected application/json", routeId);
  }

  // 4. Raw body. Needed as bytes: the signature covers the exact octets sent.
  const bodyResult = await readRawBody(req.stream, {
    maxBytes: deps.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES,
    timeoutMs: deps.bodyTimeoutMs ?? DEFAULT_BODY_TIMEOUT_MS,
  });
  if (!bodyResult.ok) {
    if (bodyResult.reason === "too_large") {
      return cancel("too_large", 413, "request body exceeds limit", routeId);
    }
    return {
      plan: retryable(408, "body_read_failed", `could not read body: ${bodyResult.reason}`),
      extra: {},
      routeId,
    };
  }
  const rawBody = bodyResult.body;

  // 5. Signing secret. Absent is a failure, never a bypass — and it is a config
  //    problem, so it must stay retryable.
  const secret = await deps.resolveSigningSecret(routeId, route);
  if (!secret) {
    logger.warn(`route '${routeId}': no signing secret resolved; rejecting with 503`);
    // No Retry-After: a missing secret needs a human, and a fixed short
    // interval would spend the 50-attempt ceiling in under half an hour.
    return {
      plan: retryable(503, "no_signing_secret", "signing secret is not configured"),
      extra: {},
      routeId,
    };
  }

  // 6. Parse Hookdeck headers.
  const delivery = parseHookdeckDelivery(req.headers, config.headerPrefix);
  if (!delivery.looksLikeHookdeck) {
    // Also retryable: setting the destination's auth to HOOKDECK_SIGNATURE
    // makes Hookdeck sign subsequent retries of this same event, since the
    // signature is computed at delivery time rather than stored.
    const message = `no '${config.headerPrefix}-signature' header; is this request coming via Hookdeck, and is the destination's auth set to HOOKDECK_SIGNATURE?`;
    logger.warn(`route '${routeId}': ${message}`);
    return { plan: retryable(400, "not_hookdeck", message), extra: {}, routeId };
  }

  // 7. Signature, both slots. The second carries the previous secret during a
  //    rolling rotation — rejecting it would drop live traffic mid-roll.
  const verification = verifyHookdeckSignature({
    rawBody,
    secret,
    signatures: delivery.signatures,
  });
  if (!verification.valid) {
    logger.warn(`route '${routeId}': signature verification failed`);
    return {
      plan: retryable(401, "invalid_signature", "signature verification failed"),
      extra: {},
      routeId,
      delivery,
    };
  }
  if (verification.matchedSlot === 1) {
    logger.info(`route '${routeId}': signature matched rotation slot; finish the secret roll`);
  }

  const eventId = delivery.eventId;
  if (eventId === undefined) {
    // Correcting `headerPrefix` makes a retry of this same event parse.
    const message = `no '${config.headerPrefix}-eventid' or 'idempotency-key' header; cannot deduplicate`;
    logger.warn(`route '${routeId}': ${message}`);
    return { plan: retryable(400, "no_event_id", message), extra: {}, routeId, delivery };
  }

  // 8. Admission control. BEFORE any ledger write.
  if (deps.inFlight.has(eventId)) {
    return {
      plan: deferFor(503, "in_flight", 5, "this event is already being processed"),
      extra: {},
      routeId,
      delivery,
    };
  }
  if (!deps.inFlight.acquire(eventId)) {
    logger.debug(`route '${routeId}': at max_concurrent (${config.maxConcurrent}), deferring`);
    return {
      plan: deferFor(
        503,
        "busy",
        config.busyRetryAfterSeconds,
        `at capacity (${config.maxConcurrent} concurrent)`,
      ),
      extra: {},
      routeId,
      delivery,
    };
  }

  try {
    // 9. Deduplication.
    const existing = deps.ledger.get(eventId);
    const admission = decideAdmission(existing, delivery.attemptCount);
    if (!admission.admit) {
      logger.debug(`route '${routeId}': duplicate delivery of ${eventId} (${admission.reason})`);
      return {
        plan: ok("duplicate", `already handled (${admission.reason})`),
        extra: { duplicate: true, eventId },
        routeId,
        delivery,
      };
    }

    // 10. Decode and parse.
    //
    // Node differs from most runtimes in a way that matters:
    // `Buffer.toString("utf8")` never throws — it substitutes U+FFFD for
    // invalid bytes. Invalid bytes outside a string produce a SyntaxError and
    // are caught below, but invalid bytes INSIDE a string value parse happily,
    // silently corrupting the text. That text is rendered into a prompt, so
    // accepting it is worse than rejecting it. RFC 8259 §8.1 requires JSON
    // exchanged between systems to be UTF-8, so a body that fails to round-trip
    // is malformed by definition.
    const decoded = rawBody.toString("utf8");
    if (!Buffer.from(decoded, "utf8").equals(rawBody)) {
      return cancel(
        "malformed_json",
        400,
        "body is not valid UTF-8; JSON must be UTF-8 encoded (RFC 8259 §8.1)",
        routeId,
        delivery,
      );
    }

    let payload: unknown;
    try {
      payload = JSON.parse(decoded);
    } catch (err) {
      return cancel(
        "malformed_json",
        400,
        err instanceof Error ? err.message : "invalid JSON",
        routeId,
        delivery,
      );
    }

    // 11. Route filters. A non-match is a deliberate drop, and a 2xx correctly
    //     retires the event rather than leaving Hookdeck retrying something we
    //     will never accept.
    const filtered = evaluateFilters(route.filters, payload);
    if (!filtered.matched) {
      logger.debug(`route '${routeId}': filtered out ${eventId} (${filtered.reason})`);
      return {
        plan: ok("ignored", filtered.reason),
        extra: { ignored: true, eventId },
        routeId,
        delivery,
      };
    }

    // 12. Dispatch, bracketed by ledger writes. `begin` is awaited: it is the
    //     boundary before which we must not acknowledge anything.
    await deps.ledger.begin(eventId, delivery.attemptCount ?? 1, { routeId });
    const outcome = await deps
      .dispatcherFor(routeId, route)
      .dispatch({ routeId, delivery, payload });

    // `deferred` means the dispatcher took ownership and settles the row itself
    // when its background run finishes. Settling here would tell the next boot
    // the work completed, leaving a crash mid-run unrecovered.
    if (outcome.settle !== "deferred") {
      await deps.ledger.settle(eventId, outcome.settle);
    }

    return {
      plan: outcome.plan,
      extra: { eventId, ...(delivery.isLastAutomaticAttempt ? { lastAttempt: true } : {}) },
      routeId,
      delivery,
    };
  } finally {
    deps.inFlight.release(eventId);
  }
}

export async function handleDelivery(
  deps: HandlerDeps,
  req: IncomingDelivery,
): Promise<HandledDelivery> {
  const handled = await runPipeline(deps, req);
  await recordDeadLetter(deps, handled);
  return handled;
}

/**
 * Dead-letters anything Hookdeck will not retry again — either because we told
 * it not to, or because this was its last automatic attempt.
 *
 * The last-attempt case deliberately keeps its failure status rather than being
 * flipped to 2xx to keep the dashboard green: the failure is what opens a
 * Hookdeck Issue, and the Issue is the operator's alert. This record is the
 * local copy an agent can read without an API call.
 */
async function recordDeadLetter(deps: HandlerDeps, handled: HandledDelivery): Promise<void> {
  const log = deps.deadLetter;
  if (log === undefined) return;

  const { plan, delivery, routeId } = handled;
  const cancelled = plan.retry.kind === "cancel";
  // Any non-2xx on the final automatic attempt loses the event, not just the
  // codes we nominate as retryable — a 401 on the last attempt is just as gone
  // as a 503.
  const lastAttemptFailure =
    delivery?.isLastAutomaticAttempt === true && plan.status >= 400;

  if (!cancelled && !lastAttemptFailure) return;

  try {
    await log.record({
      ...(delivery?.eventId !== undefined ? { eventId: delivery.eventId } : {}),
      ...(delivery?.requestId !== undefined ? { requestId: delivery.requestId } : {}),
      ...(routeId !== undefined ? { routeId } : {}),
      code: plan.code,
      reason: plan.message ?? plan.code,
      // Reflects what we will actually put on the wire, not merely what the
      // plan asked for: with the kill switch off, no cancellation is sent.
      retriesCancelled: cancelled && deps.config.safety.allowRetryCancel,
      lastAttempt: delivery?.isLastAutomaticAttempt ?? false,
      ...(delivery?.attemptCount !== undefined ? { attemptCount: delivery.attemptCount } : {}),
    });
  } catch (err) {
    // Dead-lettering is a diagnostic, never a gate on the response.
    deps.logger.warn(`could not record dead letter: ${err instanceof Error ? err.message : err}`);
  }
}

export interface ResponseSink {
  statusCode: number;
  setHeader(name: string, value: string): void;
  end(chunk?: string): void;
}

export function writePlan(
  res: ResponseSink,
  handled: HandledDelivery,
  opts: { allowRetryCancel: boolean },
): void {
  const { plan } = handled;
  res.statusCode = plan.status;
  res.setHeader("content-type", "application/json; charset=utf-8");

  const retryAfterHeader = renderRetryAfterHeader(plan, opts);
  if (retryAfterHeader !== undefined) res.setHeader("retry-after", retryAfterHeader);

  res.end(planToBody(plan, handled.extra));
}

import { matchRoute } from "../plugin/config-parse.js";
import type { HookdeckPluginConfig, RouteConfig } from "../plugin/config-types.js";
import { decideAdmission } from "../protocol/admission.js";
import { parseHookdeckDelivery, type HookdeckDelivery } from "../protocol/delivery.js";
import {
  cancelRetries,
  ok,
  planToBody,
  renderRetryAfterHeader,
  retryAfter,
  retryable,
  type ResponsePlan,
} from "../protocol/outcome.js";
import { verifyHookdeckSignature } from "../protocol/signature.js";
import type { Dispatcher } from "../dispatch/wake.js";
import type { InFlightRegistry, Ledger } from "../store/memory-ledger.js";
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
 * Two orderings here are load-bearing and easy to get wrong:
 *
 *  - Signature verification happens BEFORE admission control, so a flood of
 *    unsigned junk cannot consume delivery capacity.
 *  - Admission control happens BEFORE any ledger write. Nothing is recorded for
 *    a deferred event: recording it would make Hookdeck's redelivery look like a
 *    duplicate, and the event would vanish.
 */
export async function handleDelivery(
  deps: HandlerDeps,
  req: IncomingDelivery,
): Promise<HandledDelivery> {
  const { config, logger } = deps;
  const now = deps.now ?? Date.now;

  const cancel = (
    reason: Parameters<typeof cancelRetries>[0],
    status: number,
    message: string,
    routeId?: string,
  ): HandledDelivery => {
    deps.onRetryCancel?.(reason, routeId);
    logger.warn(`retry-cancel [${reason}] ${message}`);
    return { plan: cancelRetries(reason, status, message), extra: {}, ...(routeId ? { routeId } : {}) };
  };

  // 1. Method.
  if ((req.method ?? "").toUpperCase() !== "POST") {
    return cancel("bad_method", 405, `expected POST, got ${req.method ?? "(none)"}`);
  }

  // 2. Route match. A prefix route is registered, so anything unmatched under
  //    the base path is a misconfiguration rather than transient.
  const pathname = pathnameOf(req.url);
  const matched = matchRoute(config, pathname);
  if (matched === undefined) {
    return cancel("unknown_route", 404, `no enabled route for '${pathname}'`);
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
    // A timeout or a dropped connection is transient; keep it retryable.
    return {
      plan: retryable(408, "body_read_failed", `could not read body: ${bodyResult.reason}`),
      extra: {},
      routeId,
    };
  }
  const rawBody = bodyResult.body;

  // 5. Signing secret. Absent is a failure, never a bypass — and it is a
  //    config problem, so it must stay retryable.
  const secret = await deps.resolveSigningSecret(routeId, route);
  if (!secret) {
    logger.warn(`route '${routeId}': no signing secret resolved; rejecting with 503`);
    return {
      plan: retryAfter(503, "no_signing_secret", 30, "signing secret is not configured"),
      extra: {},
      routeId,
    };
  }

  // 6. Parse Hookdeck headers.
  const delivery = parseHookdeckDelivery(req.headers, config.headerPrefix);
  if (!delivery.looksLikeHookdeck) {
    return cancel(
      "not_hookdeck",
      400,
      `no '${config.headerPrefix}-signature' header; is this request coming via Hookdeck?`,
      routeId,
    );
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
    // Left retryable on purpose: an in-flight rotation self-heals on the next
    // attempt because we re-resolve the secret per request, and a spoofer's
    // retries cost us nothing since we reject before doing any work.
    return { plan: retryable(401, "invalid_signature", "signature verification failed"), extra: {}, routeId, delivery };
  }
  if (verification.matchedSlot === 1) {
    logger.info(`route '${routeId}': signature matched rotation slot; finish the secret roll`);
  }

  const eventId = delivery.eventId;
  if (eventId === undefined) {
    // Without an identity we cannot deduplicate, and running unbounded
    // duplicates of agent work is worse than refusing.
    return cancel(
      "not_hookdeck",
      400,
      `no '${config.headerPrefix}-eventid' or 'idempotency-key' header; cannot deduplicate`,
      routeId,
    );
  }

  // 8. Admission control. BEFORE any ledger write.
  if (deps.inFlight.has(eventId)) {
    // The same event is already being dispatched. Answering 2xx would retire
    // the retry, and if the in-flight attempt then failed we would have
    // silently dropped the event.
    return {
      plan: retryAfter(503, "in_flight", 5, "this event is already being processed"),
      extra: {},
      routeId,
      delivery,
    };
  }
  if (!deps.inFlight.acquire(eventId)) {
    logger.debug(`route '${routeId}': at max_concurrent (${config.maxConcurrent}), deferring`);
    return {
      plan: retryAfter(
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

    // 10. Parse the payload. Malformed JSON will never become valid.
    let payload: unknown;
    try {
      payload = JSON.parse(rawBody.toString("utf8"));
    } catch (err) {
      return cancel(
        "malformed_json",
        400,
        err instanceof Error ? err.message : "invalid JSON",
        routeId,
      );
    }

    // 11. Dispatch, bracketed by ledger writes.
    deps.ledger.begin(eventId, delivery.attemptCount ?? 1, now());
    const result = await deps
      .dispatcherFor(routeId, route)
      .dispatch({ routeId, delivery, payload });

    if (result.ok) {
      deps.ledger.settle(eventId, "succeeded", now());
      return {
        plan: ok("dispatched", result.detail),
        extra: { eventId },
        routeId,
        delivery,
      };
    }

    deps.ledger.settle(eventId, "failed", now());
    if (delivery.isLastAutomaticAttempt) {
      // Do NOT flip this to 2xx to keep the dashboard green: the failure is
      // what opens a Hookdeck Issue, and the Issue is the operator's alert.
      logger.warn(
        `route '${routeId}': final automatic attempt for ${eventId} failed — ${result.message}`,
      );
    }
    return {
      plan: result.retryable
        ? retryAfter(503, "dispatch_failed", 15, result.message)
        : retryable(500, "dispatch_failed", result.message),
      extra: { eventId, lastAttempt: delivery.isLastAutomaticAttempt },
      routeId,
      delivery,
    };
  } finally {
    deps.inFlight.release(eventId);
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

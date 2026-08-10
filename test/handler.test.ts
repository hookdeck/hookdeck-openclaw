import { Readable } from "node:stream";
import { describe, expect, it, vi } from "vitest";

import { parseHookdeckConfig } from "../src/plugin/config-parse.js";
import type { HookdeckPluginConfig } from "../src/plugin/config-types.js";
import type {
  DispatchContext,
  DispatchOutcome,
  Dispatcher,
} from "../src/dispatch/types.js";
import { accepted, ok as okPlan, retryable } from "../src/protocol/outcome.js";
import {
  handleDelivery,
  writePlan,
  type HandlerDeps,
  type IncomingDelivery,
  type ResponseSink,
} from "../src/ingress/handler.js";
import { computeHookdeckSignature } from "../src/protocol/signature.js";
import { createInFlightRegistry } from "../src/store/in-flight.js";
import { createDeadLetterLog } from "../src/store/deadletter.js";
import { createMemoryLedger } from "../src/store/ledger.js";

const SECRET = "whsec_test";

function buildConfig(
  overrides: Record<string, unknown> = {},
): HookdeckPluginConfig {
  const parsed = parseHookdeckConfig({
    signingSecret: SECRET,
    routes: {
      stripe: {
        source: "stripe",
        dispatch: { mode: "wake", sessionKey: "main" },
      },
    },
    ...overrides,
  });
  if (!parsed.ok)
    throw new Error(`bad test config: ${JSON.stringify(parsed.problems)}`);
  return parsed.config;
}

interface HarnessOptions {
  config?: HookdeckPluginConfig;
  dispatch?: (ctx: DispatchContext) => Promise<DispatchOutcome>;
  secret?: string | undefined;
}

function harness(options: HarnessOptions = {}) {
  const config = options.config ?? buildConfig();
  const dispatch = vi.fn<(ctx: DispatchContext) => Promise<DispatchOutcome>>(
    options.dispatch ??
      (async () => ({ settle: "succeeded", plan: okPlan("dispatched") })),
  );
  const dispatcher: Dispatcher = { dispatch };
  const ledger = createMemoryLedger({
    ttlHours: config.dedupe.ttlHours,
    instanceId: "test",
  });
  const inFlight = createInFlightRegistry(config.maxConcurrent);
  const cancels: string[] = [];

  const deps: HandlerDeps = {
    config,
    ledger,
    inFlight,
    logger: { debug: () => {}, info: () => {}, warn: () => {} },
    dispatcherFor: () => dispatcher,
    onRetryCancel: (reason) => cancels.push(reason),
    resolveSigningSecret: async () =>
      options.secret === undefined && !("secret" in options)
        ? SECRET
        : options.secret,
  };

  return { config, deps, dispatch, ledger, inFlight, cancels };
}

interface RequestOptions {
  body?: string;
  method?: string;
  url?: string;
  contentType?: string | null;
  eventId?: string | null;
  attemptCount?: string | null;
  signature?: string | null;
  extraHeaders?: Record<string, string>;
}

function request(options: RequestOptions = {}): IncomingDelivery {
  const body = options.body ?? '{"type":"invoice.paid"}';
  const headers: Record<string, string | undefined> = {
    "content-type":
      options.contentType === null
        ? undefined
        : (options.contentType ?? "application/json"),
    "x-hookdeck-signature":
      options.signature === null
        ? undefined
        : (options.signature ??
          computeHookdeckSignature(Buffer.from(body, "utf8"), SECRET)),
    "x-hookdeck-eventid":
      options.eventId === null ? undefined : (options.eventId ?? "evt_1"),
    "x-hookdeck-attempt-count":
      options.attemptCount === null ? undefined : (options.attemptCount ?? "1"),
    "x-hookdeck-source-name": "stripe",
    ...options.extraHeaders,
  };
  for (const key of Object.keys(headers)) {
    if (headers[key] === undefined) delete headers[key];
  }

  return {
    method: options.method ?? "POST",
    url: options.url ?? "/hookdeck/stripe",
    headers,
    stream: Object.assign(Readable.from([Buffer.from(body, "utf8")]), {
      headers,
    }),
  };
}

describe("handleDelivery — happy path", () => {
  it("verifies, admits and dispatches", async () => {
    const { deps, dispatch, ledger } = harness();
    const result = await handleDelivery(deps, request());

    expect(result.plan.status).toBe(200);
    expect(result.plan.code).toBe("dispatched");
    expect(dispatch).toHaveBeenCalledOnce();
    expect(ledger.get("evt_1")?.status).toBe("succeeded");
  });

  it("passes the parsed payload to the dispatcher", async () => {
    const { deps, dispatch } = harness();
    await handleDelivery(deps, request({ body: '{"type":"charge.refunded"}' }));
    expect(dispatch.mock.calls[0]?.[0]).toMatchObject({
      routeId: "stripe",
      payload: { type: "charge.refunded" },
    });
  });
});

describe("handleDelivery — rejections before any work", () => {
  it("rejects a non-POST with 405", async () => {
    const { deps, dispatch } = harness();
    const result = await handleDelivery(deps, request({ method: "GET" }));
    expect(result.plan.status).toBe(405);
    expect(dispatch).not.toHaveBeenCalled();
  });

  it("rejects an unknown path with a RETRYABLE 404", async () => {
    // Not cancelled: adding or enabling the route makes a retry of this same
    // event succeed, so cancelling would discard recoverable traffic.
    const { deps, cancels } = harness();
    const result = await handleDelivery(
      deps,
      request({ url: "/hookdeck/nope" }),
    );
    expect(result.plan.status).toBe(404);
    expect(result.plan.retry).toEqual({ kind: "none" });
    expect(cancels).toEqual([]);
  });

  it("rejects a non-JSON content type with 415", async () => {
    const { deps } = harness();
    expect(
      (await handleDelivery(deps, request({ contentType: "text/plain" }))).plan
        .status,
    ).toBe(415);
  });

  it("accepts a +json content type", async () => {
    const { deps } = harness();
    expect(
      (
        await handleDelivery(
          deps,
          request({ contentType: "application/vnd.api+json" }),
        )
      ).plan.status,
    ).toBe(200);
  });

  it("rejects a bad signature with 401 and does NOT dispatch", async () => {
    const { deps, dispatch } = harness();
    const result = await handleDelivery(
      deps,
      request({ signature: "not-the-signature" }),
    );
    expect(result.plan.status).toBe(401);
    expect(dispatch).not.toHaveBeenCalled();
  });

  it("leaves a 401 retryable, so an in-flight secret rotation self-heals", async () => {
    const { deps } = harness();
    const result = await handleDelivery(deps, request({ signature: "wrong" }));
    expect(result.plan.retry).toEqual({ kind: "none" });
  });

  it("rejects a request with no Hookdeck signature header, retryably", async () => {
    // Setting the destination's auth to HOOKDECK_SIGNATURE makes Hookdeck sign
    // subsequent retries of this same event, so this is recoverable.
    const { deps, cancels } = harness();
    const result = await handleDelivery(deps, request({ signature: null }));
    expect(result.plan.status).toBe(400);
    expect(result.plan.code).toBe("not_hookdeck");
    expect(result.plan.retry).toEqual({ kind: "none" });
    expect(cancels).toEqual([]);
  });

  it("refuses a delivery with no identity, since it cannot be deduplicated", async () => {
    const { deps, dispatch, cancels } = harness();
    const result = await handleDelivery(deps, request({ eventId: null }));
    expect(result.plan.status).toBe(400);
    expect(result.plan.code).toBe("no_event_id");
    // Correcting headerPrefix makes a retry parse, so this is recoverable too.
    expect(cancels).toEqual([]);
    expect(dispatch).not.toHaveBeenCalled();
  });

  it("accepts a delivery on a sub-path, since Hookdeck forwards the source path", async () => {
    // path_forwarding_disabled defaults to false, so a provider posting to
    // <source-url>/events arrives at /hookdeck/stripe/events. Exact matching
    // would 404 perfectly good traffic.
    const { deps, dispatch } = harness();
    const result = await handleDelivery(
      deps,
      request({ url: "/hookdeck/stripe/events" }),
    );
    expect(result.plan.status).toBe(200);
    expect(dispatch).toHaveBeenCalledOnce();
  });

  it("does not let a route name prefix-match a longer sibling path", async () => {
    const { deps } = harness();
    const result = await handleDelivery(
      deps,
      request({ url: "/hookdeck/stripe-test" }),
    );
    expect(result.plan.status).toBe(404);
  });
});

describe("handleDelivery — signing secret", () => {
  it("returns a retryable 503 when no secret is configured, never a bypass", async () => {
    const { deps, dispatch } = harness({ secret: undefined });
    const result = await handleDelivery(deps, request());
    expect(result.plan.status).toBe(503);
    expect(result.plan.code).toBe("no_signing_secret");
    expect(dispatch).not.toHaveBeenCalled();
  });

  it("sends NO Retry-After for a missing secret, to protect the retry budget", async () => {
    // Retry-After overrides the connection's retry rule, so a fixed 30s here
    // would spend all 50 attempts in 25 minutes — long before anyone notices a
    // misconfigured secret. Exponential backoff spreads them across a week.
    const { deps } = harness({ secret: undefined });
    const result = await handleDelivery(deps, request());
    expect(result.plan.retry).toEqual({ kind: "none" });
  });

  it("never cancels retries for a missing secret — a config change fixes it", async () => {
    const { deps, cancels } = harness({ secret: undefined });
    await handleDelivery(deps, request());
    expect(cancels).toEqual([]);
  });
});

describe("handleDelivery — deduplication", () => {
  it("suppresses a repeat of the same attempt with 200", async () => {
    const { deps, dispatch } = harness();
    await handleDelivery(deps, request());
    const second = await handleDelivery(deps, request());

    expect(second.plan.status).toBe(200);
    expect(second.extra).toMatchObject({ duplicate: true });
    expect(dispatch).toHaveBeenCalledOnce();
  });

  it("ADMITS a redelivery with a higher attempt count", async () => {
    // The case that a naive event-id dedupe would break: Hookdeck retries a
    // failed event under the same id.
    const { deps, dispatch } = harness({
      dispatch: async () => ({
        settle: "failed" as const,
        plan: retryable(503, "dispatch_failed", "boom"),
      }),
    });
    const first = await handleDelivery(deps, request({ attemptCount: "1" }));
    expect(first.plan.status).toBe(503);

    const second = await handleDelivery(deps, request({ attemptCount: "2" }));
    expect(second.plan.status).toBe(503);
    expect(dispatch).toHaveBeenCalledTimes(2);
  });

  it("re-dispatches a succeeded event on a higher attempt", async () => {
    // Deliberate: the rule is attempt-based, so a manual retry of an event that
    // already succeeded runs again. A guard here would silently ignore an
    // operator who explicitly asked for the redelivery.
    const { deps, dispatch } = harness();
    await handleDelivery(deps, request({ attemptCount: "1" }));
    const second = await handleDelivery(deps, request({ attemptCount: "2" }));
    expect(second.plan.status).toBe(200);
    expect(dispatch).toHaveBeenCalledTimes(2);
  });

  it("treats separate event ids independently", async () => {
    const { deps, dispatch } = harness();
    await handleDelivery(deps, request({ eventId: "evt_1" }));
    await handleDelivery(deps, request({ eventId: "evt_2" }));
    expect(dispatch).toHaveBeenCalledTimes(2);
  });
});

describe("handleDelivery — admission control", () => {
  it("defers with 503 + Retry-After at capacity", async () => {
    const config = buildConfig({ maxConcurrent: 1, busyRetryAfterSeconds: 7 });
    const { deps } = harness({ config });

    // Occupy the only slot with a dispatch that never settles during the test.
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const slow = harness({
      config,
      dispatch: async () => {
        await blocked;
        return { settle: "succeeded" as const, plan: okPlan("dispatched") };
      },
    });
    // Share the registry so both handlers contend for the same capacity.
    slow.deps.inFlight = deps.inFlight;

    const inFlight = handleDelivery(
      slow.deps,
      request({ eventId: "evt_slow" }),
    );
    await vi.waitFor(() => expect(deps.inFlight.size).toBe(1));

    const deferred = await handleDelivery(
      deps,
      request({ eventId: "evt_other" }),
    );
    expect(deferred.plan.status).toBe(503);
    expect(deferred.plan.code).toBe("busy");
    expect(deferred.plan.retry).toEqual({ kind: "after", seconds: 7 });

    release();
    await inFlight;
  });

  it("records NOTHING in the ledger for a deferred event", async () => {
    // Load-bearing: a ledger row here would make Hookdeck's redelivery look
    // like a duplicate, and the event would vanish.
    const config = buildConfig({ maxConcurrent: 1 });
    const { deps, ledger } = harness({ config });

    let release!: () => void;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const slow = harness({
      config,
      dispatch: async () => {
        await blocked;
        return { settle: "succeeded" as const, plan: okPlan("dispatched") };
      },
    });
    slow.deps.inFlight = deps.inFlight;

    const inFlight = handleDelivery(
      slow.deps,
      request({ eventId: "evt_slow" }),
    );
    await vi.waitFor(() => expect(deps.inFlight.size).toBe(1));

    await handleDelivery(deps, request({ eventId: "evt_deferred" }));
    expect(ledger.get("evt_deferred")).toBeUndefined();

    release();
    await inFlight;
  });

  it("parks a concurrent duplicate with 503, not 2xx", async () => {
    // 2xx would retire the retry; if the in-flight attempt then failed the
    // event would be silently dropped.
    const { deps, inFlight } = harness();
    inFlight.acquire("evt_1");
    const result = await handleDelivery(deps, request({ eventId: "evt_1" }));
    expect(result.plan.status).toBe(503);
    expect(result.plan.code).toBe("in_flight");
  });

  it("releases capacity after a dispatch completes", async () => {
    const { deps, inFlight } = harness();
    await handleDelivery(deps, request());
    expect(inFlight.size).toBe(0);
  });

  it("releases capacity when dispatch throws", async () => {
    // The throw is turned into a retryable response rather than propagating,
    // so the caller always gets a plan and the slot is always released.
    const { deps, inFlight } = harness({
      dispatch: async () => {
        throw new Error("kaboom");
      },
    });
    const result = await handleDelivery(deps, request());
    expect(result.plan.status).toBe(503);
    expect(inFlight.size).toBe(0);
  });
});

describe("handleDelivery — payload and dispatch outcomes", () => {
  it("cancels retries on malformed JSON", async () => {
    const { deps, cancels } = harness();
    const result = await handleDelivery(deps, request({ body: "{not json" }));
    expect(result.plan.status).toBe(400);
    expect(result.plan.retry).toEqual({
      kind: "cancel",
      reason: "malformed_json",
    });
    expect(cancels).toEqual(["malformed_json"]);
  });

  describe("non-UTF-8 bodies", () => {
    function rawRequest(bytes: Buffer): IncomingDelivery {
      const headers: Record<string, string> = {
        "content-type": "application/json",
        "x-hookdeck-signature": computeHookdeckSignature(bytes, SECRET),
        "x-hookdeck-eventid": "evt_bytes",
        "x-hookdeck-attempt-count": "1",
      };
      return {
        method: "POST",
        url: "/hookdeck/stripe",
        headers,
        stream: Object.assign(Readable.from([bytes]), { headers }),
      };
    }

    it("rejects invalid UTF-8 inside a string rather than silently corrupting it", async () => {
      // Node's Buffer.toString('utf8') never throws — it substitutes U+FFFD, so
      // this parses "successfully" into mangled text. That text is destined for
      // a prompt, so accepting it is worse than rejecting it.
      const bytes = Buffer.from([
        0x7b, 0x22, 0x61, 0x22, 0x3a, 0x22, 0xff, 0xfe, 0x22, 0x7d,
      ]);
      expect(() => JSON.parse(bytes.toString("utf8"))).not.toThrow();

      const { deps, dispatch } = harness();
      const result = await handleDelivery(deps, rawRequest(bytes));

      expect(result.plan.status).toBe(400);
      expect(result.plan.code).toBe("malformed_json");
      expect(dispatch).not.toHaveBeenCalled();
    });

    it("rejects invalid UTF-8 outside a string too", async () => {
      const { deps } = harness();
      const result = await handleDelivery(
        deps,
        rawRequest(Buffer.from([0xff, 0xfe, 0x7b, 0x7d])),
      );
      expect(result.plan.status).toBe(400);
      expect(result.plan.code).toBe("malformed_json");
    });

    it("still accepts legitimate multi-byte UTF-8", async () => {
      const { deps, dispatch } = harness();
      const bytes = Buffer.from(
        JSON.stringify({ n: "café ✓ 日本語 🚀" }),
        "utf8",
      );
      const result = await handleDelivery(deps, rawRequest(bytes));
      expect(result.plan.status).toBe(200);
      expect(dispatch).toHaveBeenCalledOnce();
    });

    it("rejects a CESU-8 lone surrogate", async () => {
      // ed a0 80 is a lone surrogate in CESU-8. Node decodes it to replacement
      // characters and JSON.parse then SUCCEEDS, so only the round-trip check
      // catches it. Python instead parses this cleanly via `surrogatepass` and
      // explodes later at the network boundary — same root cause, different
      // blast radius, which is why each runtime needs its own fixture rather
      // than a shared assumption.
      const bytes = Buffer.from([
        0x7b, 0x22, 0x61, 0x22, 0x3a, 0x22, 0xed, 0xa0, 0x80, 0x22, 0x7d,
      ]);
      expect(() => JSON.parse(bytes.toString("utf8"))).not.toThrow();

      const { deps } = harness();
      const result = await handleDelivery(deps, rawRequest(bytes));
      expect(result.plan.status).toBe(400);
      expect(result.plan.code).toBe("malformed_json");
    });

    it.each([
      [
        "LE",
        Buffer.concat([
          Buffer.from([0xff, 0xfe]),
          Buffer.from('{"a":"ok"}', "utf16le"),
        ]),
      ],
      ["BE", Buffer.from([0xfe, 0xff, 0x00, 0x7b, 0x00, 0x7d])],
    ])(
      "rejects UTF-16 with a %s BOM, which RFC 8259 §8.1 forbids",
      async (_endian, bytes) => {
        const { deps } = harness();
        const result = await handleDelivery(deps, rawRequest(bytes));
        expect(result.plan.status).toBe(400);
        expect(result.plan.code).toBe("malformed_json");
      },
    );

    it("ACCEPTS an escaped lone surrogate, because that is valid JSON", async () => {
      // `"\ud800"` as an escape is ASCII on the wire, so the body is valid
      // UTF-8 and round-trips. RFC 8259 permits any \uXXXX escape including an
      // unpaired surrogate, so rejecting it would reject valid JSON.
      //
      // Documented rather than guarded because JS tolerates lone surrogates in
      // strings and substitutes U+FFFD when encoding, so the blast radius is a
      // mangled character — not the deferred UnicodeEncodeError Python gets.
      const bytes = Buffer.from(String.raw`{"a":"\ud800"}`, "utf8");
      const { deps, dispatch } = harness();
      const result = await handleDelivery(deps, rawRequest(bytes));
      expect(result.plan.status).toBe(200);
      expect(dispatch).toHaveBeenCalledOnce();
    });
  });

  it("returns a retryable 503 when dispatch fails transiently", async () => {
    const { deps, ledger } = harness({
      dispatch: async () => ({
        settle: "failed" as const,
        plan: retryable(503, "dispatch_failed", "queue unavailable"),
      }),
    });
    const result = await handleDelivery(deps, request());
    expect(result.plan.status).toBe(503);
    expect(ledger.get("evt_1")?.status).toBe("failed");
  });

  it("keeps the failure status on the last automatic attempt", async () => {
    // Do NOT flip to 2xx to keep the dashboard green — the failure is what
    // opens a Hookdeck Issue, and the Issue is the operator's alert.
    const { deps } = harness({
      dispatch: async () => ({
        settle: "failed" as const,
        plan: retryable(503, "dispatch_failed", "still broken"),
      }),
    });
    const result = await handleDelivery(
      deps,
      request({ extraHeaders: { "x-hookdeck-will-retry-after": "" } }),
    );
    expect(result.plan.status).toBe(503);
    expect(result.extra).toMatchObject({ lastAttempt: true });
  });

  it("reports a suppressed wake as success rather than retrying it", async () => {
    const { deps } = harness({
      dispatch: async () => ({
        settle: "succeeded",
        plan: okPlan("dispatched", "suppressed"),
      }),
    });
    const result = await handleDelivery(deps, request());
    expect(result.plan.status).toBe(200);
    expect(result.plan.message).toBe("suppressed");
  });

  it("does NOT settle the ledger when the dispatcher defers", async () => {
    // `deferred` means a background run owns the row. Settling here would tell
    // the next boot the work completed and leave a crash mid-run unrecovered.
    const { deps, ledger } = harness({
      dispatch: async () => ({
        settle: "deferred",
        plan: accepted("accepted"),
      }),
    });
    const result = await handleDelivery(deps, request());

    expect(result.plan.status).toBe(202);
    expect(ledger.get("evt_1")?.status).toBe("running");
    expect(ledger.listOrphans()).toHaveLength(0); // ours, not an orphan
  });
});

describe("handleDelivery — route filters", () => {
  function filtered(filters: unknown) {
    return buildConfig({
      routes: {
        stripe: {
          source: "stripe",
          dispatch: { mode: "wake", sessionKey: "main" },
          filters,
        },
      },
    });
  }

  it("drops a non-matching payload with 200, so Hookdeck retires the event", async () => {
    const { deps, dispatch } = harness({
      config: filtered([{ path: "type", equals: "invoice.paid" }]),
    });
    const result = await handleDelivery(
      deps,
      request({ body: '{"type":"charge.failed"}' }),
    );

    expect(result.plan.status).toBe(200);
    expect(result.plan.code).toBe("ignored");
    expect(result.extra).toMatchObject({ ignored: true });
    expect(dispatch).not.toHaveBeenCalled();
  });

  it("dispatches a matching payload", async () => {
    const { deps, dispatch } = harness({
      config: filtered([{ path: "type", equals: "invoice.paid" }]),
    });
    await handleDelivery(deps, request({ body: '{"type":"invoice.paid"}' }));
    expect(dispatch).toHaveBeenCalledOnce();
  });

  it("requires every filter to pass", async () => {
    const { deps, dispatch } = harness({
      config: filtered([
        { path: "type", equals: "invoice.paid" },
        { path: "livemode", equals: true },
      ]),
    });
    await handleDelivery(
      deps,
      request({ body: '{"type":"invoice.paid","livemode":false}' }),
    );
    expect(dispatch).not.toHaveBeenCalled();
  });

  it("does not write a ledger row for a filtered event", async () => {
    // A filtered drop is not work; recording it would make a later redelivery
    // of a payload we now DO want look like a duplicate.
    const { deps, ledger } = harness({
      config: filtered([{ path: "type", equals: "invoice.paid" }]),
    });
    await handleDelivery(deps, request({ body: '{"type":"charge.failed"}' }));
    expect(ledger.get("evt_1")).toBeUndefined();
  });
});

describe("writePlan", () => {
  function sink(): ResponseSink & {
    headers: Record<string, string>;
    body?: string;
  } {
    const headers: Record<string, string> = {};
    return {
      statusCode: 0,
      headers,
      setHeader(name, value) {
        headers[name] = value;
      },
      end(chunk) {
        this.body = chunk;
      },
    };
  }

  it("writes status, content type and body", async () => {
    const { deps } = harness();
    const handled = await handleDelivery(deps, request());
    const res = sink();
    writePlan(res, handled, { allowRetryCancel: false });

    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toBe("application/json; charset=utf-8");
    expect(JSON.parse(res.body!)).toMatchObject({
      ok: true,
      code: "dispatched",
    });
  });

  it("emits Retry-After for a deferral", async () => {
    const { deps, inFlight } = harness();
    inFlight.acquire("evt_1");
    const handled = await handleDelivery(deps, request({ eventId: "evt_1" }));
    const res = sink();
    writePlan(res, handled, { allowRetryCancel: false });
    expect(res.headers["retry-after"]).toBe("5");
  });

  it("omits Retry-After: -1 when the kill switch is off", async () => {
    const { deps } = harness();
    const handled = await handleDelivery(deps, request({ body: "{oops" }));
    const res = sink();
    writePlan(res, handled, { allowRetryCancel: false });
    expect(res.statusCode).toBe(400);
    expect(res.headers["retry-after"]).toBeUndefined();
  });

  it("emits Retry-After: -1 when the kill switch is on", async () => {
    const { deps } = harness();
    const handled = await handleDelivery(deps, request({ body: "{oops" }));
    const res = sink();
    writePlan(res, handled, { allowRetryCancel: true });
    expect(res.headers["retry-after"]).toBe("-1");
  });
});

describe("handleDelivery — deferral backs off once capacity is plainly not recovering", () => {
  /** The registry is sized from the config, so it must be built with it. */
  function saturated(overrides: Record<string, unknown> = {}) {
    const config = buildConfig({ maxConcurrent: 1, ...overrides });
    const h = harness({ config });
    h.inFlight.acquire("someone_else");
    return h;
  }

  it("sends a short Retry-After while the premise holds", async () => {
    const { deps, config } = saturated();
    const result = await handleDelivery(deps, request({ attemptCount: "1" }));
    expect(result.plan.code).toBe("busy");
    expect(result.plan.retry).toEqual({
      kind: "after",
      seconds: config.busyRetryAfterSeconds,
    });
  });

  it("drops the short interval after too many deferrals of the SAME event", async () => {
    // The attempt counter makes "capacity isn't recovering" observable rather
    // than guessed. Continuing at a fixed interval would spend the remaining
    // budget instead of letting exponential backoff stretch it.
    const { deps } = saturated({ deferAttemptLimit: 3 });
    const result = await handleDelivery(deps, request({ attemptCount: "9" }));
    expect(result.plan.code).toBe("busy");
    expect(result.plan.retry).toEqual({ kind: "none" });
  });

  it("still records nothing in the ledger for a deferred event", async () => {
    const { deps, ledger } = saturated({ deferAttemptLimit: 3 });
    await handleDelivery(deps, request({ attemptCount: "9" }));
    expect(ledger.get("evt_1")).toBeUndefined();
  });
});

describe("handleDelivery — dispatcher admission happens before the ledger write", () => {
  it("writes NO ledger row when the dispatcher is at capacity", async () => {
    // The agent dispatcher bounds background runs that outlive the request.
    // Refusing inside dispatch() would be too late: a `running` row would
    // already exist for work that never started, leaving an orphan for boot
    // recovery to re-queue.
    const { deps, ledger, dispatch } = harness();
    deps.dispatcherFor = () => ({ dispatch, canAccept: () => false });

    const result = await handleDelivery(deps, request());

    expect(result.plan.status).toBe(503);
    expect(result.plan.code).toBe("busy");
    expect(ledger.get("evt_1")).toBeUndefined();
    expect(dispatch).not.toHaveBeenCalled();
  });

  it("dispatches normally when the dispatcher has capacity", async () => {
    const { deps, dispatch } = harness();
    deps.dispatcherFor = () => ({ dispatch, canAccept: () => true });
    const result = await handleDelivery(deps, request());
    expect(result.plan.status).toBe(200);
    expect(dispatch).toHaveBeenCalledOnce();
  });

  it("treats a dispatcher without canAccept as always available", async () => {
    const { deps, dispatch } = harness();
    expect((await handleDelivery(deps, request())).plan.status).toBe(200);
    expect(dispatch).toHaveBeenCalledOnce();
  });
});

describe("white-label header prefix — the whole pipeline, not just the parser", () => {
  // A project can rename the `x-hookdeck` prefix. Every prefixed header moves
  // together, so getting this wrong does not fail loudly: signatures go
  // unverified-looking, dedupe silently stops, and last-attempt detection
  // never fires. The parser has unit tests; this asserts the pipeline honours
  // the config end to end.
  const PREFIXES = ["x-hookdeck", "x-acme", "x-events-gw", "X-Mixed-Case"];

  function prefixed(
    prefix: string,
    options: {
      body?: string;
      eventId?: string;
      attemptCount?: string;
      willRetryAfter?: string;
    } = {},
  ): IncomingDelivery {
    const p = prefix.toLowerCase();
    const body = options.body ?? '{"type":"invoice.paid"}';
    const headers: Record<string, string> = {
      "content-type": "application/json",
      [`${p}-signature`]: computeHookdeckSignature(
        Buffer.from(body, "utf8"),
        SECRET,
      ),
      [`${p}-eventid`]: options.eventId ?? "evt_wl",
      [`${p}-attempt-count`]: options.attemptCount ?? "1",
      [`${p}-source-name`]: "stripe",
      ...(options.willRetryAfter !== undefined
        ? { [`${p}-will-retry-after`]: options.willRetryAfter }
        : {}),
    };
    return {
      method: "POST",
      url: "/hookdeck/stripe",
      headers,
      stream: Object.assign(Readable.from([Buffer.from(body, "utf8")]), {
        headers,
      }),
    };
  }

  for (const prefix of PREFIXES) {
    describe(prefix, () => {
      const config = () => buildConfig({ headerPrefix: prefix });

      it("verifies and dispatches", async () => {
        const { deps, dispatch } = harness({ config: config() });
        const result = await handleDelivery(deps, prefixed(prefix));
        expect(result.plan.status).toBe(200);
        expect(dispatch).toHaveBeenCalledOnce();
      });

      it("still deduplicates", async () => {
        const { deps, dispatch } = harness({ config: config() });
        await handleDelivery(deps, prefixed(prefix));
        const second = await handleDelivery(deps, prefixed(prefix));
        expect(second.plan.code).toBe("duplicate");
        expect(dispatch).toHaveBeenCalledOnce();
      });

      it("still admits a genuine redelivery", async () => {
        const { deps, dispatch } = harness({ config: config() });
        await handleDelivery(deps, prefixed(prefix));
        await handleDelivery(deps, prefixed(prefix, { attemptCount: "2" }));
        expect(dispatch).toHaveBeenCalledTimes(2);
      });

      it("still detects the last automatic attempt", async () => {
        // Absent `…-will-retry-after` means Hookdeck will not retry again, and
        // is what triggers the local record. Under a custom prefix a hardcoded
        // header name is always absent, so every attempt would look final.
        const deadLetter = await createDeadLetterLog({ ttlHours: 168 });
        const { deps } = harness({
          config: config(),
          dispatch: async () => ({
            settle: "failed",
            plan: retryable(503, "downstream"),
          }),
        });
        deps.deadLetter = deadLetter;

        await handleDelivery(
          deps,
          prefixed(prefix, { eventId: "evt_a", willRetryAfter: "60" }),
        );
        expect(deadLetter.count()).toBe(0);

        await handleDelivery(deps, prefixed(prefix, { eventId: "evt_b" }));
        expect(deadLetter.list()[0]).toMatchObject({
          eventId: "evt_b",
          lastAttempt: true,
        });
      });
    });
  }

  it("rejects default-prefixed headers when a custom prefix is configured", async () => {
    // The misconfiguration must fail closed. `Idempotency-Key` is unprefixed
    // so identity survives, but the signature does not — and an unsigned
    // request is never admitted.
    const { deps, dispatch } = harness({
      config: buildConfig({ headerPrefix: "x-acme" }),
    });
    const result = await handleDelivery(deps, request());
    expect(result.plan.status).toBeGreaterThanOrEqual(400);
    expect(dispatch).not.toHaveBeenCalled();
  });
});

describe("secret rotation — the drill", () => {
  // Hookdeck's rotation slot puts the new signature in `…-signature-2` while
  // the old secret still signs `…-signature`. A verifier that checks only the
  // primary slot, or that caches the secret, fails every delivery for the
  // length of the rotation window. Nothing about that failure says "rotation".
  const OLD = "whsec_old";
  const NEW = "whsec_new";

  function signedWith(options: {
    primary?: string;
    rotation?: string;
    eventId?: string;
  }): IncomingDelivery {
    const body = '{"type":"invoice.paid"}';
    const bytes = Buffer.from(body, "utf8");
    const headers: Record<string, string> = {
      "content-type": "application/json",
      "x-hookdeck-eventid": options.eventId ?? "evt_rot",
      "x-hookdeck-attempt-count": "1",
      ...(options.primary !== undefined
        ? {
            "x-hookdeck-signature": computeHookdeckSignature(
              bytes,
              options.primary,
            ),
          }
        : {}),
      ...(options.rotation !== undefined
        ? {
            "x-hookdeck-signature-2": computeHookdeckSignature(
              bytes,
              options.rotation,
            ),
          }
        : {}),
    };
    return {
      method: "POST",
      url: "/hookdeck/stripe",
      headers,
      stream: Object.assign(Readable.from([bytes]), { headers }),
    };
  }

  it("accepts the rotation slot while the primary is still the old secret", async () => {
    const { deps, dispatch } = harness({ secret: NEW });
    const result = await handleDelivery(
      deps,
      signedWith({ primary: OLD, rotation: NEW }),
    );
    expect(result.plan.status).toBe(200);
    expect(dispatch).toHaveBeenCalledOnce();
  });

  it("accepts the primary slot before the rotation completes", async () => {
    const { deps } = harness({ secret: OLD });
    const result = await handleDelivery(
      deps,
      signedWith({ primary: OLD, rotation: NEW }),
    );
    expect(result.plan.status).toBe(200);
  });

  it("rejects when neither slot matches", async () => {
    const { deps, dispatch } = harness({ secret: "whsec_unrelated" });
    const result = await handleDelivery(
      deps,
      signedWith({ primary: OLD, rotation: NEW }),
    );
    expect(result.plan.status).toBe(401);
    expect(dispatch).not.toHaveBeenCalled();
  });

  it("picks up a rotated secret mid-flight, without a restart", async () => {
    // The secret is re-resolved per request rather than captured at start.
    // If it were cached, rotation would need a Gateway restart, and the
    // symptom would be a flood of 401s with no obvious cause.
    let current = OLD;
    const { deps, dispatch } = harness();
    deps.resolveSigningSecret = async () => current;

    const before = await handleDelivery(
      deps,
      signedWith({ primary: NEW, eventId: "evt_a" }),
    );
    expect(before.plan.status).toBe(401);

    current = NEW;
    const after = await handleDelivery(
      deps,
      signedWith({ primary: NEW, eventId: "evt_b" }),
    );
    expect(after.plan.status).toBe(200);
    expect(dispatch).toHaveBeenCalledOnce();
  });

  it("keeps the event alive when the secret cannot be resolved at all", async () => {
    // An absent secret is a failure, never a bypass — but it is also fixable
    // by a config change, so the event must survive in Hookdeck until it is.
    const { deps, dispatch } = harness({ secret: undefined });
    const result = await handleDelivery(deps, signedWith({ primary: OLD }));

    expect(result.plan.status).toBe(503);
    expect(result.plan.retry.kind).not.toBe("cancel");
    expect(dispatch).not.toHaveBeenCalled();
  });
});

describe("the dead-letter log is not reachable by unauthenticated traffic", () => {
  // The ingress is publicly reachable and the log is bounded, evicting
  // oldest-first. Recording pre-verification rejections would let a scanner
  // push out post-2xx agent failures, which for a CLI destination are the only
  // record that exists anywhere.
  async function withLog(config?: HookdeckPluginConfig) {
    const deadLetter = await createDeadLetterLog({ ttlHours: 168 });
    const h = harness(config === undefined ? {} : { config });
    h.deps.deadLetter = deadLetter;
    return { ...h, deadLetter };
  }

  it("records nothing for a wrong method", async () => {
    const { deps, deadLetter } = await withLog();
    await handleDelivery(deps, request({ method: "GET" }));
    expect(deadLetter.count()).toBe(0);
  });

  it("records nothing for a wrong content type", async () => {
    const { deps, deadLetter } = await withLog();
    await handleDelivery(deps, request({ contentType: "text/plain" }));
    expect(deadLetter.count()).toBe(0);
  });

  it("records nothing for a bad signature", async () => {
    const { deps, deadLetter } = await withLog();
    await handleDelivery(deps, request({ signature: "not-a-signature" }));
    expect(deadLetter.count()).toBe(0);
  });

  it("records nothing for a request that is not from Hookdeck at all", async () => {
    const { deps, deadLetter } = await withLog();
    await handleDelivery(deps, request({ signature: null }));
    expect(deadLetter.count()).toBe(0);
  });

  it("still records a verified request we cancel retries for", async () => {
    // The point of the log: past verification, a malformed payload is a real
    // failure worth keeping.
    const { deps, deadLetter } = await withLog();
    await handleDelivery(deps, request({ body: "{not json" }));
    expect(deadLetter.list()[0]).toMatchObject({ code: "malformed_json" });
  });
});

describe("a dispatcher that throws must not strand the ledger row", () => {
  it("settles the row failed and answers retryably", async () => {
    // Without this, the row stays `running` owned by a live instance: invisible
    // to listOrphans, counted in stats().running forever, and never
    // dead-lettered even on the final attempt.
    const { deps, ledger } = harness({
      dispatch: async () => {
        throw new Error("host went away");
      },
    });

    const result = await handleDelivery(deps, request());

    expect(result.plan.status).toBe(503);
    expect(result.plan.code).toBe("dispatch_error");
    expect(result.plan.retry.kind).not.toBe("cancel");
    expect(ledger.get("evt_1")?.status).toBe("failed");
    expect(ledger.stats().running).toBe(0);
  });

  it("dead-letters it on the final attempt, like any other failure", async () => {
    const deadLetter = await createDeadLetterLog({ ttlHours: 168 });
    const { deps } = harness({
      dispatch: async () => {
        throw new Error("host went away");
      },
    });
    deps.deadLetter = deadLetter;

    await handleDelivery(deps, request());
    expect(deadLetter.list()[0]).toMatchObject({
      code: "dispatch_error",
      lastAttempt: true,
    });
  });

  it("releases the in-flight slot", async () => {
    const { deps, inFlight } = harness({
      dispatch: async () => {
        throw new Error("boom");
      },
    });
    await handleDelivery(deps, request());
    expect(inFlight.size).toBe(0);
  });
});

describe("an unsigned attempt count cannot poison an event", () => {
  it("does not record an implausible attempt, so real redeliveries still run", async () => {
    // The HMAC covers only the body, so this header is attacker-reachable by
    // anyone who can replay a captured (body, signature) pair. Recording it
    // would retire every genuine redelivery of the event as a duplicate.
    const { deps, dispatch, ledger } = harness();

    await handleDelivery(deps, request({ attemptCount: "999999999" }));
    expect(ledger.get("evt_1")?.attempt).toBe(1);

    const real = await handleDelivery(deps, request({ attemptCount: "2" }));
    expect(real.plan.status).toBe(200);
    expect(dispatch).toHaveBeenCalledTimes(2);
  });
});

describe("form-encoded providers", () => {
  // Twilio and Slack post application/x-www-form-urlencoded. Rejecting it
  // permanently would put them out of reach of a plugin whose premise is "any
  // provider Hookdeck verifies".
  function formRequest(body: string, eventId = "evt_form"): IncomingDelivery {
    const bytes = Buffer.from(body, "utf8");
    const headers: Record<string, string> = {
      "content-type": "application/x-www-form-urlencoded",
      "x-hookdeck-signature": computeHookdeckSignature(bytes, SECRET),
      "x-hookdeck-eventid": eventId,
      "x-hookdeck-attempt-count": "1",
    };
    return {
      method: "POST",
      url: "/hookdeck/stripe",
      headers,
      stream: Object.assign(Readable.from([bytes]), { headers }),
    };
  }

  it("accepts and parses a form body", async () => {
    const { deps, dispatch } = harness();
    const result = await handleDelivery(
      deps,
      formRequest("MessageStatus=delivered&MessageSid=SM123"),
    );

    expect(result.plan.status).toBe(200);
    expect(dispatch.mock.calls[0]?.[0].payload).toEqual({
      MessageStatus: "delivered",
      MessageSid: "SM123",
    });
  });

  it("keeps repeated keys rather than losing all but one", async () => {
    const { deps, dispatch } = harness();
    await handleDelivery(deps, formRequest("tag=a&tag=b"));
    expect(dispatch.mock.calls[0]?.[0].payload).toEqual({ tag: ["a", "b"] });
  });

  it("verifies the signature over the raw form bytes", async () => {
    const { deps, dispatch } = harness();
    const bad = formRequest("a=1");
    bad.headers["x-hookdeck-signature"] = "wrong";
    const result = await handleDelivery(deps, bad);

    expect(result.plan.status).toBe(401);
    expect(dispatch).not.toHaveBeenCalled();
  });

  it("still rejects a content type that is neither", async () => {
    const { deps } = harness();
    const result = await handleDelivery(
      deps,
      request({ contentType: "text/xml" }),
    );
    expect(result.plan.status).toBe(415);
  });

  it("applies route filters to the parsed form fields", async () => {
    const config = buildConfig({
      routes: {
        stripe: {
          source: "stripe",
          dispatch: { mode: "wake", sessionKey: "main" },
          filters: [{ path: "MessageStatus", equals: "delivered" }],
        },
      },
    });
    const { deps, dispatch } = harness({ config });

    const ignored = await handleDelivery(
      deps,
      formRequest("MessageStatus=queued", "evt_a"),
    );
    expect(ignored.plan.code).toBe("ignored");

    await handleDelivery(deps, formRequest("MessageStatus=delivered", "evt_b"));
    expect(dispatch).toHaveBeenCalledOnce();
  });
});

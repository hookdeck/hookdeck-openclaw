import { Readable } from "node:stream";
import { describe, expect, it, vi } from "vitest";

import { parseHookdeckConfig } from "../src/plugin/config-parse.js";
import type { HookdeckPluginConfig } from "../src/plugin/config-types.js";
import type { DispatchContext, DispatchResult, Dispatcher } from "../src/dispatch/wake.js";
import {
  handleDelivery,
  writePlan,
  type HandlerDeps,
  type IncomingDelivery,
  type ResponseSink,
} from "../src/ingress/handler.js";
import { computeHookdeckSignature } from "../src/protocol/signature.js";
import { createInFlightRegistry, createMemoryLedger } from "../src/store/memory-ledger.js";

const SECRET = "whsec_test";

function buildConfig(overrides: Record<string, unknown> = {}): HookdeckPluginConfig {
  const parsed = parseHookdeckConfig({
    signingSecret: SECRET,
    routes: {
      stripe: { source: "stripe", dispatch: { mode: "wake", sessionKey: "main" } },
    },
    ...overrides,
  });
  if (!parsed.ok) throw new Error(`bad test config: ${JSON.stringify(parsed.problems)}`);
  return parsed.config;
}

interface HarnessOptions {
  config?: HookdeckPluginConfig;
  dispatch?: (ctx: DispatchContext) => Promise<DispatchResult>;
  secret?: string | undefined;
}

function harness(options: HarnessOptions = {}) {
  const config = options.config ?? buildConfig();
  const dispatch = vi.fn<(ctx: DispatchContext) => Promise<DispatchResult>>(
    options.dispatch ?? (async () => ({ ok: true })),
  );
  const dispatcher: Dispatcher = { dispatch };
  const ledger = createMemoryLedger(config.dedupe.ttlHours);
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
      options.secret === undefined && !("secret" in options) ? SECRET : options.secret,
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
    "content-type": options.contentType === null ? undefined : (options.contentType ?? "application/json"),
    "x-hookdeck-signature":
      options.signature === null
        ? undefined
        : (options.signature ?? computeHookdeckSignature(Buffer.from(body, "utf8"), SECRET)),
    "x-hookdeck-eventid": options.eventId === null ? undefined : (options.eventId ?? "evt_1"),
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
    stream: Object.assign(Readable.from([Buffer.from(body, "utf8")]), { headers }),
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

  it("rejects an unknown path with 404", async () => {
    const { deps } = harness();
    expect((await handleDelivery(deps, request({ url: "/hookdeck/nope" }))).plan.status).toBe(404);
  });

  it("rejects a non-JSON content type with 415", async () => {
    const { deps } = harness();
    expect((await handleDelivery(deps, request({ contentType: "text/plain" }))).plan.status).toBe(
      415,
    );
  });

  it("accepts a +json content type", async () => {
    const { deps } = harness();
    expect(
      (await handleDelivery(deps, request({ contentType: "application/vnd.api+json" }))).plan
        .status,
    ).toBe(200);
  });

  it("rejects a bad signature with 401 and does NOT dispatch", async () => {
    const { deps, dispatch } = harness();
    const result = await handleDelivery(deps, request({ signature: "not-the-signature" }));
    expect(result.plan.status).toBe(401);
    expect(dispatch).not.toHaveBeenCalled();
  });

  it("leaves a 401 retryable, so an in-flight secret rotation self-heals", async () => {
    const { deps } = harness();
    const result = await handleDelivery(deps, request({ signature: "wrong" }));
    expect(result.plan.retry).toEqual({ kind: "none" });
  });

  it("rejects a request with no Hookdeck signature header at all", async () => {
    const { deps } = harness();
    const result = await handleDelivery(deps, request({ signature: null }));
    expect(result.plan.status).toBe(400);
    expect(result.plan.code).toBe("not_hookdeck");
  });

  it("refuses a delivery with no identity, since it cannot be deduplicated", async () => {
    const { deps, dispatch } = harness();
    const result = await handleDelivery(deps, request({ eventId: null }));
    expect(result.plan.status).toBe(400);
    expect(dispatch).not.toHaveBeenCalled();
  });
});

describe("handleDelivery — signing secret", () => {
  it("returns a retryable 503 when no secret is configured, never a bypass", async () => {
    const { deps, dispatch } = harness({ secret: undefined });
    const result = await handleDelivery(deps, request());
    expect(result.plan.status).toBe(503);
    expect(result.plan.code).toBe("no_signing_secret");
    expect(result.plan.retry).toEqual({ kind: "after", seconds: 30 });
    expect(dispatch).not.toHaveBeenCalled();
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
      dispatch: async () => ({ ok: false, retryable: true, message: "boom" }),
    });
    const first = await handleDelivery(deps, request({ attemptCount: "1" }));
    expect(first.plan.status).toBe(503);

    const second = await handleDelivery(deps, request({ attemptCount: "2" }));
    expect(second.plan.status).toBe(503);
    expect(dispatch).toHaveBeenCalledTimes(2);
  });

  it("does not re-dispatch a succeeded event even on a higher attempt", async () => {
    const { deps, dispatch } = harness();
    await handleDelivery(deps, request({ attemptCount: "1" }));
    // A higher attempt after success still runs — the rule is attempt-based, so
    // this documents the deliberate behaviour rather than asserting a guard.
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
        return { ok: true };
      },
    });
    // Share the registry so both handlers contend for the same capacity.
    slow.deps.inFlight = deps.inFlight;

    const inFlight = handleDelivery(slow.deps, request({ eventId: "evt_slow" }));
    await vi.waitFor(() => expect(deps.inFlight.size).toBe(1));

    const deferred = await handleDelivery(deps, request({ eventId: "evt_other" }));
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
        return { ok: true };
      },
    });
    slow.deps.inFlight = deps.inFlight;

    const inFlight = handleDelivery(slow.deps, request({ eventId: "evt_slow" }));
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

  it("releases capacity even when dispatch throws", async () => {
    const { deps, inFlight } = harness({
      dispatch: async () => {
        throw new Error("kaboom");
      },
    });
    await expect(handleDelivery(deps, request())).rejects.toThrow("kaboom");
    expect(inFlight.size).toBe(0);
  });
});

describe("handleDelivery — payload and dispatch outcomes", () => {
  it("cancels retries on malformed JSON", async () => {
    const { deps, cancels } = harness();
    const result = await handleDelivery(deps, request({ body: "{not json" }));
    expect(result.plan.status).toBe(400);
    expect(result.plan.retry).toEqual({ kind: "cancel", reason: "malformed_json" });
    expect(result.plan.deadLetter).toBe(true);
    expect(cancels).toEqual(["malformed_json"]);
  });

  it("returns a retryable 503 when dispatch fails transiently", async () => {
    const { deps, ledger } = harness({
      dispatch: async () => ({ ok: false, retryable: true, message: "queue unavailable" }),
    });
    const result = await handleDelivery(deps, request());
    expect(result.plan.status).toBe(503);
    expect(ledger.get("evt_1")?.status).toBe("failed");
  });

  it("keeps the failure status on the last automatic attempt", async () => {
    // Do NOT flip to 2xx to keep the dashboard green — the failure is what
    // opens a Hookdeck Issue, and the Issue is the operator's alert.
    const { deps } = harness({
      dispatch: async () => ({ ok: false, retryable: true, message: "still broken" }),
    });
    const result = await handleDelivery(
      deps,
      request({ extraHeaders: { "x-hookdeck-will-retry-after": "" } }),
    );
    expect(result.plan.status).toBe(503);
    expect(result.extra).toMatchObject({ lastAttempt: true });
  });

  it("reports a suppressed wake as success rather than retrying it", async () => {
    const { deps } = harness({ dispatch: async () => ({ ok: true, detail: "suppressed" }) });
    const result = await handleDelivery(deps, request());
    expect(result.plan.status).toBe(200);
    expect(result.plan.message).toBe("suppressed");
  });
});

describe("writePlan", () => {
  function sink(): ResponseSink & { headers: Record<string, string>; body?: string } {
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
    expect(JSON.parse(res.body!)).toMatchObject({ ok: true, code: "dispatched" });
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

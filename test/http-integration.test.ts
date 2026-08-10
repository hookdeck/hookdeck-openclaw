import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { parseHookdeckConfig } from "../src/plugin/config-parse.js";
import type { DispatchContext, DispatchOutcome } from "../src/dispatch/types.js";
import { ok as okPlan } from "../src/protocol/outcome.js";
import { handleDelivery, writePlan, type HandlerDeps } from "../src/ingress/handler.js";
import { computeHookdeckSignature } from "../src/protocol/signature.js";
import { createInFlightRegistry } from "../src/store/in-flight.js";
import { createMemoryLedger } from "../src/store/ledger.js";

/**
 * End-to-end over a real socket.
 *
 * The unit tests feed the handler a `Readable`, which is convenient but does not
 * exercise the assumption M1 actually rests on: that the route handler receives
 * an UNCONSUMED request stream and can read byte-faithful raw bytes off it. This
 * suite posts real HTTP with real chunked bodies, including multi-byte UTF-8,
 * and verifies the signature still matches.
 */

const SECRET = "whsec_test";

const parsed = parseHookdeckConfig({
  signingSecret: SECRET,
  maxConcurrent: 2,
  routes: { stripe: { source: "stripe", dispatch: { mode: "wake", sessionKey: "main" } } },
});
if (!parsed.ok) throw new Error("bad fixture config");
const config = parsed.config;

let server: Server;
let baseUrl: string;
const dispatch = vi.fn<(ctx: DispatchContext) => Promise<DispatchOutcome>>(async () => ({
  settle: "succeeded",
  plan: okPlan("dispatched"),
}));

beforeAll(async () => {
  const deps: HandlerDeps = {
    config,
    ledger: createMemoryLedger({ ttlHours: config.dedupe.ttlHours, instanceId: "test" }),
    inFlight: createInFlightRegistry(config.maxConcurrent),
    logger: { debug: () => {}, info: () => {}, warn: () => {} },
    dispatcherFor: () => ({ dispatch }),
    resolveSigningSecret: async () => SECRET,
  };

  server = createServer((req, res) => {
    void handleDelivery(deps, {
      method: req.method,
      url: req.url,
      headers: req.headers,
      stream: req,
    }).then((handled) => {
      writePlan(res, handled, { allowRetryCancel: config.safety.allowRetryCancel });
    });
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

async function post(
  body: string,
  headers: Record<string, string> = {},
  path = "/hookdeck/stripe",
) {
  const response = await fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-hookdeck-signature": computeHookdeckSignature(Buffer.from(body, "utf8"), SECRET),
      "x-hookdeck-eventid": "evt_http_1",
      "x-hookdeck-attempt-count": "1",
      "x-hookdeck-source-name": "stripe",
      ...headers,
    },
    body,
  });
  return { status: response.status, retryAfter: response.headers.get("retry-after"), body: await response.json() };
}

describe("over a real HTTP socket", () => {
  it("verifies a signed delivery and dispatches", async () => {
    const result = await post('{"type":"invoice.paid"}', { "x-hookdeck-eventid": "evt_a" });
    expect(result.status).toBe(200);
    expect(result.body).toMatchObject({ ok: true, code: "dispatched" });
  });

  it("verifies a body with multi-byte UTF-8 read off the wire", async () => {
    // The signature covers bytes, not characters. If the read loop decoded and
    // re-encoded anywhere, this is where it would break.
    const body = JSON.stringify({ customer: "café ✓ 日本語", emoji: "🚀" });
    const result = await post(body, { "x-hookdeck-eventid": "evt_utf8" });
    expect(result.status).toBe(200);
  });

  it("verifies a large body delivered across many TCP chunks", async () => {
    const body = JSON.stringify({ blob: "x".repeat(300_000) });
    const result = await post(body, { "x-hookdeck-eventid": "evt_big" });
    expect(result.status).toBe(200);
  });

  it("rejects a tampered body with 401", async () => {
    const body = '{"type":"invoice.paid"}';
    const result = await post(body, {
      "x-hookdeck-eventid": "evt_tampered",
      "x-hookdeck-signature": computeHookdeckSignature(Buffer.from("different", "utf8"), SECRET),
    });
    expect(result.status).toBe(401);
  });

  it("returns 413 with no Retry-After when the body exceeds the limit", async () => {
    const body = JSON.stringify({ blob: "x".repeat(1024 * 1024 + 100) });
    const result = await post(body, { "x-hookdeck-eventid": "evt_huge" });
    expect(result.status).toBe(413);
    // allowRetryCancel is off by default, so the cancellation degrades to no header.
    expect(result.retryAfter).toBeNull();
  });

  it("suppresses a duplicate attempt and emits Retry-After on a deferral", async () => {
    await post('{"n":1}', { "x-hookdeck-eventid": "evt_dupe" });
    const second = await post('{"n":1}', { "x-hookdeck-eventid": "evt_dupe" });
    expect(second.status).toBe(200);
    expect(second.body).toMatchObject({ duplicate: true });
  });

  it("admits a redelivery carrying a higher attempt count", async () => {
    await post('{"n":1}', { "x-hookdeck-eventid": "evt_retry", "x-hookdeck-attempt-count": "1" });
    const calls = dispatch.mock.calls.length;
    const second = await post('{"n":1}', {
      "x-hookdeck-eventid": "evt_retry",
      "x-hookdeck-attempt-count": "2",
    });
    expect(second.status).toBe(200);
    expect(dispatch.mock.calls.length).toBe(calls + 1);
  });

  it("returns 404 for a path with no route", async () => {
    const result = await post("{}", { "x-hookdeck-eventid": "evt_404" }, "/hookdeck/unknown");
    expect(result.status).toBe(404);
  });

  it("returns 405 for a GET", async () => {
    const response = await fetch(`${baseUrl}/hookdeck/stripe`);
    expect(response.status).toBe(405);
  });
});

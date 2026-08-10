import { describe, expect, it, vi } from "vitest";
import type { HookdeckClient } from "../src/hookdeck/client.js";
import { parseHookdeckConfig } from "../src/plugin/config-parse.js";
import {
  doctorHandler,
  inspectEventHandler,
  pauseHandler,
  recentDeliveriesHandler,
  replayHandler,
  setupHandler,
  statusHandler,
  type ToolDeps,
} from "../src/tools/handlers.js";
import { createCursorStore } from "../src/store/cursor-store.js";
import { createDeadLetterLog } from "../src/store/deadletter.js";
import { createInFlightRegistry } from "../src/store/in-flight.js";
import { createMemoryLedger } from "../src/store/ledger.js";
import { RETRYABLE_STATUS_CODES } from "../src/protocol/outcome.js";
import { createFakeStoreIo } from "./fakes/fake-store-io.js";

const silent = { debug: () => {}, info: () => {}, warn: () => {} };

function fakeClient(overrides: Partial<HookdeckClient> = {}): HookdeckClient {
  return {
    retryEvent: vi.fn(async (eventId: string) => ({ ok: true as const, data: { eventId } })),
    upsertConnection: vi.fn(async () => ({ ok: true as const, data: { id: "web_1" } })),
    getConnection: vi.fn(async () => ({
      ok: true as const,
      data: { id: "web_1", rules: [{ type: "retry", response_status_codes: [...RETRYABLE_STATUS_CODES] }] },
    })),
    pauseConnection: vi.fn(async () => ({ ok: true as const, data: { id: "web_1" } })),
    unpauseConnection: vi.fn(async () => ({ ok: true as const, data: { id: "web_1" } })),
    bulkReplayRequests: vi.fn(async () => ({ ok: true as const, data: { id: "bulk_1" } })),
    listEvents: vi.fn(async () => ({ ok: true as const, data: [] })),
    getEvent: vi.fn(async () => ({ ok: true as const, data: { id: "evt_1", status: "FAILED", attempts: 3 } })),
    getEventBody: vi.fn(async () => ({ ok: true as const, data: {} })),
    listIssues: vi.fn(async () => ({ ok: true as const, data: [{ id: "iss_1" }] })),
    countIssues: vi.fn(async () => ({ ok: true as const, data: 1 })),
    ...overrides,
  };
}

async function deps(overrides: Partial<ToolDeps> = {}, cfgOverrides = {}): Promise<ToolDeps> {
  const parsed = parseHookdeckConfig({
    signingSecret: "whsec",
    apiKey: "key",
    routes: { stripe: { source: "stripe", dispatch: { mode: "wake", sessionKey: "main" } } },
    ...cfgOverrides,
  });
  if (!parsed.ok) throw new Error(JSON.stringify(parsed.problems));
  const io = createFakeStoreIo();
  return {
    config: parsed.config,
    ledger: createMemoryLedger({ ttlHours: 168, instanceId: "test" }),
    deadLetter: await createDeadLetterLog({ ttlHours: 168 }),
    cursors: await createCursorStore({ stateDir: "/state", io }),
    inFlight: createInFlightRegistry(4),
    logger: silent,
    client: fakeClient(),
    transportStatus: () => ({}),
    retryCancels: () => ({}),
    configWarnings: () => parsed.warnings,
    ...overrides,
  };
}

describe("hookdeck_status", () => {
  it("reports routes, capacity and ledger health in one call", async () => {
    const d = await deps();
    const result = await statusHandler(d, {});

    expect(result.routes[0]).toMatchObject({ routeId: "stripe", dispatch: "wake", enabled: true });
    expect(result.inFlight).toEqual({ current: 0, max: 4 });
    expect(result.ledger.persistence).toBe("off");
    expect(result.openIssues).toBe(1);
  });

  it("says persistence is disabled rather than implying a guarantee", async () => {
    // An agent asked "is everything healthy?" must be able to say no.
    const io = createFakeStoreIo({ failAfter: 0 });
    const d = await deps();
    const { createLedger } = await import("../src/store/ledger.js");
    d.ledger = await createLedger({ ttlHours: 168, instanceId: "t", stateDir: "/s", io });
    await d.ledger.begin("evt_1", 1);

    const result = await statusHandler(d, {});
    expect(result.ledger.persistence).toBe("disabled");
    expect(result.ledger.firstError).toBeTruthy();
  });

  it("works without an API key, reporting issues as unknown rather than failing", async () => {
    const d = await deps({ client: undefined });
    const result = await statusHandler(d, {});
    expect(result.openIssues).toBeNull();
    expect(result.routes).toHaveLength(1);
  });

  it("can be scoped to one route", async () => {
    const d = await deps({}, {
      routes: {
        a: { source: "a", dispatch: { mode: "wake", sessionKey: "m" } },
        b: { source: "b", dispatch: { mode: "wake", sessionKey: "m" } },
      },
    });
    expect((await statusHandler(d, { routeId: "b" })).routes).toHaveLength(1);
  });
});

describe("hookdeck_recent_deliveries", () => {
  it("joins the dead-letter log with the ledger", async () => {
    const d = await deps();
    await d.ledger.begin("evt_1", 2, { routeId: "stripe" });
    await d.ledger.settle("evt_1", "failed");
    await d.deadLetter.record({
      eventId: "evt_1",
      routeId: "stripe",
      code: "malformed_json",
      reason: "invalid JSON",
      retriesCancelled: true,
      lastAttempt: true,
    });

    const result = await recentDeliveriesHandler(d, {});
    expect(result.deadLetters[0]).toMatchObject({
      eventId: "evt_1",
      ourCode: "malformed_json",
      ledgerStatus: "failed",
      attempt: 2,
      retriesCancelled: true,
    });
  });

  it("explains an empty result rather than implying nothing happened", async () => {
    // Successful deliveries leave no local record by design, so "empty" is
    // ambiguous without saying so.
    const result = await recentDeliveriesHandler(await deps(), {});
    expect(result.deadLetters).toHaveLength(0);
    expect(result.note).toMatch(/leave no local record/i);
  });

  it("filters by route", async () => {
    const d = await deps();
    await d.deadLetter.record({
      eventId: "e1", routeId: "other", code: "x", reason: "y",
      retriesCancelled: false, lastAttempt: false,
    });
    expect((await recentDeliveriesHandler(d, { routeId: "stripe" })).deadLetters).toHaveLength(0);
  });

  it("filters before applying the limit, not after", async () => {
    // Limiting a page and then filtering it silently returns fewer rows than
    // the caller asked for.
    const d = await deps();
    for (let i = 0; i < 30; i += 1) {
      await d.deadLetter.record({
        eventId: `noise_${i}`, routeId: "other", code: "x", reason: "y",
        retriesCancelled: false, lastAttempt: false,
      });
    }
    for (let i = 0; i < 3; i += 1) {
      await d.deadLetter.record({
        eventId: `mine_${i}`, routeId: "stripe", code: "x", reason: "y",
        retriesCancelled: false, lastAttempt: false,
      });
    }
    const result = await recentDeliveriesHandler(d, { routeId: "stripe", limit: 20 });
    expect(result.deadLetters).toHaveLength(3);
  });
});

describe("hookdeck_inspect_event", () => {
  it("returns both our view and Hookdeck's", async () => {
    const d = await deps();
    await d.ledger.begin("evt_1", 1, { routeId: "stripe" });

    const result = await inspectEventHandler(d, { eventId: "evt_1" });
    expect(result.local.ledger).toMatchObject({ eventId: "evt_1", status: "running" });
    expect(result.hookdeck).toMatchObject({ status: "FAILED", attempts: 3 });
  });

  it("still returns the local view when Hookdeck lookup fails", async () => {
    const d = await deps({
      client: fakeClient({
        getEvent: vi.fn(async () => ({ ok: false as const, code: "not_found", message: "gone" })),
      }),
    });
    await d.ledger.begin("evt_1", 1);
    const result = await inspectEventHandler(d, { eventId: "evt_1" });
    expect(result.local.ledger).toBeTruthy();
    expect(result.note).toMatch(/lookup failed/i);
  });
});

describe("hookdeck_doctor", () => {
  it("passes a healthy setup", async () => {
    const d = await deps();
    await d.cursors.patch("stripe", { connectionId: "web_1" });
    const result = await doctorHandler(d);
    expect(result.ok).toBe(true);
  });

  it("catches a retry rule that no longer covers what we emit", async () => {
    // The check nothing else surfaces: events answered with an uncovered code
    // are never retried, and nothing records that a choice was made.
    const d = await deps({
      client: fakeClient({
        getConnection: vi.fn(async () => ({
          ok: true as const,
          data: { id: "web_1", rules: [{ type: "retry", response_status_codes: ["500-599"] }] },
        })),
      }),
    });
    await d.cursors.patch("stripe", { connectionId: "web_1" });

    const result = await doctorHandler(d);
    expect(result.ok).toBe(false);
    const check = result.checks.find((c) => c.name.includes("retry rule"));
    expect(check?.detail).toMatch(/does NOT cover/);
    expect(check?.detail).toContain("404");
  });

  it("flags a missing signing secret", async () => {
    const d = await deps({}, { signingSecret: undefined });
    const result = await doctorHandler(d);
    expect(result.checks.find((c) => c.name === "signing secret")?.ok).toBe(false);
  });

  it("flags interrupted work left by a previous process", async () => {
    // A real orphan: written by one instance, read by the next. The previous
    // version of this test mutated a row the ledger no longer hands out, so it
    // only ever asserted that a check existed.
    const io = createFakeStoreIo();
    const { createLedger } = await import("../src/store/ledger.js");
    const first = await createLedger({ ttlHours: 168, instanceId: "boot-1", stateDir: "/s", io });
    await first.begin("evt_crashed", 1, { routeId: "stripe" });
    await first.close();

    const d = await deps();
    d.ledger = await createLedger({ ttlHours: 168, instanceId: "boot-2", stateDir: "/s", io });

    const result = await doctorHandler(d);
    const check = result.checks.find((c) => c.name === "interrupted work");
    expect(check?.ok).toBe(false);
    expect(check?.detail).toContain("1 row");
  });

  it("reports a missing api key as a real limitation", async () => {
    const d = await deps({ client: undefined });
    const result = await doctorHandler(d);
    const check = result.checks.find((c) => c.name === "api key");
    expect(check?.ok).toBe(false);
    expect(check?.detail).toMatch(/crash recovery/);
  });
});

describe("hookdeck_setup", () => {
  it("summarises rather than dumping the spec, which carries auth objects", async () => {
    // `source.config.auth` and `destination.config.auth` hold provider
    // secrets. A dry run must not echo them into a model's context.
    const d = await deps();
    const result = await setupHandler(d, {});
    const serialised = JSON.stringify(result);
    expect(serialised).not.toContain("auth");
    expect(result.results?.[0]).toHaveProperty("summary");
  });

  it("defaults to a dry run", async () => {
    const d = await deps();
    const result = await setupHandler(d, {});
    expect(result.dryRun).toBe(true);
    expect(d.client!.upsertConnection).not.toHaveBeenCalled();
  });

  it("applies when explicitly asked", async () => {
    const d = await deps();
    const result = await setupHandler(d, { dryRun: false });
    expect(result.dryRun).toBe(false);
    expect(d.client!.upsertConnection).toHaveBeenCalledOnce();
    expect(d.cursors.get("stripe")?.connectionId).toBe("web_1");
  });

  it("explains itself without an API key rather than failing opaquely", async () => {
    const result = await setupHandler(await deps({ client: undefined }), {});
    expect(result.note).toMatch(/API key/i);
  });
});

describe("hookdeck_pause", () => {
  it("pauses and clamps auto-resume", async () => {
    // An agent that pauses and loses the thread must not stop the pipeline
    // forever.
    const d = await deps();
    await d.cursors.patch("stripe", { connectionId: "web_1" });
    const schedule = vi.fn();

    const result = await pauseHandler(
      d,
      { routeId: "stripe", paused: true, autoResumeAfterSeconds: 999_999 },
      schedule,
    );

    expect(result).toMatchObject({ ok: true, paused: true, autoResumeAfterSeconds: 3600 });
    expect(schedule).toHaveBeenCalledWith(expect.any(Function), 3600_000);
    expect(d.cursors.get("stripe")?.pausedByUs).toBe(true);
  });

  it("schedules an auto-resume even when none was requested", async () => {
    const d = await deps();
    await d.cursors.patch("stripe", { connectionId: "web_1" });
    const schedule = vi.fn();
    await pauseHandler(d, { routeId: "stripe", paused: true }, schedule);
    expect(schedule).toHaveBeenCalledOnce();
  });

  it("replaces a pending auto-resume rather than stacking timers", async () => {
    // Two timers means the older one can unpause a connection the agent has
    // just deliberately re-paused.
    const d = await deps();
    await d.cursors.patch("stripe", { connectionId: "web_1" });
    const cancels: string[] = [];
    const schedule = (_fn: () => void, _ms: number) => {
      const id = `t${cancels.length}`;
      return () => cancels.push(id);
    };

    await pauseHandler(d, { routeId: "stripe", paused: true }, schedule);
    await pauseHandler(d, { routeId: "stripe", paused: true }, schedule);
    expect(cancels).toEqual(["t0"]);

    await pauseHandler(d, { routeId: "stripe", paused: false });
    expect(cancels).toEqual(["t0", "t1"]);
  });

  it("resumes and clears the marker", async () => {
    const d = await deps();
    await d.cursors.patch("stripe", { connectionId: "web_1", pausedByUs: true });
    const result = await pauseHandler(d, { routeId: "stripe", paused: false });
    expect(result).toMatchObject({ ok: true, paused: false });
    expect(d.cursors.get("stripe")?.pausedByUs).toBe(false);
  });

  it("clears the marker when the pause call fails", async () => {
    const d = await deps({
      client: fakeClient({
        pauseConnection: vi.fn(async () => ({ ok: false as const, code: "e", message: "down" })),
      }),
    });
    await d.cursors.patch("stripe", { connectionId: "web_1" });
    await pauseHandler(d, { routeId: "stripe", paused: true });
    expect(d.cursors.get("stripe")?.pausedByUs).toBe(false);
  });

  it("explains when no connection id is known", async () => {
    const result = await pauseHandler(await deps(), { routeId: "stripe", paused: true });
    expect(result.ok).toBe(false);
    expect(result.note).toMatch(/connectionId|setup/i);
  });
});

describe("the ledger does not hand out mutable internal state", () => {
  it("returns a copy, so a tool handler cannot corrupt the ledger", async () => {
    const d = await deps();
    await d.ledger.begin("evt_1", 1);
    const row = d.ledger.get("evt_1")!;
    row.status = "succeeded";
    expect(d.ledger.get("evt_1")?.status).toBe("running");
  });
});

describe("hookdeck_replay", () => {
  it("retries explicit event ids", async () => {
    const d = await deps();
    const result = await replayHandler(d, { eventIds: ["evt_1", "evt_2"] });
    expect(result).toMatchObject({ ok: true, mode: "events" });
    expect(d.client!.retryEvent).toHaveBeenCalledTimes(2);
  });

  it("refuses a filtered replay without confirmation", async () => {
    // An unscoped retry-everything costs real money.
    const d = await deps();
    await d.cursors.patch("stripe", { connectionId: "web_1" });
    const result = await replayHandler(d, { routeId: "stripe", sinceMinutes: 60 });

    expect(result).toMatchObject({ ok: false, dryRun: true });
    expect(d.client!.bulkReplayRequests).not.toHaveBeenCalled();
  });

  it("executes a filtered replay once confirmed", async () => {
    const d = await deps();
    await d.cursors.patch("stripe", { connectionId: "web_1" });
    const result = await replayHandler(d, { routeId: "stripe", sinceMinutes: 60, confirm: true });

    expect(result).toMatchObject({ ok: true, mode: "bulk", batchId: "bulk_1" });
    expect(d.client!.bulkReplayRequests).toHaveBeenCalledOnce();
  });

  it("requires enough scope to act on", async () => {
    const result = await replayHandler(await deps(), {});
    expect(result.ok).toBe(false);
    expect(result.note).toMatch(/eventIds|sinceMinutes/);
  });

  it("caps explicit ids per call and SAYS what it dropped", async () => {
    // Truncating quietly would let a caller who passed 250 ids and saw "ok"
    // believe all 250 were retried.
    const d = await deps();
    const result = await replayHandler(d, {
      eventIds: Array.from({ length: 250 }, (_, i) => `evt_${i}`),
    });
    expect(d.client!.retryEvent).toHaveBeenCalledTimes(100);
    expect(result).toMatchObject({ dropped: 150 });
    expect(result.note).toMatch(/were not/i);
  });
});

describe("manifest contracts.tools", () => {
  it("lists exactly the tools the code can register", async () => {
    // The host refuses registerTool for any name absent from this contract, and
    // LOGS the refusal rather than throwing — so forgetting to update the
    // manifest produces a plugin that looks healthy with no tool surface at
    // all. That is precisely how this shipped broken the first time.
    const { ALL_TOOL_NAMES } = await import("../src/tools/index.js");
    const manifest = JSON.parse(
      await (await import("node:fs/promises")).readFile("openclaw.plugin.json", "utf8"),
    ) as { contracts?: { tools?: string[] } };

    expect(manifest.contracts?.tools?.slice().sort()).toEqual([...ALL_TOOL_NAMES].sort());
  });
});

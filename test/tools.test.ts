import { describe, expect, it, vi } from "vitest";
import type { HookdeckClient } from "../src/hookdeck/client.js";
import { parseHookdeckConfig } from "../src/plugin/config-parse.js";
import { recentDeliveriesHandler } from "../src/tools/deliveries.js";
import { type ToolDeps } from "../src/tools/deps.js";
import { doctorHandler } from "../src/tools/doctor.js";
import { inspectEventHandler } from "../src/tools/inspect.js";
import { issuesHandler } from "../src/tools/issues.js";
import { pauseHandler } from "../src/tools/pause.js";
import { replayHandler } from "../src/tools/replay.js";
import { setupHandler } from "../src/tools/setup.js";
import { statusHandler } from "../src/tools/status.js";
import { createCursorStore } from "../src/store/cursor-store.js";
import { createDeadLetterLog } from "../src/store/deadletter.js";
import { createInFlightRegistry } from "../src/store/in-flight.js";
import { createMemoryLedger } from "../src/store/ledger.js";
import { RETRYABLE_STATUS_CODES } from "../src/protocol/outcome.js";
import { createFakeStoreIo } from "./fakes/fake-store-io.js";

const silent = { debug: () => {}, info: () => {}, warn: () => {} };

function fakeClient(overrides: Partial<HookdeckClient> = {}): HookdeckClient {
  return {
    retryEvent: vi.fn(async (eventId: string) => ({
      ok: true as const,
      data: { eventId },
    })),
    upsertConnection: vi.fn(async () => ({
      ok: true as const,
      data: { id: "web_1" },
    })),
    getConnection: vi.fn(async () => ({
      ok: true as const,
      data: {
        id: "web_1",
        name: "hermes-livetest",
        rules: [
          { type: "retry", response_status_codes: [...RETRYABLE_STATUS_CODES] },
        ],
      },
    })),
    pauseConnection: vi.fn(async () => ({
      ok: true as const,
      data: { id: "web_1" },
    })),
    unpauseConnection: vi.fn(async () => ({
      ok: true as const,
      data: { id: "web_1" },
    })),
    bulkReplayRequests: vi.fn(async () => ({
      ok: true as const,
      data: { id: "bulk_1" },
    })),
    listEvents: vi.fn(async () => ({ ok: true as const, data: [] })),
    getEvent: vi.fn(async () => ({
      ok: true as const,
      // Shaped like the real API: headers hang off `data`, not off the event.
      data: {
        id: "evt_1",
        status: "FAILED",
        attempts: 3,
        data: {
          method: "POST",
          headers: { "content-type": "application/json" },
        },
      },
    })),
    // `GET /events/{id}/raw_body` answers {"body": "<text>"}; the client
    // unwraps it, so the fake returns what the client returns: the payload.
    getEventBody: vi.fn(async () => ({
      ok: true as const,
      data: '{"type":"invoice.paid"}',
    })),
    listIssues: vi.fn(async () => ({
      ok: true as const,
      data: [
        {
          id: "iss_1",
          type: "delivery",
          status: "OPENED",
          aggregation_keys: { webhook_id: ["web_1"], response_status: [503] },
        },
      ],
    })),
    getIssue: vi.fn(async (id: string) => ({
      ok: true as const,
      data: { id, status: "OPENED", type: "delivery" },
    })),
    updateIssue: vi.fn(async (id: string) => ({
      ok: true as const,
      data: { id },
    })),
    dismissIssue: vi.fn(async (id: string) => ({
      ok: true as const,
      data: { id },
    })),
    listAttempts: vi.fn(async () => ({
      ok: true as const,
      data: [
        {
          id: "atm_1",
          attempt_number: 1,
          status: "FAILED",
          response_status: 500,
        },
        {
          id: "atm_2",
          attempt_number: 2,
          status: "FAILED",
          response_status: null,
          error_code: "TIMEOUT",
        },
      ],
    })),
    countIssues: vi.fn(async () => ({ ok: true as const, data: 1 })),
    ...overrides,
  };
}

async function deps(
  overrides: Partial<ToolDeps> = {},
  cfgOverrides = {},
): Promise<ToolDeps> {
  const parsed = parseHookdeckConfig({
    signingSecret: "whsec",
    apiKey: "key",
    routes: {
      stripe: {
        source: "stripe",
        dispatch: { mode: "wake", sessionKey: "main" },
      },
    },
    ...cfgOverrides,
  });
  if (!parsed.ok) throw new Error(JSON.stringify(parsed.problems));
  const io = createFakeStoreIo();
  return {
    config: parsed.config,
    source: "live" as const,
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

    expect(result.routes[0]).toMatchObject({
      routeId: "stripe",
      dispatch: "wake",
      enabled: true,
    });
    expect(result.inFlight).toEqual({ current: 0, max: 4 });
    expect(result.ledger.persistence).toBe("off");
    expect(result.openIssues).toBe(1);
  });

  it("says persistence is disabled rather than implying a guarantee", async () => {
    // An agent asked "is everything healthy?" must be able to say no.
    const io = createFakeStoreIo({ failAfter: 0 });
    const d = await deps();
    const { createLedger } = await import("../src/store/ledger.js");
    d.ledger = await createLedger({
      ttlHours: 168,
      instanceId: "t",
      stateDir: "/s",
      io,
    });
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
    const d = await deps(
      {},
      {
        routes: {
          a: { source: "a", dispatch: { mode: "wake", sessionKey: "m" } },
          b: { source: "b", dispatch: { mode: "wake", sessionKey: "m" } },
        },
      },
    );
    expect((await statusHandler(d, { routeId: "b" })).routes).toHaveLength(1);
  });
});

describe("hookdeck_recent_deliveries", () => {
  it("leads with Hookdeck Issues, which are the actual dead-letter queue", async () => {
    const d = await deps();
    const result = await recentDeliveriesHandler(d, {});
    // The type must survive: "a delivery issue" and "a transformation issue"
    // send you to different places. This read `issue_type`, which the API does
    // not send, so every issue arrived as type null.
    expect(result.openIssues).toEqual([
      {
        id: "iss_1",
        type: "delivery",
        status: "OPENED",
        firstSeen: null,
        lastSeen: null,
        connections: [{ id: "web_1", name: "hermes-livetest" }],
        keys: { webhook_id: ["web_1"], response_status: [503] },
      },
    ]);
    expect(d.client!.listIssues).toHaveBeenCalledWith(
      expect.objectContaining({ status: "OPENED" }),
    );
  });

  it("separates failures Hookdeck cannot see from ones it can", async () => {
    // Post-acknowledgement failures are invisible to Hookdeck — it recorded a
    // successful delivery — so no Issue will ever cover them.
    const d = await deps();
    await d.deadLetter.record({
      eventId: "evt_pre",
      routeId: "stripe",
      code: "malformed_json",
      reason: "bad",
      retriesCancelled: true,
      lastAttempt: true,
      hookdeckVisible: true,
    });
    await d.deadLetter.record({
      eventId: "evt_post",
      routeId: "stripe",
      code: "agent_run_failed",
      reason: "died",
      retriesCancelled: false,
      lastAttempt: true,
      hookdeckVisible: false,
    });

    const result = await recentDeliveriesHandler(d, {});
    expect(result.unreportedFailures.map((r) => r.eventId)).toEqual([
      "evt_post",
    ]);
    expect(result.locallyRecorded.map((r) => r.eventId)).toEqual(["evt_pre"]);
  });

  it("says plainly when the real DLQ is unreachable", async () => {
    const d = await deps({ client: undefined });
    const result = await recentDeliveriesHandler(d, {});
    expect(result.openIssues).toBeNull();
    expect(String(result.note)).toMatch(/dead-letter queue/i);
  });

  it("joins the local record with the ledger", async () => {
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
      // A pre-acknowledgement rejection: we answered non-2xx, so Hookdeck
      // recorded it too and an Issue covers it.
      hookdeckVisible: true,
    });

    const result = await recentDeliveriesHandler(d, {});
    expect(result.locallyRecorded[0]).toMatchObject({
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
    const d = await deps({
      client: fakeClient({
        listIssues: vi.fn(async () => ({ ok: true as const, data: [] })),
      }),
    });
    const result = await recentDeliveriesHandler(d, {});
    expect(result.unreportedFailures).toHaveLength(0);
    expect(String(result.summary)).toMatch(/nothing has been given up on/i);
  });

  it("filters by route", async () => {
    const d = await deps();
    await d.deadLetter.record({
      eventId: "e1",
      routeId: "other",
      code: "x",
      reason: "y",
      retriesCancelled: false,
      lastAttempt: false,
    });
    expect(
      (await recentDeliveriesHandler(d, { routeId: "stripe" })).locallyRecorded,
    ).toHaveLength(0);
  });

  it("filters before applying the limit, not after", async () => {
    // Limiting a page and then filtering it silently returns fewer rows than
    // the caller asked for.
    const d = await deps();
    for (let i = 0; i < 30; i += 1) {
      await d.deadLetter.record({
        eventId: `noise_${i}`,
        routeId: "other",
        code: "x",
        reason: "y",
        retriesCancelled: false,
        lastAttempt: false,
      });
    }
    for (let i = 0; i < 3; i += 1) {
      await d.deadLetter.record({
        eventId: `mine_${i}`,
        routeId: "stripe",
        code: "x",
        reason: "y",
        retriesCancelled: false,
        lastAttempt: false,
      });
    }
    const result = await recentDeliveriesHandler(d, {
      routeId: "stripe",
      limit: 20,
    });
    expect(
      result.locallyRecorded.length + result.unreportedFailures.length,
    ).toBe(3);
  });
});

describe("hookdeck_inspect_event", () => {
  it("returns both our view and Hookdeck's", async () => {
    const d = await deps();
    await d.ledger.begin("evt_1", 1, { routeId: "stripe" });

    const result = await inspectEventHandler(d, { eventId: "evt_1" });
    expect(result.local.ledger).toMatchObject({
      eventId: "evt_1",
      status: "running",
    });
    expect(result.hookdeck).toMatchObject({
      status: "FAILED",
      attemptCount: 3,
    });
  });

  it("returns the attempt history, not just how many there were", async () => {
    // "Failed 3 times" and "failed with a 500 then a timeout" are different
    // answers, and only the second tells you what to do next.
    const d = await deps();
    const result = await inspectEventHandler(d, { eventId: "evt_1" });
    expect(result.hookdeck?.attempts).toEqual([
      {
        number: 1,
        status: "FAILED",
        responseStatus: 500,
        errorCode: null,
        trigger: null,
        at: null,
      },
      {
        number: 2,
        status: "FAILED",
        responseStatus: null,
        errorCode: "TIMEOUT",
        trigger: null,
        at: null,
      },
    ]);
  });

  it("still answers when the attempt history is unavailable", async () => {
    const d = await deps({
      client: fakeClient({
        listAttempts: vi.fn(async () => ({
          ok: false as const,
          code: "api_error",
          message: "boom",
        })),
      }),
    });
    const result = await inspectEventHandler(d, { eventId: "evt_1" });
    expect(result.hookdeck?.attempts).toBeNull();
    expect(String(result.hookdeck?.attemptsNote)).toMatch(/boom/);
  });

  it("still returns the local view when Hookdeck lookup fails", async () => {
    const d = await deps({
      client: fakeClient({
        getEvent: vi.fn(async () => ({
          ok: false as const,
          code: "not_found",
          message: "gone",
        })),
      }),
    });
    await d.ledger.begin("evt_1", 1);
    const result = await inspectEventHandler(d, { eventId: "evt_1" });
    expect(result.local.ledger).toBeTruthy();
    // A 404 is usually retention, not a typo. Saying so saves an agent several
    // tool calls spent re-checking an id that was never wrong.
    expect(String(result.note)).toMatch(/retention/i);
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
          data: {
            id: "web_1",
            rules: [{ type: "retry", response_status_codes: ["500-599"] }],
          },
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
    expect(result.checks.find((c) => c.name === "signing secret")?.ok).toBe(
      false,
    );
  });

  it("flags interrupted work left by a previous process", async () => {
    // A real orphan: written by one instance, read by the next. The previous
    // version of this test mutated a row the ledger no longer hands out, so it
    // only ever asserted that a check existed.
    const io = createFakeStoreIo();
    const { createLedger } = await import("../src/store/ledger.js");
    const first = await createLedger({
      ttlHours: 168,
      instanceId: "boot-1",
      stateDir: "/s",
      io,
    });
    await first.begin("evt_crashed", 1, { routeId: "stripe" });
    await first.close();

    const d = await deps();
    d.ledger = await createLedger({
      ttlHours: 168,
      instanceId: "boot-2",
      stateDir: "/s",
      io,
    });

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

    expect(result).toMatchObject({
      ok: true,
      paused: true,
      autoResumeAfterSeconds: 3600,
    });
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
    await d.cursors.patch("stripe", {
      connectionId: "web_1",
      pausedByUs: true,
    });
    const result = await pauseHandler(d, { routeId: "stripe", paused: false });
    expect(result).toMatchObject({ ok: true, paused: false });
    expect(d.cursors.get("stripe")?.pausedByUs).toBe(false);
  });

  it("clears the marker when the pause call fails", async () => {
    const d = await deps({
      client: fakeClient({
        pauseConnection: vi.fn(async () => ({
          ok: false as const,
          code: "e",
          message: "down",
        })),
      }),
    });
    await d.cursors.patch("stripe", { connectionId: "web_1" });
    await pauseHandler(d, { routeId: "stripe", paused: true });
    expect(d.cursors.get("stripe")?.pausedByUs).toBe(false);
  });

  it("explains when no connection id is known", async () => {
    const result = await pauseHandler(await deps(), {
      routeId: "stripe",
      paused: true,
    });
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
    const result = await replayHandler(d, {
      routeId: "stripe",
      sinceMinutes: 60,
    });

    expect(result).toMatchObject({ ok: false, dryRun: true });
    expect(d.client!.bulkReplayRequests).not.toHaveBeenCalled();
  });

  it("executes a filtered replay once confirmed", async () => {
    const d = await deps();
    await d.cursors.patch("stripe", { connectionId: "web_1" });
    const result = await replayHandler(d, {
      routeId: "stripe",
      sinceMinutes: 60,
      confirm: true,
    });

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
    // The host refuses registerTool for any name absent from this contract,
    // and LOGS the refusal rather than throwing, so a manifest left un-updated
    // produces a plugin that looks healthy with no tool surface at all.
    const { ALL_TOOL_NAMES } = await import("../src/tools/index.js");
    const manifest = JSON.parse(
      await (
        await import("node:fs/promises")
      ).readFile("openclaw.plugin.json", "utf8"),
    ) as { contracts?: { tools?: string[] } };

    expect(manifest.contracts?.tools?.slice().sort()).toEqual(
      [...ALL_TOOL_NAMES].sort(),
    );
  });
});

describe("a disk-backed view does not look like a degraded one", () => {
  it("reports persistence as active, not 'readonly'", async () => {
    // A real agent read `persistence: "readonly"` and concluded events were
    // "stuck with no automatic retry path". The Gateway was persisting fine;
    // only our handle was read-only. `source` carries that distinction.
    const io = createFakeStoreIo();
    const { createLedger } = await import("../src/store/ledger.js");
    const d = await deps({
      source: "disk",
      ledger: await createLedger({
        ttlHours: 168,
        instanceId: "reader",
        stateDir: "/s",
        io,
        readOnly: true,
      }),
    });

    const status = await statusHandler(d, {});
    expect(status.ledger.persistence).toBe("active");
    expect(status.source).toBe("disk");

    const doc = await doctorHandler(d);
    expect(
      doc.checks.find((c) => c.name === "ledger persistence")?.detail,
    ).toBe("active");
  });

  it("reports live-only fields as null rather than zero", async () => {
    // "0 in flight" from a disk view would be a lie; null is a gap.
    const d = await deps({
      source: "disk",
      inFlight: undefined,
      transportStatus: undefined,
    });
    const status = await statusHandler(d, {});
    expect(status.inFlight).toBeNull();
    expect(status.transport.listeners).toBeNull();
    expect(String(status.note)).toMatch(/state files/i);
  });
});

describe("we do not reimplement Hookdeck's dead-letter queue", () => {
  it("treats an unmarked local record as invisible to Hookdeck, not visible", async () => {
    // The safe default: never assume an Issue covers something. Claiming
    // Hookdeck has a record it does not is worse than showing it twice.
    const d = await deps();
    await d.deadLetter.record({
      eventId: "evt_x",
      routeId: "stripe",
      code: "whatever",
      reason: "y",
      retriesCancelled: false,
      lastAttempt: false,
    });
    const result = await recentDeliveriesHandler(d, {});
    expect(result.unreportedFailures.map((r) => r.eventId)).toContain("evt_x");
  });

  it("records an exhausted agent run as invisible to Hookdeck", async () => {
    // Hookdeck saw a 202 before the run failed, so no Issue will ever open.
    const d = await deps();
    await d.deadLetter.record({
      eventId: "evt_agent",
      routeId: "stripe",
      code: "agent_run_failed",
      reason: "exhausted",
      retriesCancelled: false,
      lastAttempt: true,
      hookdeckVisible: false,
    });
    const result = await recentDeliveriesHandler(d, {});
    expect(result.unreportedFailures[0]).toMatchObject({
      ourCode: "agent_run_failed",
    });
    expect(result.locallyRecorded).toHaveLength(0);
  });
});

describe("hookdeck_setup and provider verification", () => {
  const verified = {
    routes: {
      stripe: {
        source: "stripe",
        dispatch: { mode: "wake", sessionKey: "main" },
        verification: {
          provider: "STRIPE",
          credentials: { webhook_secret: "whsec_provider" },
        },
      },
    },
  };

  it("refuses to apply a verified route whose credentials it cannot resolve", async () => {
    // PUT /connections is an upsert. Applying a spec with no source auth block
    // would strip verification off a live source, and "applied: true" is the
    // last message anyone would read as a warning.
    const d = await deps(
      { resolveVerification: async () => undefined },
      verified,
    );
    const result = await setupHandler(d, { dryRun: false });
    const first = result.results?.[0] as
      { applied: boolean; error: string } | undefined;

    expect(first).toMatchObject({ applied: false });
    expect(String(first?.error)).toMatch(/no verification/i);
    expect(d.client!.upsertConnection).not.toHaveBeenCalled();
  });

  it("sends the source auth block when they do resolve", async () => {
    const d = await deps(
      {
        resolveVerification: async () => ({ webhook_secret: "whsec_provider" }),
      },
      verified,
    );
    await setupHandler(d, { dryRun: false });

    const spec = (d.client!.upsertConnection as ReturnType<typeof vi.fn>).mock
      .calls[0]![0] as { source: { config?: Record<string, unknown> } };
    expect(spec.source.config).toMatchObject({ auth_type: "STRIPE" });
  });

  it("does not echo the provider secret back to the model on a dry run", async () => {
    const d = await deps(
      {
        resolveVerification: async () => ({ webhook_secret: "whsec_provider" }),
      },
      verified,
    );
    const result = await setupHandler(d, { dryRun: true });
    expect(JSON.stringify(result)).not.toContain("whsec_provider");
  });
});

describe("hookdeck_issues — the dead-letter queue's lifecycle", () => {
  it("lists open issues by default, with a real total rather than the page size", async () => {
    const d = await deps();
    const result = await issuesHandler(d, {});
    expect(result.issues?.[0]).toMatchObject({ id: "iss_1", type: "delivery" });
    expect(result.total).toBe(1);
    expect(d.client!.listIssues).toHaveBeenCalledWith(
      expect.objectContaining({ status: "OPENED" }),
    );
  });

  it("says nothing has been given up on, rather than returning a bare empty list", async () => {
    const d = await deps({
      client: fakeClient({
        listIssues: vi.fn(async () => ({ ok: true as const, data: [] })),
      }),
    });
    const result = await issuesHandler(d, {});
    expect(String(result.summary)).toMatch(/not given up/i);
  });

  it("maps each verb onto the status the API accepts", async () => {
    for (const [action, status] of [
      ["acknowledge", "ACKNOWLEDGED"],
      ["resolve", "RESOLVED"],
      ["ignore", "IGNORED"],
    ] as const) {
      const d = await deps();
      await issuesHandler(d, { action, issueId: "iss_1" });
      expect(d.client!.updateIssue).toHaveBeenCalledWith("iss_1", status);
    }
  });

  it("says plainly that resolving replays nothing", async () => {
    // "Resolved" reads like "fixed". An agent that resolves without replaying
    // has tidied the dashboard and left the work undone.
    const d = await deps();
    const result = await issuesHandler(d, {
      action: "resolve",
      issueId: "iss_1",
    });
    expect(String(result.note)).toMatch(/no events were replayed/i);
    expect(String(result.note)).toMatch(/hookdeck_replay/);
  });

  it("makes dismiss a dry run until confirmed", async () => {
    const d = await deps();
    const result = await issuesHandler(d, {
      action: "dismiss",
      issueId: "iss_1",
    });
    expect(result.ok).toBe(false);
    expect(result.dryRun).toBe(true);
    expect(d.client!.dismissIssue).not.toHaveBeenCalled();

    const confirmed = await issuesHandler(d, {
      action: "dismiss",
      issueId: "iss_1",
      confirm: true,
    });
    expect(confirmed.ok).toBe(true);
    expect(d.client!.dismissIssue).toHaveBeenCalledWith("iss_1");
  });

  it("asks for an id rather than guessing one", async () => {
    const d = await deps();
    const result = await issuesHandler(d, { action: "resolve" });
    expect(result.ok).toBe(false);
    expect(String(result.note)).toMatch(/issueId/);
    expect(d.client!.updateIssue).not.toHaveBeenCalled();
  });

  it("clamps limit rather than passing an unbounded page size through", async () => {
    const d = await deps();
    await issuesHandler(d, { limit: 5000 });
    expect(d.client!.listIssues).toHaveBeenCalledWith(
      expect.objectContaining({ limit: 100 }),
    );
  });
});

describe("redaction — what reaches the model", () => {
  const SECRETS = {
    signingSecret: "whsec_super_secret_value",
    apiKey: "hk_live_do_not_leak_me",
  };

  it("keeps configured secrets out of every tool result", async () => {
    // A blanket assertion rather than one per tool: the next tool added gets
    // this coverage without anyone remembering to ask for it.
    const d = await deps({}, SECRETS);
    await d.cursors.patch("stripe", { connectionId: "web_1" });
    await d.deadLetter.record({
      eventId: "evt_1",
      routeId: "stripe",
      code: "malformed_json",
      reason: "invalid JSON",
      retriesCancelled: true,
      lastAttempt: true,
    });

    const results = await Promise.all([
      statusHandler(d, {}),
      doctorHandler(d),
      recentDeliveriesHandler(d, {}),
      inspectEventHandler(d, { eventId: "evt_1" }),
      issuesHandler(d, {}),
      setupHandler(d, { dryRun: true }),
      replayHandler(d, { routeId: "stripe", sinceMinutes: 10 }),
      pauseHandler(d, { routeId: "stripe", paused: true }, () => () => {}),
    ]);

    for (const result of results) {
      const text = JSON.stringify(result);
      expect(text).not.toContain(SECRETS.signingSecret);
      expect(text).not.toContain(SECRETS.apiKey);
    }
  });

  it("redacts signature and authorization headers on an inspected event", async () => {
    const d = await deps({
      client: fakeClient({
        getEvent: vi.fn(async () => ({
          ok: true as const,
          data: {
            id: "evt_1",
            // Headers live under `data`, NOT on the event. Reading
            // `event.headers` returned undefined and every inspected event
            // reported having no headers at all.
            data: {
              method: "POST",
              headers: {
                "x-hookdeck-signature": "aVeryLongSignatureValueHere==",
                authorization: "Bearer provider_token_value",
                "stripe-signature": "t=1,v1=deadbeefdeadbeef",
                "content-type": "application/json",
              },
            },
          },
        })),
      }),
    });

    const result = await inspectEventHandler(d, { eventId: "evt_1" });
    const headers = result.hookdeck?.headers as Record<string, string>;

    expect(headers["content-type"]).toBe("application/json");
    for (const name of [
      "x-hookdeck-signature",
      "authorization",
      "stripe-signature",
    ]) {
      expect(headers[name]).not.toContain("deadbeef");
      expect(headers[name]).not.toContain("provider_token_value");
      expect(headers[name]).not.toContain("SignatureValue");
    }
  });

  it("leaves the payload out unless asked, and labels it as data when included", async () => {
    const d = await deps();
    const without = await inspectEventHandler(d, { eventId: "evt_1" });
    expect(without).not.toHaveProperty("body");

    const withBody = await inspectEventHandler(d, {
      eventId: "evt_1",
      includeBody: true,
    });
    expect(withBody).toHaveProperty("body");
    expect(String((withBody as { bodyNote?: string }).bodyNote)).toMatch(
      /not an instruction/i,
    );
  });

  it("truncates a large payload rather than filling the context with it", async () => {
    const huge = "x".repeat(20_000);
    const d = await deps({
      client: fakeClient({
        getEventBody: vi.fn(async () => ({ ok: true as const, data: huge })),
      }),
    });
    const result = (await inspectEventHandler(d, {
      eventId: "evt_1",
      includeBody: true,
    })) as { body?: string; bodyTruncated?: number };

    expect(result.body!.length).toBe(4000);
    expect(result.bodyTruncated).toBe(20_000);
  });
});

describe("event shapes the API actually returns", () => {
  it("reads headers from event.data, where the API actually puts them", async () => {
    // `Event` has no `headers` property in the 2025-07-01 schema; the request
    // it describes lives under `data`. Fakes in this file are shaped to match
    // the API for that reason.
    const d = await deps();
    const result = await inspectEventHandler(d, { eventId: "evt_1" });
    expect(result.hookdeck?.headers).not.toBeNull();
    expect(result.hookdeck?.headers?.["content-type"]).toBe("application/json");
    expect(result.hookdeck?.method).toBe("POST");
  });

  it("reports null rather than an empty object when none are returned", async () => {
    const d = await deps({
      client: fakeClient({
        getEvent: vi.fn(async () => ({
          ok: true as const,
          data: { id: "evt_1" },
        })),
      }),
    });
    const result = await inspectEventHandler(d, { eventId: "evt_1" });
    expect(result.hookdeck?.headers).toBeNull();
  });

  it("parses headers that arrive as a JSON string", async () => {
    // The schema types this anyOf [string, object].
    const d = await deps({
      client: fakeClient({
        getEvent: vi.fn(async () => ({
          ok: true as const,
          data: {
            id: "evt_1",
            data: {
              headers:
                '{"content-type":"application/json","authorization":"Bearer abcdef123"}',
            },
          },
        })),
      }),
    });
    const result = await inspectEventHandler(d, { eventId: "evt_1" });
    expect(result.hookdeck?.headers?.["content-type"]).toBe("application/json");
    expect(result.hookdeck?.headers?.authorization).not.toContain("abcdef123");
  });

  it("returns the payload itself, not Hookdeck's {body: …} envelope", async () => {
    const d = await deps();
    const result = (await inspectEventHandler(d, {
      eventId: "evt_1",
      includeBody: true,
    })) as { body?: string };
    expect(result.body).toBe('{"type":"invoice.paid"}');
  });
});

describe("hookdeck_issues under allowMutations: false", () => {
  it("still lists, because seeing the dead-letter queue is diagnosis", async () => {
    const result = await issuesHandler(await deps(), {}, false);
    expect(result.ok).toBe(true);
    expect(result.issues).toHaveLength(1);
  });

  it("still inspects one issue", async () => {
    const result = await issuesHandler(
      await deps(),
      { action: "get", issueId: "iss_1" },
      false,
    );
    expect(result.ok).toBe(true);
  });

  it("refuses the mutating actions and says why", async () => {
    for (const action of [
      "acknowledge",
      "resolve",
      "ignore",
      "dismiss",
    ] as const) {
      const d = await deps();
      const result = await issuesHandler(
        d,
        { action, issueId: "iss_1", confirm: true },
        false,
      );
      expect(result.ok, action).toBe(false);
      expect(String(result.note)).toMatch(/allowMutations/);
      expect(d.client!.updateIssue).not.toHaveBeenCalled();
      expect(d.client!.dismissIssue).not.toHaveBeenCalled();
    }
  });
});

describe("issue counts stay honest under a type filter", () => {
  it("omits the project-wide total rather than reporting a mismatched one", async () => {
    // The count endpoint takes no type filter, so counting while listing a
    // filtered subset would read as "3 of 12 shown" when the twelve include
    // types the caller excluded.
    const d = await deps();
    const result = await issuesHandler(d, { type: "delivery" });
    expect(result.total).toBeUndefined();
    expect(String(result.totalNote)).toMatch(/no type\s+filter|takes no type/i);
    expect(d.client!.countIssues).not.toHaveBeenCalled();
  });

  it("reports the real total when nothing is filtered out", async () => {
    const d = await deps();
    const result = await issuesHandler(d, {});
    expect(result.total).toBe(1);
  });
});

describe("issues name the connection, not just its id", () => {
  it("resolves webhook_id to the name a person would use", async () => {
    // Issues carry only `webhook_id`, while people name connections. Without
    // the name, a model asked to act on a named connection has no key to match
    // on and will act on the wrong issue.
    const d = await deps();
    const result = await issuesHandler(d, {});
    expect(result.issues?.[0]?.connections).toEqual([
      { id: "web_1", name: "hermes-livetest" },
    ]);
  });

  it("looks each connection up once, however many issues share it", async () => {
    const d = await deps({
      client: fakeClient({
        listIssues: vi.fn(async () => ({
          ok: true as const,
          data: [
            { id: "iss_1", aggregation_keys: { webhook_id: ["web_1"] } },
            { id: "iss_2", aggregation_keys: { webhook_id: ["web_1"] } },
            { id: "iss_3", aggregation_keys: { webhook_id: ["web_1"] } },
          ],
        })),
      }),
    });
    await issuesHandler(d, {});
    expect(d.client!.getConnection).toHaveBeenCalledTimes(1);
  });

  it("still lists when a name lookup fails", async () => {
    const d = await deps({
      client: fakeClient({
        getConnection: vi.fn(async () => ({
          ok: false as const,
          code: "not_found",
          message: "gone",
        })),
      }),
    });
    const result = await issuesHandler(d, {});
    expect(result.ok).toBe(true);
    expect(result.issues?.[0]?.connections).toEqual([
      { id: "web_1", name: null },
    ]);
  });

  it("reports no connections rather than an empty name when the issue has none", async () => {
    const d = await deps({
      client: fakeClient({
        listIssues: vi.fn(async () => ({
          ok: true as const,
          data: [{ id: "iss_1", type: "backpressure" }],
        })),
      }),
    });
    const result = await issuesHandler(d, {});
    expect(result.issues?.[0]?.connections).toBeNull();
    expect(d.client!.getConnection).not.toHaveBeenCalled();
  });
});

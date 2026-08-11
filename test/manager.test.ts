import { describe, expect, it, vi } from "vitest";
import { buildCatchUpQuery, runCatchUp } from "../src/catchup.js";
import type { HookdeckClient } from "../src/hookdeck/client.js";
import { parseHookdeckConfig } from "../src/plugin/config-parse.js";
import type { HookdeckPluginConfig } from "../src/plugin/config-types.js";
import { createCursorStore } from "../src/store/cursor-store.js";
import { createTransportManager } from "../src/transport/manager.js";
import { createFakeStoreIo } from "./fakes/fake-store-io.js";

const silent = { debug: () => {}, info: () => {}, warn: () => {} };

function config(overrides: Record<string, unknown> = {}): HookdeckPluginConfig {
  const parsed = parseHookdeckConfig({
    signingSecret: "whsec",
    apiKey: "key",
    routes: {
      stripe: {
        source: "stripe",
        dispatch: { mode: "wake", sessionKey: "main" },
      },
    },
    ...overrides,
  });
  if (!parsed.ok) throw new Error(JSON.stringify(parsed.problems));
  return parsed.config;
}

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
      data: { id: "web_1" },
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
    getEvent: vi.fn(async () => ({ ok: true as const, data: { id: "evt_1" } })),
    getEventBody: vi.fn(async () => ({ ok: true as const, data: "{}" })),
    listIssues: vi.fn(async () => ({ ok: true as const, data: [] })),
    countIssues: vi.fn(async () => ({ ok: true as const, data: 0 })),
    listConnections: vi.fn(async () => ({
      ok: true as const,
      data: [{ id: "web_1", team_id: "tm_a" }],
    })),
    getIssue: vi.fn(async (id: string) => ({
      ok: true as const,
      data: { id },
    })),
    updateIssue: vi.fn(async (id: string) => ({
      ok: true as const,
      data: { id },
    })),
    dismissIssue: vi.fn(async (id: string) => ({
      ok: true as const,
      data: { id },
    })),
    listAttempts: vi.fn(async () => ({ ok: true as const, data: [] })),
    ...overrides,
  };
}

async function manager(
  cfg: HookdeckPluginConfig,
  client = fakeClient(),
  nowMs = 1_000_000,
) {
  const io = createFakeStoreIo();
  const cursors = await createCursorStore({ stateDir: "/state", io });
  const spawn = vi.fn(() => ({
    kill: () => {},
    onLine: () => {},
    onExit: () => {},
  }));
  const mgr = createTransportManager({
    config: cfg,
    cursors,
    logger: silent,
    client,
    spawn,
    resolveBinary: async () => ({
      path: "/usr/local/bin/hookdeck",
      all: ["/usr/local/bin/hookdeck"],
    }),
    readVersion: async () => "hookdeck version 2.4.0",
    now: () => nowMs,
  });
  return { mgr, cursors, client, spawn };
}

describe("provisioning", () => {
  it("does nothing unless enabled", async () => {
    const { mgr, client } = await manager(config());
    await mgr.start();
    expect(client.upsertConnection).not.toHaveBeenCalled();
  });

  it("upserts and records the connection id and fingerprint", async () => {
    const { mgr, cursors, client } = await manager(
      config({ provisioning: { enabled: true } }),
    );
    await mgr.start();

    expect(client.upsertConnection).toHaveBeenCalledOnce();
    const cursor = cursors.get("stripe");
    expect(cursor?.connectionId).toBe("web_1");
    expect(cursor?.provisioningFingerprint).toBeTruthy();
  });

  it("skips an unchanged upsert on the next start", async () => {
    const { mgr, client } = await manager(
      config({ provisioning: { enabled: true } }),
    );
    await mgr.start();
    await mgr.stop();
    await mgr.start();
    expect(client.upsertConnection).toHaveBeenCalledOnce();
  });

  it("re-upserts when forced", async () => {
    const { mgr, client } = await manager(
      config({ provisioning: { enabled: true, force: true } }),
    );
    await mgr.start();
    await mgr.stop();
    await mgr.start();
    expect(client.upsertConnection).toHaveBeenCalledTimes(2);
  });

  it("does not block startup when provisioning fails", async () => {
    // An operator may have provisioned by hand; a Gateway that will not boot is
    // worse than one that is not provisioned.
    const client = fakeClient({
      upsertConnection: vi.fn(async () => ({
        ok: false as const,
        status: 422,
        code: "api_error",
        message: "destination.config.auth is required",
      })),
    });
    const { mgr } = await manager(
      config({ provisioning: { enabled: true } }),
      client,
    );
    await expect(mgr.start()).resolves.toBeUndefined();
  });
});

describe("shutdown ordering", () => {
  it("pauses the connection before stopping the listener", async () => {
    // A clean CLI shutdown tombstones the session and forfeits the grace
    // window, so events arriving next are discarded rather than held.
    const { mgr, cursors, client } = await manager(
      config({ provisioning: { enabled: true } }),
    );
    await mgr.start();
    await mgr.stop();

    expect(client.pauseConnection).toHaveBeenCalledWith("web_1");
    expect(cursors.get("stripe")?.pausedByUs).toBe(true);
  });

  it("writes the pausedByUs breadcrumb BEFORE calling pause", async () => {
    // A crash between the two must still leave the marker that unpauses on the
    // next start, or the connection stays paused forever — a silent outage.
    let markedWhenCalled: boolean | undefined;
    const client = fakeClient();
    const { mgr, cursors } = await manager(
      config({ provisioning: { enabled: true } }),
      client,
    );
    await mgr.start();
    (client.pauseConnection as ReturnType<typeof vi.fn>).mockImplementation(
      async () => {
        markedWhenCalled = cursors.get("stripe")?.pausedByUs;
        return { ok: true as const, data: { id: "web_1" } };
      },
    );
    await mgr.stop();
    expect(markedWhenCalled).toBe(true);
  });

  it("clears the breadcrumb if the pause call fails", async () => {
    const client = fakeClient({
      pauseConnection: vi.fn(async () => ({
        ok: false as const,
        code: "network_error",
        message: "down",
      })),
    });
    const { mgr, cursors } = await manager(
      config({ provisioning: { enabled: true } }),
      client,
    );
    await mgr.start();
    await mgr.stop();
    expect(cursors.get("stripe")?.pausedByUs).toBe(false);
  });

  it("does not pause when the operator has turned it off", async () => {
    const { mgr, client } = await manager(
      config({ provisioning: { enabled: true }, pause: { onShutdown: false } }),
    );
    await mgr.start();
    await mgr.stop();
    expect(client.pauseConnection).not.toHaveBeenCalled();
  });

  it("unpauses on the next start, so a paused connection is never left stuck", async () => {
    const { mgr, cursors, client } = await manager(
      config({ provisioning: { enabled: true } }),
    );
    await mgr.start();
    await mgr.stop();
    await mgr.start();

    expect(client.unpauseConnection).toHaveBeenCalledWith("web_1");
    expect(cursors.get("stripe")?.pausedByUs).toBe(false);
  });
});

describe("CLI version gating", () => {
  const cliConfig = () =>
    config({ transport: { mode: "cli" }, provisioning: { enabled: true } });

  it("starts a listener per enabled route on a supported version", async () => {
    const { mgr, spawn } = await manager(cliConfig());
    await mgr.start();
    expect(spawn).toHaveBeenCalledOnce();
  });

  it("refuses to start on a version that silently stops delivering", async () => {
    const io = createFakeStoreIo();
    const cursors = await createCursorStore({ stateDir: "/state", io });
    const spawn = vi.fn(() => ({
      kill: () => {},
      onLine: () => {},
      onExit: () => {},
    }));
    const mgr = createTransportManager({
      config: cliConfig(),
      cursors,
      logger: silent,
      client: fakeClient(),
      spawn,
      resolveBinary: async () => ({ path: "hookdeck", all: ["hookdeck"] }),
      readVersion: async () => "hookdeck version 2.3.0-beta.1",
    });
    await mgr.start();
    // Ingress still serves; only the tunnel is withheld.
    expect(spawn).not.toHaveBeenCalled();
  });

  it("does not start a listener when the binary cannot be run", async () => {
    const io = createFakeStoreIo();
    const cursors = await createCursorStore({ stateDir: "/state", io });
    const spawn = vi.fn(() => ({
      kill: () => {},
      onLine: () => {},
      onExit: () => {},
    }));
    const mgr = createTransportManager({
      config: cliConfig(),
      cursors,
      logger: silent,
      client: fakeClient(),
      spawn,
      resolveBinary: async () => ({ path: "hookdeck", all: [] }),
      readVersion: async () => {
        throw new Error("ENOENT");
      },
    });
    await expect(mgr.start()).resolves.toBeUndefined();
    expect(spawn).not.toHaveBeenCalled();
  });
});

describe("catch-up", () => {
  it("builds a time-bounded query for requests nothing was listening for", () => {
    const query = buildCatchUpQuery({
      sinceMs: 1_700_000_000_000,
      sourceId: "src_1",
    });
    expect(query).toMatchObject({
      cli_events_count: 0,
      ignored_count: { gte: 1 },
      source_id: "src_1",
    });
    expect((query.ingested_at as { gte: string }).gte).toBe(
      "2023-11-14T22:13:20.000Z",
    );
  });

  it("skips a gap too small to be worth a bulk operation", async () => {
    const client = fakeClient();
    const result = await runCatchUp({
      client,
      logger: silent,
      connectionId: "web_1",
      sinceMs: 1_000,
      untilMs: 2_000,
      minGapMs: 30_000,
    });
    expect(result).toEqual({ ran: false, reason: "gap_too_small" });
    expect(client.bulkReplayRequests).not.toHaveBeenCalled();
  });

  it("targets the connection explicitly, since replay otherwise fans out", async () => {
    const client = fakeClient();
    await runCatchUp({
      client,
      logger: silent,
      connectionId: "web_1",
      sinceMs: 0,
      untilMs: 600_000,
    });
    expect(client.bulkReplayRequests).toHaveBeenCalledWith(
      expect.objectContaining({ target: { webhook_ids: ["web_1"] } }),
    );
  });

  it("reports a failure without throwing, so startup continues", async () => {
    const client = fakeClient({
      bulkReplayRequests: vi.fn(async () => ({
        ok: false as const,
        code: "api_error",
        message: "nope",
      })),
    });
    const result = await runCatchUp({
      client,
      logger: silent,
      connectionId: "web_1",
      sinceMs: 0,
      untilMs: 600_000,
    });
    expect(result).toMatchObject({ ran: false, reason: "failed" });
  });

  it("runs on start when a disconnect was recorded, then clears the cursor", async () => {
    const { mgr, cursors, client } = await manager(
      config({ provisioning: { enabled: true } }),
    );
    await mgr.start();
    await cursors.patch("stripe", { lastDisconnectAt: 1_000 });
    await mgr.stop();
    await mgr.start();

    expect(client.bulkReplayRequests).toHaveBeenCalledOnce();
    expect(cursors.get("stripe")?.lastDisconnectAt).toBeUndefined();
  });
});

describe("review regressions", () => {
  it("passes the CONFIGURED api key to the child, not an ambient env var", async () => {
    // Previously read process.env.HOOKDECK_API_KEY, so a configured secretRef
    // was ignored and whatever happened to be in the environment was used.
    process.env.HOOKDECK_API_KEY = "ambient_wrong_key";
    try {
      const io = createFakeStoreIo();
      const cursors = await createCursorStore({ stateDir: "/state", io });
      const spawn = vi.fn<
        (
          c: string,
          a: readonly string[],
          e: Record<string, string>,
        ) => {
          kill: () => void;
          onLine: () => void;
          onExit: () => void;
        }
      >(() => ({ kill: () => {}, onLine: () => {}, onExit: () => {} }));
      const mgr = createTransportManager({
        config: config({
          transport: { mode: "cli" },
          provisioning: { enabled: true },
        }),
        cursors,
        logger: silent,
        client: fakeClient(),
        apiKey: "configured_right_key",
        spawn,
        resolveBinary: async () => ({ path: "hookdeck", all: ["hookdeck"] }),
        readVersion: async () => "hookdeck version 2.4.0",
      });
      await mgr.start();

      const env = spawn.mock.calls[0]![2];
      expect(env.HOOKDECK_API_KEY).toBe("configured_right_key");
    } finally {
      delete process.env.HOOKDECK_API_KEY;
    }
  });

  it("adopts a configured connectionId, so pause works without provisioning", async () => {
    // pause-on-shutdown and catch-up both act on a connection id. Without
    // adoption they would be silently inert for anyone who provisions by
    // hand.
    const cfg = config({
      routes: {
        stripe: {
          source: "stripe",
          connectionId: "web_manual",
          dispatch: { mode: "wake", sessionKey: "main" },
        },
      },
    });
    const { mgr, cursors, client } = await manager(cfg);
    await mgr.start();
    expect(cursors.get("stripe")?.connectionId).toBe("web_manual");

    await mgr.stop();
    expect(client.pauseConnection).toHaveBeenCalledWith("web_manual");
  });

  it("clears the disconnect cursor outright rather than storing an undefined", async () => {
    const { mgr, cursors } = await manager(
      config({ provisioning: { enabled: true } }),
    );
    await mgr.start();
    await cursors.patch("stripe", { lastDisconnectAt: 1_000 });
    await mgr.stop();
    await mgr.start();

    const record = cursors.get("stripe")!;
    expect("lastDisconnectAt" in record).toBe(false);
  });
});

describe("the catch-up window marks the START of an outage", () => {
  it("keeps the earliest disconnect across a backoff loop", async () => {
    // The listener exits on every failed respawn. Overwriting the stamp each
    // time slides the window forward, so events from the original outage fall
    // outside every window that is ever queried.
    const cursors = await createCursorStore({
      stateDir: "/s",
      io: createFakeStoreIo(),
    });
    let clock = 1_000;
    const exits: (() => void)[] = [];

    const mgr = createTransportManager({
      config: config({ transport: { mode: "cli" } }),
      cursors,
      logger: silent,
      client: fakeClient(),
      spawn: () => ({
        kill: () => {},
        onLine: () => {},
        onExit: (cb: (code: number | null, signal: string | null) => void) => {
          exits.push(() => cb(1, null));
        },
      }),
      resolveBinary: async () => ({ path: "hookdeck", all: ["hookdeck"] }),
      readVersion: async () => "hookdeck version 2.4.0",
      now: () => clock,
    });

    await mgr.start();
    exits[0]?.();
    await Promise.resolve();
    expect(cursors.get("stripe")?.lastDisconnectAt).toBe(1_000);

    clock = 500_000;
    exits[0]?.();
    await Promise.resolve();
    expect(cursors.get("stripe")?.lastDisconnectAt).toBe(1_000);

    await mgr.stop();
  });

  it("stamps a fresh outage once the previous one is recovered", async () => {
    const cursors = await createCursorStore({
      stateDir: "/s",
      io: createFakeStoreIo(),
    });
    await cursors.patch("stripe", { lastDisconnectAt: 1_000 });
    await cursors.clear("stripe", "lastDisconnectAt");
    expect(cursors.get("stripe")?.lastDisconnectAt).toBeUndefined();
  });
});

describe("shutdown is bounded and scoped", () => {
  it("stops pausing once the budget is spent", async () => {
    // Pausing is a network call per route. Against an unreachable API the
    // per-call timeout alone would multiply by the route count while the
    // Gateway waits to exit.
    const cursors = await createCursorStore({
      stateDir: "/s",
      io: createFakeStoreIo(),
    });
    let clock = 0;
    const client = fakeClient({
      pauseConnection: vi.fn(async () => {
        clock += 4_000; // each call eats most of the budget
        return { ok: true as const, data: { id: "web_1" } };
      }),
    });

    const cfg = config({
      pause: { onShutdown: true, shutdownTimeoutMs: 5_000 },
      routes: {
        a: { source: "a", dispatch: { mode: "wake", sessionKey: "m" } },
        b: { source: "b", dispatch: { mode: "wake", sessionKey: "m" } },
        c: { source: "c", dispatch: { mode: "wake", sessionKey: "m" } },
      },
    });
    for (const id of ["a", "b", "c"]) {
      await cursors.patch(id, { connectionId: `web_${id}` });
    }

    const mgr = createTransportManager({
      config: cfg,
      cursors,
      logger: silent,
      client,
      spawn: () => ({ kill: () => {}, onLine: () => {}, onExit: () => {} }),
      resolveBinary: async () => ({ path: "hookdeck", all: ["hookdeck"] }),
      readVersion: async () => "hookdeck version 2.4.0",
      now: () => clock,
    });

    await mgr.start();
    await mgr.stop();

    expect(client.pauseConnection).toHaveBeenCalledTimes(2);
  });

  it("does not pause a route that is no longer configured", async () => {
    // Nothing would ever unpause it: the resume runs when a listener attaches,
    // and a removed route has no listener.
    const cursors = await createCursorStore({
      stateDir: "/s",
      io: createFakeStoreIo(),
    });
    await cursors.patch("stripe", { connectionId: "web_1" });
    await cursors.patch("removed", { connectionId: "web_old" });

    const client = fakeClient();
    const mgr = createTransportManager({
      config: config({ pause: { onShutdown: true, shutdownTimeoutMs: 5_000 } }),
      cursors,
      logger: silent,
      client,
      spawn: () => ({ kill: () => {}, onLine: () => {}, onExit: () => {} }),
      resolveBinary: async () => ({ path: "hookdeck", all: ["hookdeck"] }),
      readVersion: async () => "hookdeck version 2.4.0",
    });

    await mgr.start();
    await mgr.stop();

    expect(client.pauseConnection).toHaveBeenCalledTimes(1);
    expect(client.pauseConnection).toHaveBeenCalledWith("web_1");
  });
});

describe("recovery runs when a listener attaches", () => {
  // Under CLI transport this is the ONLY recovery path: an event delivered
  // with no session attached is discarded, so unpausing or replaying before
  // the tunnel is up sends the recovered traffic into nothing.
  async function withListener() {
    const cursors = await createCursorStore({
      stateDir: "/s",
      io: createFakeStoreIo(),
    });
    const lineCbs: ((line: string) => void)[] = [];
    const client = fakeClient();
    const mgr = createTransportManager({
      config: config({ transport: { mode: "cli" } }),
      cursors,
      logger: silent,
      client,
      // Exits when killed, as a real child does: `stop()` waits for it.
      spawn: () => {
        const exitCbs: ((
          code: number | null,
          signal: string | null,
        ) => void)[] = [];
        return {
          kill: () => exitCbs.forEach((cb) => cb(0, "SIGTERM")),
          onLine: (cb: (line: string) => void) => lineCbs.push(cb),
          onExit: (cb: (code: number | null, signal: string | null) => void) =>
            exitCbs.push(cb),
        };
      },
      resolveBinary: async () => ({ path: "hookdeck", all: ["hookdeck"] }),
      readVersion: async () => "hookdeck version 2.4.0",
      now: () => 1_000_000,
    });
    return {
      mgr,
      cursors,
      client,
      connect: () => lineCbs.forEach((cb) => cb("Ready! Forwarding")),
    };
  }

  it("does not replay before the tunnel is up", async () => {
    const { mgr, cursors, client } = await withListener();
    await cursors.patch("stripe", {
      connectionId: "web_1",
      lastDisconnectAt: 1,
    });

    await mgr.start();
    expect(client.bulkReplayRequests).not.toHaveBeenCalled();
    await mgr.stop();
  });

  it("replays once it is", async () => {
    const { mgr, cursors, client, connect } = await withListener();
    await cursors.patch("stripe", {
      connectionId: "web_1",
      lastDisconnectAt: 1,
    });

    await mgr.start();
    connect();
    await new Promise((r) => setTimeout(r, 0));

    expect(client.bulkReplayRequests).toHaveBeenCalledOnce();
    expect(cursors.get("stripe")?.lastDisconnectAt).toBeUndefined();
    await mgr.stop();
  });

  it("lifts a shutdown pause on connect", async () => {
    const { mgr, cursors, client, connect } = await withListener();
    await cursors.patch("stripe", {
      connectionId: "web_1",
      pausedByUs: true,
      pauseReason: "shutdown",
    });

    await mgr.start();
    connect();
    await new Promise((r) => setTimeout(r, 0));

    expect(client.unpauseConnection).toHaveBeenCalledWith("web_1");
    await mgr.stop();
  });

  it("leaves a deliberate pause alone", async () => {
    // An operator paused this for a diagnosed outage. A tunnel reconnecting is
    // not a reason to resume a pipeline someone stopped on purpose.
    const { mgr, cursors, client, connect } = await withListener();
    await cursors.patch("stripe", {
      connectionId: "web_1",
      pausedByUs: true,
      pauseReason: "operator",
    });

    await mgr.start();
    connect();
    await new Promise((r) => setTimeout(r, 0));

    expect(client.unpauseConnection).not.toHaveBeenCalled();
    await mgr.stop();
  });
});

describe("a deliberate pause survives a restart", () => {
  it("is not reclassified as a shutdown breadcrumb by stop()", async () => {
    // The whole point of the operator/shutdown distinction: stamping
    // `shutdown` over it would make the next connect resume a pipeline
    // someone stopped on purpose.
    const cursors = await createCursorStore({
      stateDir: "/s",
      io: createFakeStoreIo(),
    });
    await cursors.patch("stripe", {
      connectionId: "web_1",
      pausedByUs: true,
      pauseReason: "operator",
    });

    const client = fakeClient();
    const mgr = createTransportManager({
      config: config({ pause: { onShutdown: true, shutdownTimeoutMs: 5_000 } }),
      cursors,
      logger: silent,
      client,
      spawn: () => ({ kill: () => {}, onLine: () => {}, onExit: () => {} }),
      resolveBinary: async () => ({ path: "hookdeck", all: ["hookdeck"] }),
      readVersion: async () => "hookdeck version 2.4.0",
    });

    await mgr.start();
    await mgr.stop();

    expect(cursors.get("stripe")?.pauseReason).toBe("operator");
    // Already paused, so re-pausing it would only spend the shutdown budget.
    expect(client.pauseConnection).not.toHaveBeenCalled();
  });

  it("does not pause a disabled route, which nothing would ever resume", async () => {
    const cursors = await createCursorStore({
      stateDir: "/s",
      io: createFakeStoreIo(),
    });
    await cursors.patch("off", { connectionId: "web_off" });

    const client = fakeClient();
    const mgr = createTransportManager({
      config: config({
        pause: { onShutdown: true, shutdownTimeoutMs: 5_000 },
        routes: {
          off: {
            source: "off",
            enabled: false,
            dispatch: { mode: "wake", sessionKey: "m" },
          },
        },
      }),
      cursors,
      logger: silent,
      client,
      spawn: () => ({ kill: () => {}, onLine: () => {}, onExit: () => {} }),
      resolveBinary: async () => ({ path: "hookdeck", all: ["hookdeck"] }),
      readVersion: async () => "hookdeck version 2.4.0",
    });

    await mgr.start();
    await mgr.stop();

    expect(client.pauseConnection).not.toHaveBeenCalled();
  });
});

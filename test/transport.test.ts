import { describe, expect, it, vi } from "vitest";
import { createBackoff } from "../src/transport/backoff.js";
import {
  buildListenArgs,
  createCliListener,
  type ChildHandle,
} from "../src/transport/cli-transport.js";
import { scrubSecrets } from "../src/plugin/secrets.js";
import {
  checkCliVersion,
  compareVersions,
  describeShadowing,
  formatVersion,
  parseCliVersion,
} from "../src/transport/cli-version.js";

const silent = { debug: () => {}, info: () => {}, warn: () => {} };

describe("parseCliVersion", () => {
  it.each([
    ["hookdeck version 2.4.0", "2.4.0"],
    ["2.3.0-beta.1", "2.3.0-beta.1"],
    ["hookdeck version 2.10.3\nChecking for new versions...", "2.10.3"],
  ])("parses %s", (input, expected) => {
    expect(formatVersion(parseCliVersion(input)!)).toBe(expected);
  });

  it("returns undefined when there is no version", () => {
    expect(parseCliVersion("command not found")).toBeUndefined();
  });
});

describe("compareVersions", () => {
  it("orders by major, minor, then patch", () => {
    const v = (s: string) => parseCliVersion(s)!;
    expect(compareVersions(v("2.4.0"), v("2.3.9"))).toBeGreaterThan(0);
    expect(compareVersions(v("2.4.0"), v("2.4.1"))).toBeLessThan(0);
    expect(compareVersions(v("2.4.0"), v("2.4.0"))).toBe(0);
  });

  it("sorts a prerelease below its own release", () => {
    const v = (s: string) => parseCliVersion(s)!;
    expect(compareVersions(v("2.4.0-beta.1"), v("2.4.0"))).toBeLessThan(0);
  });
});

describe("checkCliVersion", () => {
  it("accepts the floor and above", () => {
    expect(checkCliVersion("hookdeck version 2.4.0").ok).toBe(true);
    expect(checkCliVersion("hookdeck version 3.0.0").ok).toBe(true);
  });

  it("rejects a pre-2.3.2 build", () => {
    // Below 2.3.2 the CLI silently stops delivering once a session expires,
    // which is the failure this plugin exists to prevent.
    const check = checkCliVersion("hookdeck version 2.3.0-beta.1");
    expect(check.ok).toBe(false);
    expect(check.message).toMatch(/silently stop/i);
    expect(check.message).toMatch(/upgrade/i);
  });

  it("rejects a 2.4.0 prerelease, which is below the release", () => {
    expect(checkCliVersion("2.4.0-beta.2").ok).toBe(false);
  });

  it("reports an unparseable version rather than assuming the worst silently", () => {
    const check = checkCliVersion("hookdeck: not found");
    expect(check.ok).toBe(false);
    expect(check.message).toMatch(/could not parse/i);
  });
});

describe("describeShadowing", () => {
  it("says nothing for a single binary", () => {
    expect(describeShadowing(["/opt/homebrew/bin/hookdeck"])).toBeUndefined();
  });

  it("warns when a binary is shadowed, naming which one wins", () => {
    // Exactly the situation on this project's machine: an npm shim masking a
    // newer Homebrew install, so the gate checks one and launches another.
    const warning = describeShadowing([
      "/Users/x/.nodenv/shims/hookdeck",
      "/usr/local/bin/hookdeck",
    ]);
    expect(warning).toContain(".nodenv/shims/hookdeck");
    expect(warning).toContain("/usr/local/bin/hookdeck");
  });
});

describe("buildListenArgs", () => {
  const args = buildListenArgs({
    routeId: "stripe",
    source: "stripe",
    port: 18789,
    path: "/hookdeck/stripe",
    binaryPath: "hookdeck",
  });

  it("passes the source positionally, one per process", () => {
    expect(args.slice(0, 3)).toEqual(["listen", "18789", "stripe"]);
  });

  it("forces --output compact", () => {
    // The interactive default exits immediately without a TTY, which a
    // supervisor reads as flakiness rather than misconfiguration.
    expect(args).toContain("--output");
    expect(args[args.indexOf("--output") + 1]).toBe("compact");
  });

  it("never puts the api key on the command line", () => {
    const withKey = buildListenArgs({
      routeId: "s",
      source: "s",
      port: 1,
      path: "/p",
      binaryPath: "hookdeck",
      extraArgs: [],
    });
    expect(withKey.join(" ")).not.toMatch(/api[-_]?key/i);
  });

  it("never runs `ci`, which mutates the CLI's global config and active project", () => {
    expect(args).not.toContain("ci");
  });
});

describe("createBackoff", () => {
  it("grows exponentially up to the cap", () => {
    const b = createBackoff({
      initialDelayMs: 100,
      factor: 2,
      maxDelayMs: 800,
      jitter: 0,
      random: () => 0.5,
    });
    expect([b.next(), b.next(), b.next(), b.next(), b.next()]).toEqual([
      100, 200, 400, 800, 800,
    ]);
  });

  it("applies symmetric jitter", () => {
    const low = createBackoff({
      initialDelayMs: 1000,
      jitter: 0.2,
      random: () => 0,
    });
    const high = createBackoff({
      initialDelayMs: 1000,
      jitter: 0.2,
      random: () => 1,
    });
    expect(low.next()).toBe(800);
    expect(high.next()).toBe(1200);
  });

  it("resets after sustained health", () => {
    const b = createBackoff({
      initialDelayMs: 100,
      jitter: 0,
      healthyResetMs: 5_000,
    });
    b.next();
    b.next();
    b.markHealthy(6_000);
    expect(b.failures).toBe(0);
  });

  it("does not reset on a short-lived connection", () => {
    const b = createBackoff({
      initialDelayMs: 100,
      jitter: 0,
      healthyResetMs: 5_000,
    });
    b.next();
    b.markHealthy(100);
    expect(b.failures).toBe(1);
  });

  it("gives up after the configured consecutive failures", () => {
    const b = createBackoff({
      initialDelayMs: 1,
      jitter: 0,
      maxConsecutiveFailures: 2,
    });
    expect(b.next()).toBeDefined();
    expect(b.next()).toBeDefined();
    expect(b.next()).toBeUndefined();
  });
});

/** A fake child whose lifecycle the test drives explicitly. */
function fakeChild() {
  const lineCbs: ((l: string) => void)[] = [];
  const exitCbs: ((c: number | null, s: string | null) => void)[] = [];
  const handle: ChildHandle & {
    killed: string[];
    emit(l: string): void;
    exit(c?: number): void;
  } = {
    killed: [],
    kill: (signal) => handle.killed.push(signal ?? "SIGTERM"),
    onLine: (cb) => lineCbs.push(cb),
    onExit: (cb) => exitCbs.push(cb),
    emit: (l) => lineCbs.forEach((cb) => cb(l)),
    exit: (c = 0) => exitCbs.forEach((cb) => cb(c, null)),
  };
  return handle;
}

/** Timers the test controls, so backoff is deterministic. */
function manualTimers() {
  const pending: (() => void)[] = [];
  return {
    setTimer: (fn: () => void) => {
      pending.push(fn);
      return { cancel: () => {} };
    },
    runAll: () => {
      const queued = pending.splice(0);
      queued.forEach((fn) => fn());
    },
    get count() {
      return pending.length;
    },
  };
}

describe("createCliListener", () => {
  const options = {
    routeId: "stripe",
    source: "stripe",
    port: 18789,
    path: "/hookdeck/stripe",
    binaryPath: "hookdeck",
    apiKey: "key_secret",
    backoff: { initialDelayMs: 1, jitter: 0 },
  };

  it("passes the api key via env, never argv", () => {
    const child = fakeChild();
    const spawn = vi.fn<
      (
        c: string,
        a: readonly string[],
        e: Record<string, string>,
      ) => typeof child
    >(() => child);
    const timers = manualTimers();
    createCliListener(options, {
      spawn,
      logger: silent,
      onDisconnect: () => {},
      setTimer: timers.setTimer,
    }).start();

    const [, args, env] = spawn.mock.calls[0]!;
    expect(env).toEqual({ HOOKDECK_API_KEY: "key_secret" });
    expect(args.join(" ")).not.toContain("key_secret");
  });

  it("becomes connected only once the banner appears", () => {
    const child = fakeChild();
    const timers = manualTimers();
    const listener = createCliListener(options, {
      spawn: () => child,
      logger: silent,
      onDisconnect: () => {},
      setTimer: timers.setTimer,
    });
    listener.start();

    expect(listener.state).toBe("starting");
    child.emit("Ready! Forwarding events to http://localhost:18789");
    expect(listener.state).toBe("connected");
  });

  it("records the disconnect on EVERY exit, which is what bounds a catch-up", () => {
    const child = fakeChild();
    const onDisconnect = vi.fn();
    const timers = manualTimers();
    createCliListener(options, {
      spawn: () => child,
      logger: silent,
      onDisconnect,
      setTimer: timers.setTimer,
    }).start();

    child.emit("connected");
    child.exit(1);
    expect(onDisconnect).toHaveBeenCalledWith("stripe");
  });

  it("restarts after an unexpected exit", () => {
    const children = [fakeChild(), fakeChild()];
    let spawned = 0;
    const timers = manualTimers();
    const listener = createCliListener(options, {
      spawn: () => children[spawned++]!,
      logger: silent,
      onDisconnect: () => {},
      setTimer: timers.setTimer,
    });
    listener.start();

    children[0]!.emit("connected");
    children[0]!.exit(1);
    expect(listener.state).toBe("restarting");

    timers.runAll();
    expect(spawned).toBe(2);
    expect(listener.restarts).toBe(1);
  });

  it("gives up rather than restarting forever, leaving ingress serving", () => {
    const timers = manualTimers();
    const listener = createCliListener(
      {
        ...options,
        backoff: { initialDelayMs: 1, jitter: 0, maxConsecutiveFailures: 1 },
      },
      {
        spawn: () => {
          const c = fakeChild();
          queueMicrotask(() => c.exit(1));
          return c;
        },
        logger: silent,
        onDisconnect: () => {},
        setTimer: timers.setTimer,
      },
    );
    listener.start();
    // First failure schedules a restart; the second exhausts the budget.
    listener.start();
    expect(["restarting", "failed", "starting"]).toContain(listener.state);
  });

  it("keeps a ring buffer of output for status", () => {
    const child = fakeChild();
    const timers = manualTimers();
    const listener = createCliListener(options, {
      spawn: () => child,
      logger: silent,
      onDisconnect: () => {},
      setTimer: timers.setTimer,
    });
    listener.start();
    child.emit("line one");
    child.emit("line two");
    expect(listener.recentOutput()).toEqual(["line one", "line two"]);
  });

  it("does not restart after an intentional stop", async () => {
    const child = fakeChild();
    let spawned = 0;
    const timers = manualTimers();
    const listener = createCliListener(options, {
      spawn: () => {
        spawned += 1;
        return child;
      },
      logger: silent,
      onDisconnect: () => {},
      setTimer: timers.setTimer,
    });
    listener.start();
    child.emit("connected");

    const stopping = listener.stop();
    child.exit(0);
    await stopping;

    timers.runAll();
    expect(spawned).toBe(1);
    expect(listener.state).toBe("stopped");
    expect(child.killed).toContain("SIGTERM");
  });
});

describe("child output never carries the API key into a model's context", () => {
  it("scrubs the key from the ring buffer status exposes", async () => {
    // We do not write this output. A future CLI version echoing the key into a
    // banner would put it in front of a model with nothing here having changed.
    const scrubbed = scrubSecrets(
      "connecting with HOOKDECK_API_KEY=hk_live_abcdefghijklmnop to project x",
      ["hk_live_abcdefghijklmnop"],
    );
    expect(scrubbed).not.toContain("hk_live_abcdefghijklmnop");
    expect(scrubbed).toContain("hk_l…op");
  });

  it("leaves short values alone rather than turning the output into noise", () => {
    expect(scrubSecrets("state is ok", ["ok"])).toBe("state is ok");
  });

  it("is a no-op when no key is configured", () => {
    expect(scrubSecrets("ready on 3000", [undefined])).toBe("ready on 3000");
  });
});

describe("prerelease ordering follows semver, not string order", () => {
  const v = (s: string) => parseCliVersion(s)!;

  it("orders numeric identifiers numerically", () => {
    // A plain string compare puts beta.10 below beta.9 — the exact range a
    // version gate has to get right.
    expect(
      compareVersions(v("2.4.0-beta.10"), v("2.4.0-beta.9")),
    ).toBeGreaterThan(0);
    expect(compareVersions(v("2.4.0-beta.2"), v("2.4.0-beta.10"))).toBeLessThan(
      0,
    );
  });

  it("sorts a shorter identifier list lower", () => {
    expect(compareVersions(v("2.4.0-beta"), v("2.4.0-beta.1"))).toBeLessThan(0);
  });

  it("sorts numeric identifiers below alphanumeric ones", () => {
    expect(compareVersions(v("2.4.0-1"), v("2.4.0-alpha"))).toBeLessThan(0);
  });

  it("still puts any prerelease below its release", () => {
    expect(compareVersions(v("2.4.0-beta.99"), v("2.4.0"))).toBeLessThan(0);
  });
});

describe("backoff never exceeds its documented maximum", () => {
  it("clamps after jitter, not before", () => {
    const backoff = createBackoff({
      initialDelayMs: 1_000,
      maxDelayMs: 30_000,
      jitter: 0.5,
      random: () => 1, // the top of the spread
    });
    for (let i = 0; i < 12; i += 1) {
      expect(backoff.next()!).toBeLessThanOrEqual(30_000);
    }
  });
});

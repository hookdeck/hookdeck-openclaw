import { EventEmitter } from "node:events";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The child-process adapter, tested against a fake `child_process.spawn`.
 *
 * Its whole job is turning Node's event surface into the two callbacks the
 * supervisor uses, and the supervisor restarts from exits alone — so an event
 * that never becomes an exit wedges it permanently.
 */

const spawnMock = vi.fn();
vi.mock("node:child_process", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:child_process")>()),
  spawn: (...args: unknown[]) => spawnMock(...args),
}));

const { nodeSpawnChild } = await import("../src/transport/node-spawn.js");

beforeEach(() => {
  spawnMock.mockClear();
});

function fakeChild() {
  const stdout = new EventEmitter() as EventEmitter & {
    setEncoding(e: string): void;
  };
  const stderr = new EventEmitter() as EventEmitter & {
    setEncoding(e: string): void;
  };
  stdout.setEncoding = () => {};
  stderr.setEncoding = () => {};
  const child = Object.assign(new EventEmitter(), {
    stdout,
    stderr,
    kill: vi.fn(),
  });
  spawnMock.mockReturnValue(child);
  return child;
}

describe("nodeSpawnChild — output", () => {
  it("emits complete lines from both streams", () => {
    const child = fakeChild();
    const lines: string[] = [];
    nodeSpawnChild("hookdeck", ["listen"], {}).onLine((l) => lines.push(l));

    child.stdout.emit("data", "first\nsec");
    child.stdout.emit("data", "ond\n");
    child.stderr.emit("data", "from stderr\n");

    expect(lines).toEqual(["first", "second", "from stderr"]);
  });

  it("flushes a final line the child never terminated", () => {
    // A process that dies mid-line still said something worth keeping, and it
    // is usually the reason it died.
    const child = fakeChild();
    const lines: string[] = [];
    nodeSpawnChild("hookdeck", [], {}).onLine((l) => lines.push(l));

    child.stdout.emit("data", "fatal: no such source");
    child.stdout.emit("end");

    expect(lines).toEqual(["fatal: no such source"]);
  });

  it("drops blank lines", () => {
    const child = fakeChild();
    const lines: string[] = [];
    nodeSpawnChild("hookdeck", [], {}).onLine((l) => lines.push(l));
    child.stdout.emit("data", "\n\nreal\n");
    expect(lines).toEqual(["real"]);
  });
});

describe("nodeSpawnChild — exits", () => {
  it("reports a spawn error as an exit", () => {
    // ENOENT and EACCES emit `error` with NO `exit`. The supervisor restarts
    // only from exits, so without this a missing binary leaves it waiting
    // forever with no restart and no disconnect recorded.
    const child = fakeChild();
    const exits: [number | null, string | null][] = [];
    const handle = nodeSpawnChild("hookdeck", [], {});
    handle.onExit((code, signal) => exits.push([code, signal]));

    child.emit("error", new Error("spawn hookdeck ENOENT"));

    expect(exits).toEqual([[null, null]]);
  });

  it("also surfaces the error as a line, for diagnosis", () => {
    const child = fakeChild();
    const lines: string[] = [];
    nodeSpawnChild("hookdeck", [], {}).onLine((l) => lines.push(l));
    child.emit("error", new Error("spawn hookdeck ENOENT"));
    expect(lines[0]).toContain("ENOENT");
  });

  it("reports an exit only once when error and exit both fire", () => {
    const child = fakeChild();
    const exits: unknown[] = [];
    nodeSpawnChild("hookdeck", [], {}).onExit((c, s) => exits.push([c, s]));

    child.emit("error", new Error("boom"));
    child.emit("exit", 1, null);

    expect(exits).toHaveLength(1);
  });

  it("passes the real exit code through", () => {
    const child = fakeChild();
    const exits: [number | null, string | null][] = [];
    nodeSpawnChild("hookdeck", [], {}).onExit((c, s) => exits.push([c, s]));
    child.emit("exit", 2, "SIGTERM");
    expect(exits).toEqual([[2, "SIGTERM"]]);
  });
});

describe("nodeSpawnChild — process control", () => {
  it("passes the API key via env, never argv", () => {
    fakeChild();
    nodeSpawnChild("hookdeck", ["listen", "3000"], {
      HOOKDECK_API_KEY: "hk_secret",
    });

    const [command, args, options] = spawnMock.mock.calls[0] as [
      string,
      string[],
      { env: Record<string, string> },
    ];
    expect(command).toBe("hookdeck");
    expect(args.join(" ")).not.toContain("hk_secret");
    expect(options.env.HOOKDECK_API_KEY).toBe("hk_secret");
  });

  it("survives killing a process that is already gone", () => {
    const child = fakeChild();
    child.kill.mockImplementation(() => {
      throw new Error("ESRCH");
    });
    expect(() => nodeSpawnChild("hookdeck", [], {}).kill()).not.toThrow();
  });
});

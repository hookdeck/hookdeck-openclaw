import { mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createFsStoreIo } from "../src/store/store-io.js";

/**
 * The real filesystem, deliberately.
 *
 * Every other store suite injects a fake whose writes are atomic by
 * construction, which is the right tool for testing the degradation rule but
 * cannot say anything about durability. This is the only place the actual
 * syscalls run.
 */

const dirs: string[] = [];

async function scratch(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "hookdeck-store-io-"));
  dirs.push(dir);
  return dir;
}

afterEach(async () => {
  const { rm } = await import("node:fs/promises");
  await Promise.all(
    dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })),
  );
});

describe("createFsStoreIo — reading", () => {
  it("reports a missing file as undefined rather than throwing", async () => {
    const io = createFsStoreIo();
    expect(
      await io.read(join(await scratch(), "absent.jsonl")),
    ).toBeUndefined();
  });

  it("propagates a real read failure", async () => {
    // A directory where a file is expected is a genuine problem, and must
    // reach the degradation path rather than looking like an empty store.
    const io = createFsStoreIo();
    const dir = await scratch();
    await expect(io.read(dir)).rejects.toThrow();
  });
});

describe("createFsStoreIo — appending", () => {
  it("creates the file and preserves order", async () => {
    const io = createFsStoreIo();
    const path = join(await scratch(), "ledger.jsonl");

    await io.append(path, "one");
    await io.append(path, "two");

    expect(await readFile(path, "utf8")).toBe("one\ntwo\n");
  });

  it("keeps the file private", async () => {
    // The ledger records event ids and route names; the dead-letter log records
    // failure reasons. Neither is world-readable.
    const { stat } = await import("node:fs/promises");
    const io = createFsStoreIo();
    const path = join(await scratch(), "ledger.jsonl");
    await io.append(path, "x");
    expect((await stat(path)).mode & 0o077).toBe(0);
  });

  it("leaves no temp files behind", async () => {
    const io = createFsStoreIo();
    const dir = await scratch();
    await io.append(join(dir, "ledger.jsonl"), "x");
    expect((await readdir(dir)).filter((f) => f.endsWith(".tmp"))).toEqual([]);
  });
});

describe("createFsStoreIo — atomic writes", () => {
  it("replaces the file completely", async () => {
    const io = createFsStoreIo();
    const path = join(await scratch(), "ledger.jsonl");
    await writeFile(path, "old contents that are much longer\n");

    await io.writeAtomic(path, "new\n");

    expect(await readFile(path, "utf8")).toBe("new\n");
  });

  it("removes its temp file", async () => {
    const io = createFsStoreIo();
    const dir = await scratch();
    await io.writeAtomic(join(dir, "ledger.jsonl"), "x\n");
    expect((await readdir(dir)).sort()).toEqual(["ledger.jsonl"]);
  });

  it("does not collide when two stores compact in the same millisecond", async () => {
    // The ledger, the dead-letter log and the cursors share one directory. A
    // temp name with only millisecond resolution can be opened twice at once,
    // renaming mixed contents over a live store.
    const io = createFsStoreIo();
    const dir = await scratch();

    await Promise.all([
      io.writeAtomic(join(dir, "ledger.jsonl"), "ledger\n"),
      io.writeAtomic(join(dir, "deadletter.jsonl"), "deadletter\n"),
      io.writeAtomic(join(dir, "cursors.jsonl"), "cursors\n"),
    ]);

    expect(await readFile(join(dir, "ledger.jsonl"), "utf8")).toBe("ledger\n");
    expect(await readFile(join(dir, "deadletter.jsonl"), "utf8")).toBe(
      "deadletter\n",
    );
    expect(await readFile(join(dir, "cursors.jsonl"), "utf8")).toBe(
      "cursors\n",
    );
    expect((await readdir(dir)).filter((f) => f.endsWith(".tmp"))).toEqual([]);
  });

  it("keeps the replacement private too", async () => {
    const { stat } = await import("node:fs/promises");
    const io = createFsStoreIo();
    const path = join(await scratch(), "ledger.jsonl");
    await io.writeAtomic(path, "x\n");
    expect((await stat(path)).mode & 0o077).toBe(0);
  });
});

describe("createFsStoreIo — directories", () => {
  it("creates a missing state directory", async () => {
    const io = createFsStoreIo();
    const path = join(await scratch(), "nested", "deeper");
    await io.ensureDir(path);
    expect(await readdir(path)).toEqual([]);
  });

  it("is idempotent", async () => {
    const io = createFsStoreIo();
    const path = join(await scratch(), "nested");
    await io.ensureDir(path);
    await expect(io.ensureDir(path)).resolves.not.toThrow();
  });
});

describe("createFsStoreIo — removal", () => {
  it("removes a file", async () => {
    const io = createFsStoreIo();
    const dir = await scratch();
    const path = join(dir, "ledger.jsonl");
    await io.append(path, "x");
    await io.remove(path);
    expect(await readdir(dir)).toEqual([]);
  });

  it("is a no-op on a file that is already gone", async () => {
    const io = createFsStoreIo();
    await expect(
      io.remove(join(await scratch(), "absent.jsonl")),
    ).resolves.not.toThrow();
  });
});

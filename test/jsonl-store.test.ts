import { describe, expect, it, vi } from "vitest";
import { createJsonlStore } from "../src/store/jsonl-store.js";
import { createFakeStoreIo } from "./fakes/fake-store-io.js";

interface Row {
  id: string;
  value: number;
  createdAt: number;
}

const PATH = "/state/test.jsonl";

function build(
  io: ReturnType<typeof createFakeStoreIo> | undefined,
  overrides: Partial<Parameters<typeof createJsonlStore<Row>>[0]> = {},
) {
  return createJsonlStore<Row>({
    ...(io !== undefined ? { path: PATH, io } : {}),
    keyOf: (r) => r.id,
    isLive: () => true,
    ...overrides,
  });
}

describe("createJsonlStore — persistence", () => {
  it("survives a reload", async () => {
    const io = createFakeStoreIo();
    const first = build(io);
    await first.load();
    await first.put({ id: "a", value: 1, createdAt: 0 });
    await first.put({ id: "b", value: 2, createdAt: 0 });

    const second = build(io);
    await second.load();
    expect(second.get("a")).toEqual({ id: "a", value: 1, createdAt: 0 });
    expect(second.values()).toHaveLength(2);
  });

  it("applies last-write-wins on reload", async () => {
    const io = createFakeStoreIo();
    const first = build(io);
    await first.load();
    await first.put({ id: "a", value: 1, createdAt: 0 });
    await first.put({ id: "a", value: 99, createdAt: 0 });

    const second = build(io);
    await second.load();
    expect(second.get("a")?.value).toBe(99);
  });

  it("honours deletes across a reload", async () => {
    const io = createFakeStoreIo();
    const first = build(io);
    await first.load();
    await first.put({ id: "a", value: 1, createdAt: 0 });
    await first.delete("a");

    const second = build(io);
    await second.load();
    expect(second.get("a")).toBeUndefined();
  });

  it("drops expired records on load rather than carrying them", async () => {
    const io = createFakeStoreIo();
    const first = build(io);
    await first.load();
    await first.put({ id: "old", value: 1, createdAt: 0 });
    await first.put({ id: "new", value: 2, createdAt: 10_000 });

    const second = build(io, {
      isLive: (r, now) => now - r.createdAt < 5_000,
      now: () => 10_000,
    });
    await second.load();
    expect(second.get("old")).toBeUndefined();
    expect(second.get("new")).toBeDefined();
  });

  it("skips a torn final line from a crash mid-append", async () => {
    // Refusing to load would turn a partial write into total data loss, which
    // is strictly worse than losing the one record that was being written.
    const io = createFakeStoreIo();
    const first = build(io);
    await first.load();
    await first.put({ id: "a", value: 1, createdAt: 0 });
    await first.put({ id: "b", value: 2, createdAt: 0 });
    io.tearLastLine(PATH);

    const second = build(io);
    await second.load();
    expect(second.get("a")).toBeDefined();
    expect(second.stats().persistence).toBe("active");
  });
});

describe("createJsonlStore — compaction", () => {
  it("compacts once appends outgrow live entries", async () => {
    const io = createFakeStoreIo();
    const store = build(io, { compactionRatio: 1 });
    await store.load();

    // Repeatedly rewrite the same few keys so the file grows while the live set
    // stays tiny — the case compaction exists for.
    for (let i = 0; i < 200; i += 1) {
      await store.put({ id: `k${i % 3}`, value: i, createdAt: 0 });
    }

    expect(store.stats().compactions).toBeGreaterThan(0);

    // The property that matters is boundedness, not an exact line count: the
    // file is append-only between compactions, so it legitimately holds the
    // compacted set plus whatever was appended since the last one. Asserting
    // exactly 3 would only pass if a compaction happened to land on the final
    // write.
    const lines = (io.files.get(PATH) ?? "")
      .split("\n")
      .filter((l) => l.length > 0);
    expect(lines.length).toBeLessThan(70);
    expect(store.values()).toHaveLength(3);
  });

  it("a compacted file reloads to the same live set", async () => {
    const io = createFakeStoreIo();
    const store = build(io, { compactionRatio: 1 });
    await store.load();
    for (let i = 0; i < 200; i += 1) {
      await store.put({ id: `k${i % 3}`, value: i, createdAt: 0 });
    }
    await store.close();

    const reloaded = build(io);
    await reloaded.load();
    expect(reloaded.values()).toHaveLength(3);
    expect(reloaded.get("k0")?.value).toBe(198);
  });

  it("compacts on close so the next boot loads a clean file", async () => {
    const io = createFakeStoreIo();
    const store = build(io);
    await store.load();
    await store.put({ id: "a", value: 1, createdAt: 0 });
    const before = io.atomicWrites;
    await store.close();
    expect(io.atomicWrites).toBe(before + 1);
  });
});

describe("createJsonlStore — degradation", () => {
  it("disables persistence permanently on the first failure", async () => {
    const io = createFakeStoreIo({ failAfter: 1 });
    const store = build(io);
    await store.load();

    await store.put({ id: "a", value: 1, createdAt: 0 });
    expect(store.stats().persistence).toBe("active");

    await store.put({ id: "b", value: 2, createdAt: 0 });
    expect(store.stats().persistence).toBe("disabled");
    expect(store.stats().firstError).toMatch(/simulated/);
  });

  it("keeps serving from memory after degrading", async () => {
    const io = createFakeStoreIo({ failAfter: 0 });
    const store = build(io);
    await store.load();
    await store.put({ id: "a", value: 1, createdAt: 0 });

    // The write failed, but the record is still authoritative in memory —
    // exactly-once within the process is preserved.
    expect(store.get("a")?.value).toBe(1);
    expect(store.stats().persistence).toBe("disabled");
  });

  it("never throws out of put(), whatever the disk does", async () => {
    const io = createFakeStoreIo({ failAfter: 0 });
    const store = build(io);
    await store.load();
    await expect(
      store.put({ id: "a", value: 1, createdAt: 0 }),
    ).resolves.toBeUndefined();
  });

  it("calls onDegrade exactly once across many failures", async () => {
    const onDegrade = vi.fn();
    const io = createFakeStoreIo({ failAfter: 0 });
    const store = build(io, { onDegrade });
    await store.load();

    for (let i = 0; i < 5; i += 1)
      await store.put({ id: `k${i}`, value: i, createdAt: 0 });
    expect(onDegrade).toHaveBeenCalledTimes(1);
  });
});

describe("createJsonlStore — memory-only mode", () => {
  it("reports persistence 'off' and still works", async () => {
    const store = build(undefined);
    await store.load();
    await store.put({ id: "a", value: 1, createdAt: 0 });
    expect(store.get("a")?.value).toBe(1);
    expect(store.stats().persistence).toBe("off");
  });
});

describe("createJsonlStore — expiry does not leak memory", () => {
  it("evicts expired entries from memory during compaction, not just from the file", async () => {
    // Compaction used to filter expired records out of the written file while
    // leaving them in the map, so a long-running process grew forever even
    // though the file stayed small.
    let clock = 0;
    const io = createFakeStoreIo();
    const store = build(io, {
      compactionRatio: 1,
      isLive: (r, n) => n - r.createdAt < 1_000,
      now: () => clock,
    });
    await store.load();

    for (let i = 0; i < 100; i += 1)
      await store.put({ id: `k${i}`, value: i, createdAt: 0 });
    expect(store.values()).toHaveLength(100);

    clock = 10_000; // everything is now expired
    await store.compact();

    expect(store.values()).toHaveLength(0);
    expect(store.stats().entries).toBe(0);
    expect((io.files.get(PATH) ?? "").trim()).toBe("");
  });

  it("compacts a mostly-dead file promptly on load", async () => {
    // `appended` used to reset to 0 after load, so a file left bloated by an
    // ungraceful shutdown would not compact until COMPACTION_FLOOR fresh
    // appends had accumulated. Plant the bloated file directly rather than
    // trying to produce one, which the in-process compactor would prevent.
    const io = createFakeStoreIo();
    const bloated = Array.from({ length: 500 }, (_, i) =>
      JSON.stringify({ k: "same", d: { id: "same", value: i, createdAt: 0 } }),
    ).join("\n");
    io.files.set(PATH, `${bloated}\n`);

    const store = build(io);
    await store.load();

    const after = (io.files.get(PATH) ?? "")
      .split("\n")
      .filter((l) => l).length;
    expect(after).toBe(1);
    expect(store.get("same")?.value).toBe(499);
    expect(store.stats().compactions).toBe(1);
  });
});

describe("createJsonlStore — expiry in modes where compaction never runs", () => {
  it("evicts expired entries in memory-only mode", async () => {
    // Compaction runs inside guarded(), which is skipped when persistence is
    // 'off' — so without an independent sweep nothing would ever reclaim these.
    let clock = 0;
    const store = build(undefined, {
      isLive: (r, n) => n - r.createdAt < 1_000,
      now: () => clock,
    });
    await store.load();
    for (let i = 0; i < 300; i += 1)
      await store.put({ id: `k${i}`, value: i, createdAt: clock });

    clock = 10_000;
    for (let i = 0; i < 300; i += 1)
      await store.put({ id: `n${i}`, value: i, createdAt: clock });

    // The first 300 are long expired and must not still be held.
    expect(store.get("k0")).toBeUndefined();
    expect(store.values().length).toBeLessThanOrEqual(300);
  });

  it("evicts expired entries after persistence has degraded", async () => {
    let clock = 0;
    const io = createFakeStoreIo({ failAfter: 0 });
    const store = build(io, {
      isLive: (r, n) => n - r.createdAt < 1_000,
      now: () => clock,
    });
    await store.load();
    for (let i = 0; i < 300; i += 1)
      await store.put({ id: `k${i}`, value: i, createdAt: clock });
    expect(store.stats().persistence).toBe("disabled");

    clock = 10_000;
    for (let i = 0; i < 300; i += 1)
      await store.put({ id: `n${i}`, value: i, createdAt: clock });

    expect(store.get("k0")).toBeUndefined();
  });
});

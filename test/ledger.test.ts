import { describe, expect, it } from "vitest";
import { decideAdmission } from "../src/protocol/admission.js";
import { createLedger, createMemoryLedger } from "../src/store/ledger.js";
import { createFakeStoreIo } from "./fakes/fake-store-io.js";

const STATE_DIR = "/state/hookdeck";

describe("ledger — durability across a restart", () => {
  it("remembers a settled event, so a redelivery after restart is a duplicate", async () => {
    const io = createFakeStoreIo();
    const first = await createLedger({
      ttlHours: 168,
      instanceId: "boot-1",
      stateDir: STATE_DIR,
      io,
    });
    await first.begin("evt_1", 1, { routeId: "stripe" });
    await first.settle("evt_1", "succeeded");
    await first.close();

    const second = await createLedger({
      ttlHours: 168,
      instanceId: "boot-2",
      stateDir: STATE_DIR,
      io,
    });
    const row = second.get("evt_1");
    expect(row?.status).toBe("succeeded");
    // The whole point: without persistence this redelivery would re-run work.
    expect(decideAdmission(row, 1).admit).toBe(false);
  });

  it("still admits a genuine retry after a restart", async () => {
    const io = createFakeStoreIo();
    const first = await createLedger({
      ttlHours: 168,
      instanceId: "boot-1",
      stateDir: STATE_DIR,
      io,
    });
    await first.begin("evt_1", 1);
    await first.settle("evt_1", "failed");
    await first.close();

    const second = await createLedger({
      ttlHours: 168,
      instanceId: "boot-2",
      stateDir: STATE_DIR,
      io,
    });
    expect(decideAdmission(second.get("evt_1"), 2).admit).toBe(true);
  });

  it("preserves the highest attempt number seen", async () => {
    const io = createFakeStoreIo();
    const first = await createLedger({
      ttlHours: 168,
      instanceId: "b1",
      stateDir: STATE_DIR,
      io,
    });
    await first.begin("evt_1", 5);
    await first.settle("evt_1", "failed");
    // A lower attempt must not lower the watermark.
    await first.begin("evt_1", 2);
    await first.close();

    const second = await createLedger({
      ttlHours: 168,
      instanceId: "b2",
      stateDir: STATE_DIR,
      io,
    });
    expect(second.get("evt_1")?.attempt).toBe(5);
  });
});

describe("ledger — orphan detection", () => {
  it("treats a running row from a dead instance as an orphan", async () => {
    const io = createFakeStoreIo();
    const first = await createLedger({
      ttlHours: 168,
      instanceId: "boot-1",
      stateDir: STATE_DIR,
      io,
    });
    await first.begin("evt_crashed", 1, { routeId: "stripe" });
    // No settle: the process died mid-dispatch.
    await first.close();

    const second = await createLedger({
      ttlHours: 168,
      instanceId: "boot-2",
      stateDir: STATE_DIR,
      io,
    });
    const orphans = second.listOrphans();
    expect(orphans).toHaveLength(1);
    expect(orphans[0]).toMatchObject({
      eventId: "evt_crashed",
      routeId: "stripe",
      owner: "boot-1",
    });
  });

  it("does not treat this instance's own running rows as orphans", async () => {
    const ledger = createMemoryLedger({ ttlHours: 168, instanceId: "boot-1" });
    await ledger.begin("evt_1", 1);
    expect(ledger.listOrphans()).toHaveLength(0);
  });

  it("does not treat settled rows from a dead instance as orphans", async () => {
    const io = createFakeStoreIo();
    const first = await createLedger({
      ttlHours: 168,
      instanceId: "boot-1",
      stateDir: STATE_DIR,
      io,
    });
    await first.begin("evt_ok", 1);
    await first.settle("evt_ok", "succeeded");
    await first.close();

    const second = await createLedger({
      ttlHours: 168,
      instanceId: "boot-2",
      stateDir: STATE_DIR,
      io,
    });
    expect(second.listOrphans()).toHaveLength(0);
  });
});

describe("ledger — pruning", () => {
  it("NEVER prunes a running row, however old", async () => {
    // Running rows are the only record of work whose outcome is unknown, and
    // boot recovery reads them. Pruning one loses the work silently.
    let clock = 0;
    const ledger = createMemoryLedger({
      ttlHours: 1,
      instanceId: "b",
      now: () => clock,
    });
    await ledger.begin("evt_stuck", 1);
    clock = 1_000 * 60 * 60 * 24 * 365;
    expect(await ledger.prune()).toBe(0);
    expect(ledger.get("evt_stuck")).toBeDefined();
  });

  it("prunes terminal rows past the TTL", async () => {
    let clock = 0;
    const ledger = createMemoryLedger({
      ttlHours: 1,
      instanceId: "b",
      now: () => clock,
    });
    await ledger.begin("evt_1", 1);
    await ledger.settle("evt_1", "succeeded");
    clock = 1_000 * 60 * 60 * 2;
    expect(await ledger.prune()).toBe(1);
    expect(ledger.get("evt_1")).toBeUndefined();
  });

  it("drops expired terminal rows on load but keeps running ones", async () => {
    const io = createFakeStoreIo();
    let clock = 0;
    const first = await createLedger({
      ttlHours: 1,
      instanceId: "b1",
      stateDir: STATE_DIR,
      io,
      now: () => clock,
    });
    await first.begin("evt_done", 1);
    await first.settle("evt_done", "succeeded");
    await first.begin("evt_stuck", 1);
    await first.close();

    clock = 1_000 * 60 * 60 * 24;
    const second = await createLedger({
      ttlHours: 1,
      instanceId: "b2",
      stateDir: STATE_DIR,
      io,
      now: () => clock,
    });
    expect(second.get("evt_done")).toBeUndefined();
    expect(second.get("evt_stuck")).toBeDefined();
  });
});

describe("ledger — degradation", () => {
  it("keeps working when the disk fails, reporting persistence disabled", async () => {
    const io = createFakeStoreIo({ failAfter: 1 });
    const ledger = await createLedger({
      ttlHours: 168,
      instanceId: "b",
      stateDir: STATE_DIR,
      io,
    });

    await ledger.begin("evt_1", 1);
    await ledger.settle("evt_1", "succeeded");
    await ledger.begin("evt_2", 1);

    expect(ledger.get("evt_1")?.status).toBe("succeeded");
    expect(ledger.get("evt_2")?.status).toBe("running");
    expect(ledger.stats().persistence).toBe("disabled");
  });

  it("reports persistence 'off' in memory-only mode", () => {
    const ledger = createMemoryLedger({ ttlHours: 168, instanceId: "b" });
    expect(ledger.stats().persistence).toBe("off");
  });

  it("counts running rows in stats", async () => {
    const ledger = createMemoryLedger({ ttlHours: 168, instanceId: "b" });
    await ledger.begin("evt_1", 1);
    await ledger.begin("evt_2", 1);
    await ledger.settle("evt_1", "succeeded");
    expect(ledger.stats()).toMatchObject({ entries: 2, running: 1 });
  });
});

describe("the agent retry budget spans an event's whole life", () => {
  it("carries agentRetries across redeliveries", async () => {
    // `begin` runs on every admitted delivery. Rebuilding the row without this
    // field resets the budget each round trip, so a permanently failing run
    // retries without limit and never reaches `exhausted`.
    const ledger = createMemoryLedger({ ttlHours: 168, instanceId: "t" });

    await ledger.begin("evt_1", 1);
    await ledger.settle("evt_1", "failed", { agentRetries: 1 });

    await ledger.begin("evt_1", 2);
    expect(ledger.get("evt_1")?.agentRetries).toBe(1);

    await ledger.settle("evt_1", "failed", { agentRetries: 2 });
    await ledger.begin("evt_1", 3);
    expect(ledger.get("evt_1")?.agentRetries).toBe(2);
  });

  it("leaves it absent for an event that has never retried", async () => {
    const ledger = createMemoryLedger({ ttlHours: 168, instanceId: "t" });
    await ledger.begin("evt_2", 1);
    expect(ledger.get("evt_2")?.agentRetries).toBeUndefined();
  });
});

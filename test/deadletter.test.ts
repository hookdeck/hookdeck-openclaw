import { describe, expect, it } from "vitest";
import { createDeadLetterLog } from "../src/store/deadletter.js";
import { createFakeStoreIo } from "./fakes/fake-store-io.js";

const STATE_DIR = "/state/hookdeck";

const entry = {
  eventId: "evt_1",
  routeId: "stripe",
  code: "malformed_json",
  reason: "invalid JSON",
  retriesCancelled: true,
  lastAttempt: false,
};

describe("dead-letter log", () => {
  it("records and lists newest first", async () => {
    let clock = 0;
    const log = await createDeadLetterLog({ ttlHours: 168, now: () => (clock += 1000) });
    await log.record({ ...entry, eventId: "evt_1" });
    await log.record({ ...entry, eventId: "evt_2" });

    expect(log.list().map((r) => r.eventId)).toEqual(["evt_2", "evt_1"]);
    expect(log.count()).toBe(2);
  });

  it("survives a restart", async () => {
    const io = createFakeStoreIo();
    const first = await createDeadLetterLog({ ttlHours: 168, stateDir: STATE_DIR, io });
    await first.record(entry);
    await first.close();

    const second = await createDeadLetterLog({ ttlHours: 168, stateDir: STATE_DIR, io });
    expect(second.count()).toBe(1);
    expect(second.list()[0]).toMatchObject({ eventId: "evt_1", code: "malformed_json" });
  });

  it("bounds itself so an outage cannot grow the log without limit", async () => {
    let clock = 0;
    const log = await createDeadLetterLog({
      ttlHours: 168,
      maxEntries: 3,
      now: () => (clock += 1000),
    });
    for (let i = 0; i < 10; i += 1) await log.record({ ...entry, eventId: `evt_${i}` });

    expect(log.count()).toBe(3);
    // Oldest dropped, newest kept.
    expect(log.list().map((r) => r.eventId)).toEqual(["evt_9", "evt_8", "evt_7"]);
  });

  it("expires entries past the TTL on reload", async () => {
    const io = createFakeStoreIo();
    let clock = 0;
    const first = await createDeadLetterLog({
      ttlHours: 1,
      stateDir: STATE_DIR,
      io,
      now: () => clock,
    });
    await first.record(entry);
    await first.close();

    clock = 1000 * 60 * 60 * 24;
    const second = await createDeadLetterLog({
      ttlHours: 1,
      stateDir: STATE_DIR,
      io,
      now: () => clock,
    });
    expect(second.count()).toBe(0);
  });

  it("keeps working when persistence fails", async () => {
    const io = createFakeStoreIo({ failAfter: 0 });
    const log = await createDeadLetterLog({ ttlHours: 168, stateDir: STATE_DIR, io });
    await log.record(entry);

    expect(log.count()).toBe(1);
    expect(log.stats().persistence).toBe("disabled");
  });

  it("generates unique ids within a process", async () => {
    const log = await createDeadLetterLog({ ttlHours: 168, now: () => 1000 });
    const a = await log.record(entry);
    const b = await log.record(entry);
    expect(a.id).not.toBe(b.id);
  });
});

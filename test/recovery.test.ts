import { describe, expect, it, vi } from "vitest";
import type { EventRetrier } from "../src/hookdeck/client.js";
import { reconcileOrphans } from "../src/recovery.js";
import { createDeadLetterLog } from "../src/store/deadletter.js";
import { createLedger, createMemoryLedger } from "../src/store/ledger.js";
import { createFakeStoreIo } from "./fakes/fake-store-io.js";

const STATE_DIR = "/state/hookdeck";
const silent = { debug: () => {}, info: () => {}, warn: () => {} };

function fakeClient(overrides: Partial<EventRetrier> = {}): EventRetrier {
  return {
    retryEvent: vi.fn(async (eventId: string) => ({ ok: true as const, data: { eventId } })),
    ...overrides,
  };
}

/** Simulates a crash: begin work, never settle, then boot a new instance. */
async function crashedLedger(eventIds: string[]) {
  const io = createFakeStoreIo();
  const first = await createLedger({ ttlHours: 168, instanceId: "boot-1", stateDir: STATE_DIR, io });
  for (const id of eventIds) await first.begin(id, 1, { routeId: "stripe" });
  await first.close();

  const ledger = await createLedger({
    ttlHours: 168,
    instanceId: "boot-2",
    stateDir: STATE_DIR,
    io,
  });
  const deadLetter = await createDeadLetterLog({ ttlHours: 168, stateDir: STATE_DIR, io });
  return { ledger, deadLetter, io };
}

describe("reconcileOrphans", () => {
  it("hands interrupted work back to Hookdeck", async () => {
    const { ledger, deadLetter } = await crashedLedger(["evt_a", "evt_b"]);
    const client = fakeClient();

    const summary = await reconcileOrphans({ ledger, deadLetter, logger: silent, client });

    expect(summary).toMatchObject({ found: 2, retried: 2, failed: 0, skipped: 0 });
    expect(client.retryEvent).toHaveBeenCalledTimes(2);
  });

  it("settles orphan rows so the next boot does not see them again", async () => {
    // Leaving a row `running` would make it an orphan forever.
    const { ledger, deadLetter } = await crashedLedger(["evt_a"]);
    await reconcileOrphans({ ledger, deadLetter, logger: silent, client: fakeClient() });

    expect(ledger.get("evt_a")?.status).toBe("failed");
    expect(ledger.listOrphans()).toHaveLength(0);
  });

  it("does nothing when there are no orphans", async () => {
    const ledger = createMemoryLedger({ ttlHours: 168, instanceId: "b" });
    const deadLetter = await createDeadLetterLog({ ttlHours: 168 });
    const client = fakeClient();

    const summary = await reconcileOrphans({ ledger, deadLetter, logger: silent, client });
    expect(summary.found).toBe(0);
    expect(client.retryEvent).not.toHaveBeenCalled();
  });

  it("records to the dead-letter log when no API key is configured", async () => {
    const { ledger, deadLetter } = await crashedLedger(["evt_a"]);

    const summary = await reconcileOrphans({ ledger, deadLetter, logger: silent });

    expect(summary).toMatchObject({ found: 1, retried: 0, skipped: 1 });
    const entries = deadLetter.list();
    expect(entries[0]).toMatchObject({ eventId: "evt_a", code: "interrupted" });
    expect(entries[0]?.reason).toMatch(/no API key/);
  });

  it("respects the recovery budget, oldest first", async () => {
    const { ledger, deadLetter } = await crashedLedger(["evt_a", "evt_b", "evt_c"]);
    const client = fakeClient();

    const summary = await reconcileOrphans({
      ledger,
      deadLetter,
      logger: silent,
      client,
      maxEvents: 2,
    });

    expect(summary).toMatchObject({ found: 3, retried: 2, skipped: 1 });
    // Oldest first: the events nearest falling out of Hookdeck's retention
    // window are the ones that get recovered.
    expect(client.retryEvent).toHaveBeenNthCalledWith(1, "evt_a");
    expect(client.retryEvent).toHaveBeenNthCalledWith(2, "evt_b");
  });

  it("can be switched off entirely", async () => {
    const { ledger, deadLetter } = await crashedLedger(["evt_a"]);
    const client = fakeClient();

    const summary = await reconcileOrphans({
      ledger,
      deadLetter,
      logger: silent,
      client,
      enabled: false,
    });

    expect(summary).toMatchObject({ found: 1, retried: 0, skipped: 1 });
    expect(client.retryEvent).not.toHaveBeenCalled();
    // Left alone, so an operator can inspect and re-enable.
    expect(ledger.get("evt_a")?.status).toBe("running");
  });

  it("dead-letters an event the API refuses to retry, and keeps going", async () => {
    const { ledger, deadLetter } = await crashedLedger(["evt_a", "evt_b"]);
    const client = fakeClient({
      retryEvent: vi
        .fn()
        .mockResolvedValueOnce({ ok: false, status: 404, code: "not_found", message: "gone" })
        .mockResolvedValueOnce({ ok: true, data: { eventId: "evt_b" } }),
    });

    const summary = await reconcileOrphans({ ledger, deadLetter, logger: silent, client });

    expect(summary).toMatchObject({ found: 2, retried: 1, failed: 1 });
    expect(deadLetter.list()[0]).toMatchObject({ code: "recovery_failed" });
  });

  it("does not let an API failure block startup", async () => {
    const { ledger, deadLetter } = await crashedLedger(["evt_a"]);
    const client = fakeClient({
      retryEvent: vi.fn(async () => ({
        ok: false as const,
        code: "network_error",
        message: "ECONNREFUSED",
      })),
    });

    await expect(
      reconcileOrphans({ ledger, deadLetter, logger: silent, client }),
    ).resolves.toMatchObject({ failed: 1 });
  });
});

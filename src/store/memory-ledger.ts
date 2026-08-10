import { isPrunable, type LedgerRow, type LedgerStatus } from "../protocol/admission.js";

/**
 * In-memory ledger. M1 only.
 *
 * M2 layers append-only JSONL persistence underneath this, keeping the memory
 * map authoritative for the running process and letting the persistent layer
 * permanently disable itself on first failure — so a storage problem degrades
 * to at-least-once rather than wedging webhook handling.
 *
 * Until then, be explicit about the consequence: a Gateway restart loses the
 * ledger, so work can re-run once. `stats().durable` reports this so `status`
 * can say so out loud rather than implying a guarantee we do not yet make.
 */
export interface Ledger {
  get(eventId: string): LedgerRow | undefined;
  /** Record the start of a dispatch. Called only after admission succeeds. */
  begin(eventId: string, attempt: number, now?: number): LedgerRow;
  settle(eventId: string, status: LedgerStatus, now?: number): void;
  prune(now?: number): number;
  stats(): { entries: number; durable: boolean };
}

export function createMemoryLedger(ttlHours: number): Ledger {
  const rows = new Map<string, LedgerRow>();
  const ttlMs = ttlHours * 60 * 60 * 1000;

  return {
    get(eventId) {
      return rows.get(eventId);
    },

    begin(eventId, attempt, now = Date.now()) {
      const existing = rows.get(eventId);
      const row: LedgerRow = {
        eventId,
        attempt: Math.max(attempt, existing?.attempt ?? 0),
        runCount: (existing?.runCount ?? 0) + 1,
        status: "running",
        updatedAt: now,
      };
      rows.set(eventId, row);
      return row;
    },

    settle(eventId, status, now = Date.now()) {
      const existing = rows.get(eventId);
      if (existing === undefined) return;
      rows.set(eventId, { ...existing, status, updatedAt: now });
    },

    prune(now = Date.now()) {
      let removed = 0;
      for (const [eventId, row] of rows) {
        // `running` rows are never pruned — they are the only record of work
        // whose outcome we do not know.
        if (isPrunable(row, now, ttlMs)) {
          rows.delete(eventId);
          removed += 1;
        }
      }
      return removed;
    },

    stats() {
      return { entries: rows.size, durable: false };
    },
  };
}

/**
 * Local admission control. In CLI transport this is the only limit that exists,
 * because CLI destinations carry no `rate_limit` field — so it is load-bearing,
 * not belt-and-braces.
 */
export interface InFlightRegistry {
  readonly size: number;
  has(eventId: string): boolean;
  acquire(eventId: string): boolean;
  release(eventId: string): void;
}

export function createInFlightRegistry(maxConcurrent: number): InFlightRegistry {
  const active = new Set<string>();
  return {
    get size() {
      return active.size;
    },
    has(eventId) {
      return active.has(eventId);
    },
    acquire(eventId) {
      if (active.size >= maxConcurrent || active.has(eventId)) return false;
      active.add(eventId);
      return true;
    },
    release(eventId) {
      active.delete(eventId);
    },
  };
}

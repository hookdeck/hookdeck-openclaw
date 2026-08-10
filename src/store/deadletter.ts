import { join } from "node:path";
import { createJsonlStore, type JsonlStore, type PersistenceState } from "./jsonl-store.js";
import type { StoreIo } from "./store-io.js";

/**
 * Local record of everything we stop retrying.
 *
 * Two callers, and both matter:
 *
 *  - Any `Retry-After: -1` cancellation. If we are telling Hookdeck to stop
 *    trying, the payload has to survive somewhere or it is simply gone.
 *  - The last automatic attempt, detected by an absent `x-hookdeck-will-retry-after`.
 *    Hookdeck opens an Issue, which is the operator's alert; this is the local
 *    copy the agent can read without an API call.
 *
 * Bounded by count as well as TTL: a dead-letter log that grows without limit
 * during an outage is its own incident.
 */

export interface DeadLetterRecord {
  id: string;
  eventId?: string;
  requestId?: string;
  routeId?: string;
  /** Response code we returned, e.g. `malformed_json`. */
  code: string;
  reason: string;
  /** Whether we told Hookdeck to stop retrying. */
  retriesCancelled: boolean;
  /** Whether this was the last automatic attempt Hookdeck would make. */
  lastAttempt: boolean;
  attemptCount?: number;
  createdAt: number;
}

export interface DeadLetterLog {
  record(entry: Omit<DeadLetterRecord, "id" | "createdAt">): Promise<DeadLetterRecord>;
  list(limit?: number): DeadLetterRecord[];
  count(): number;
  close(): Promise<void>;
  stats(): { entries: number; persistence: PersistenceState };
}

export const DEADLETTER_FILENAME = "deadletter.jsonl";
const DEFAULT_MAX_ENTRIES = 500;

export interface DeadLetterOptions {
  ttlHours: number;
  maxEntries?: number;
  stateDir?: string;
  io?: StoreIo;
  onDegrade?(error: unknown, path: string): void;
  /** Open without writing, for a reader in another process. */
  readOnly?: boolean;
  now?(): number;
}

export async function createDeadLetterLog(options: DeadLetterOptions): Promise<DeadLetterLog> {
  const now = options.now ?? Date.now;
  const ttlMs = options.ttlHours * 60 * 60 * 1000;
  const maxEntries = options.maxEntries ?? DEFAULT_MAX_ENTRIES;

  const path =
    options.stateDir !== undefined && options.io !== undefined
      ? join(options.stateDir, DEADLETTER_FILENAME)
      : undefined;

  const store: JsonlStore<DeadLetterRecord> = createJsonlStore<DeadLetterRecord>({
    ...(path !== undefined ? { path } : {}),
    ...(options.io !== undefined ? { io: options.io } : {}),
    keyOf: (record) => record.id,
    isLive: (record, stamp) => stamp - record.createdAt <= ttlMs,
    ...(options.onDegrade !== undefined ? { onDegrade: options.onDegrade } : {}),
    ...(options.readOnly === true ? { readOnly: true } : {}),
    now,
  });

  await store.load();

  let sequence = 0;

  function sorted(): DeadLetterRecord[] {
    return store.values().sort((a, b) => b.createdAt - a.createdAt);
  }

  return {
    async record(entry) {
      const stamp = now();
      sequence += 1;
      const record: DeadLetterRecord = {
        ...entry,
        // Deliberately not random: workflow scripts and tests need this to be
        // reproducible, and uniqueness only has to hold within a process.
        id: `dl_${stamp.toString(36)}_${sequence.toString(36)}`,
        createdAt: stamp,
      };
      await store.put(record);

      const overflow = store.values().length - maxEntries;
      if (overflow > 0) {
        const oldest = sorted().slice(-overflow);
        for (const stale of oldest) await store.delete(stale.id);
      }
      return record;
    },

    list(limit = 50) {
      return sorted().slice(0, limit);
    },

    count() {
      return store.values().length;
    },

    async close() {
      await store.close();
    },

    stats() {
      const stats = store.stats();
      return { entries: stats.entries, persistence: stats.persistence };
    },
  };
}

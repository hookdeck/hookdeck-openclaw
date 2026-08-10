import { join } from "node:path";
import {
  isPrunable,
  type LedgerRow,
  type LedgerStatus,
} from "../protocol/admission.js";
import {
  createJsonlStore,
  type JsonlStore,
  type PersistenceState,
} from "./jsonl-store.js";
import type { StoreIo } from "./store-io.js";

export interface LedgerOptions {
  ttlHours: number;
  /** Identifies this process instance. Rows owned by anyone else are orphans. */
  instanceId: string;
  /** Omit both to run memory-only (tests, or an operator with no writable state dir). */
  stateDir?: string;
  io?: StoreIo;
  onDegrade?(error: unknown, path: string): void;
  /** Open without writing, for a reader in another process. */
  readOnly?: boolean;
  now?(): number;
}

export interface LedgerStats {
  entries: number;
  running: number;
  persistence: PersistenceState;
  compactions: number;
  firstError?: string;
}

export interface Ledger {
  get(eventId: string): LedgerRow | undefined;
  /** Records the start of a dispatch. Called only after admission succeeds. */
  begin(
    eventId: string,
    attempt: number,
    meta?: { routeId?: string },
  ): Promise<LedgerRow>;
  settle(
    eventId: string,
    status: LedgerStatus,
    patch?: { agentRetries?: number },
  ): Promise<void>;
  /**
   * `running` rows owned by a previous process instance. Each represents work
   * whose outcome we do not know, because the process that owned it died
   * mid-dispatch.
   */
  listOrphans(): LedgerRow[];
  prune(): Promise<number>;
  close(): Promise<void>;
  stats(): LedgerStats;
}

export const LEDGER_FILENAME = "ledger.jsonl";

function buildStore(options: LedgerOptions): JsonlStore<LedgerRow> {
  const now = options.now ?? Date.now;
  const ttlMs = options.ttlHours * 60 * 60 * 1000;

  const path =
    options.stateDir !== undefined && options.io !== undefined
      ? join(options.stateDir, LEDGER_FILENAME)
      : undefined;

  return createJsonlStore<LedgerRow>({
    ...(path !== undefined ? { path } : {}),
    ...(options.io !== undefined ? { io: options.io } : {}),
    keyOf: (row) => row.eventId,
    // `running` rows are never expired away — they are the only record of work
    // whose outcome is unknown, and boot reconciliation depends on finding them.
    isLive: (row, stamp) => !isPrunable(row, stamp, ttlMs),
    ...(options.onDegrade !== undefined
      ? { onDegrade: options.onDegrade }
      : {}),
    ...(options.readOnly === true ? { readOnly: true } : {}),
    now,
  });
}

/** Loads any persisted state, then returns the ledger. */
export async function createLedger(options: LedgerOptions): Promise<Ledger> {
  const store = buildStore(options);
  await store.load();
  return buildLedger(store, options);
}

/**
 * Memory-only ledger, constructed synchronously. Used by tests and by operators
 * who set `storage.enabled: false` — exactly-once within the process, but
 * at-least-once across a restart and no crash recovery.
 */
export function createMemoryLedger(
  options: Omit<LedgerOptions, "stateDir" | "io">,
): Ledger {
  return buildLedger(buildStore(options), options);
}

function buildLedger(
  store: JsonlStore<LedgerRow>,
  options: LedgerOptions,
): Ledger {
  const now = options.now ?? Date.now;

  return {
    get(eventId) {
      // A copy: callers include tool handlers that hand rows to a model, and a
      // mutable reference into the ledger is a footgun with no upside.
      const row = store.get(eventId);
      return row === undefined ? undefined : { ...row };
    },

    async begin(eventId, attempt, meta) {
      const existing = store.get(eventId);
      const row: LedgerRow = {
        eventId,
        attempt: Math.max(attempt, existing?.attempt ?? 0),
        runCount: (existing?.runCount ?? 0) + 1,
        status: "running",
        updatedAt: now(),
        owner: options.instanceId,
        ...(meta?.routeId !== undefined ? { routeId: meta.routeId } : {}),
      };
      // Awaited on purpose: this write is the boundary before which we must not
      // acknowledge anything. If it fails, persistence degrades and we continue
      // memory-only rather than dropping the delivery.
      await store.put(row);
      return row;
    },

    async settle(eventId, status, patch) {
      const existing = store.get(eventId);
      if (existing === undefined) return;
      await store.put({
        ...existing,
        status,
        updatedAt: now(),
        ...(patch?.agentRetries !== undefined
          ? { agentRetries: patch.agentRetries }
          : {}),
      });
    },

    listOrphans() {
      return store
        .values()
        .filter(
          (row) => row.status === "running" && row.owner !== options.instanceId,
        );
    },

    async prune() {
      return store.prune();
    },

    async close() {
      await store.close();
    },

    stats() {
      const stats = store.stats();
      return {
        entries: stats.entries,
        running: store.values().filter((r) => r.status === "running").length,
        persistence: stats.persistence,
        compactions: stats.compactions,
        ...(stats.firstError !== undefined
          ? { firstError: stats.firstError }
          : {}),
      };
    },
  };
}

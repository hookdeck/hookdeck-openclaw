import { join } from "node:path";
import {
  createJsonlStore,
  type JsonlStore,
  type PersistenceState,
} from "./jsonl-store.js";
import type { StoreIo } from "./store-io.js";

/**
 * Small durable facts that must survive a crash, not just a clean shutdown.
 *
 * Each one is a breadcrumb written *before* the action it describes, because
 * the failure mode we care about is dying half way through:
 *
 *  - `lastDisconnectAt` is the only evidence of an outage window. Written on
 *    every listener exit, crash or otherwise, or there is nothing to bound a
 *    catch-up query with.
 *  - `pausedByUs` is set before calling pause, so a crash mid-shutdown still
 *    leaves the marker that triggers unpause on the next start. A connection
 *    left paused forever is a silent outage.
 *  - `provisioningFingerprint` lets startup skip an unchanged upsert.
 */
export interface CursorRecord {
  key: string;
  routeId: string;
  lastDisconnectAt?: number;
  pausedByUs?: boolean;
  provisioningFingerprint?: string;
  connectionId?: string;
  updatedAt: number;
}

export interface CursorStore {
  get(routeId: string): CursorRecord | undefined;
  patch(
    routeId: string,
    patch: Partial<Omit<CursorRecord, "key" | "routeId">>,
  ): Promise<void>;
  /** Removes a field outright, rather than writing an undefined over it. */
  clear(routeId: string, field: keyof CursorRecord): Promise<void>;
  all(): CursorRecord[];
  close(): Promise<void>;
  stats(): { entries: number; persistence: PersistenceState };
}

export const CURSOR_FILENAME = "cursors.jsonl";

export interface CursorStoreOptions {
  stateDir?: string;
  io?: StoreIo;
  onDegrade?(error: unknown, path: string): void;
  /** Open without writing, for a reader in another process. */
  readOnly?: boolean;
  now?(): number;
}

export async function createCursorStore(
  options: CursorStoreOptions = {},
): Promise<CursorStore> {
  const now = options.now ?? Date.now;
  const path =
    options.stateDir !== undefined && options.io !== undefined
      ? join(options.stateDir, CURSOR_FILENAME)
      : undefined;

  const store: JsonlStore<CursorRecord> = createJsonlStore<CursorRecord>({
    ...(path !== undefined ? { path } : {}),
    ...(options.io !== undefined ? { io: options.io } : {}),
    keyOf: (record) => record.key,
    // Cursors never expire: a disconnect breadcrumb from a long outage is
    // exactly the one you need, and there are only ever a handful of rows.
    isLive: () => true,
    ...(options.onDegrade !== undefined
      ? { onDegrade: options.onDegrade }
      : {}),
    ...(options.readOnly === true ? { readOnly: true } : {}),
    now,
  });

  await store.load();

  return {
    get(routeId) {
      return store.get(routeId);
    },

    async patch(routeId, patch) {
      const existing = store.get(routeId);
      await store.put({
        key: routeId,
        routeId,
        ...existing,
        ...patch,
        updatedAt: now(),
      });
    },

    async clear(routeId, field) {
      const existing = store.get(routeId);
      if (existing === undefined) return;
      const next = { ...existing };
      delete next[field];
      await store.put({ ...next, key: routeId, routeId, updatedAt: now() });
    },

    all() {
      return store.values();
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

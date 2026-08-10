import { dirname } from "node:path";
import type { StoreIo } from "./store-io.js";

/**
 * Append-only JSONL with last-write-wins semantics and atomic compaction.
 *
 * The shape mirrors OpenClaw's own `createPersistentDedupeCache`: an in-memory
 * map that is always authoritative for the running process, plus a persistent
 * layer that exists solely to survive restarts and that **permanently disables
 * itself on the first failure**. A broken disk must degrade the guarantee from
 * exactly-once to at-least-once; it must never wedge webhook handling.
 *
 * We cannot use OpenClaw's `openKeyedStore` — it is gated to bundled and
 * trusted-official plugins, and a community plugin cannot qualify.
 */

export type PersistenceState = "active" | "disabled" | "off";

export interface JsonlStoreOptions<T> {
  /** Absolute file path. When omitted the store is memory-only (`off`). */
  path?: string;
  io?: StoreIo;
  keyOf(record: T): string;
  /** Records failing this at load or compaction time are dropped. */
  isLive(record: T, now: number): boolean;
  /** Called once, on the first persistence failure only. */
  onDegrade?(error: unknown, path: string): void;
  /** Compact once appended lines exceed this multiple of live entries. */
  compactionRatio?: number;
  now?(): number;
}

export interface JsonlStoreStats {
  entries: number;
  appended: number;
  compactions: number;
  persistence: PersistenceState;
  firstError?: string;
}

export interface JsonlStore<T> {
  load(): Promise<void>;
  get(key: string): T | undefined;
  values(): T[];
  /** Updates memory synchronously; the promise settles when persisted. */
  put(record: T): Promise<void>;
  delete(key: string): Promise<void>;
  prune(): Promise<number>;
  compact(): Promise<void>;
  close(): Promise<void>;
  stats(): JsonlStoreStats;
}

const DEFAULT_COMPACTION_RATIO = 4;
/** Below this, compaction churn costs more than the file it saves. */
const COMPACTION_FLOOR = 64;

type Envelope<T> = { k: string; d?: T; x?: true };

export function createJsonlStore<T>(options: JsonlStoreOptions<T>): JsonlStore<T> {
  const { path, io, keyOf, isLive, onDegrade, compactionRatio = DEFAULT_COMPACTION_RATIO } = options;
  const now = options.now ?? Date.now;

  const memory = new Map<string, T>();
  const persistent = path !== undefined && io !== undefined;

  let persistence: PersistenceState = persistent ? "active" : "off";
  let appended = 0;
  let compactions = 0;
  let firstError: string | undefined;
  // Serialises writes so a compaction can never interleave with an append.
  let queue: Promise<unknown> = Promise.resolve();

  function degrade(error: unknown): void {
    if (persistence !== "active") return;
    persistence = "disabled";
    firstError = error instanceof Error ? error.message : String(error);
    onDegrade?.(error, path ?? "(none)");
  }

  /** Every persistence call funnels through here, so degradation has one home. */
  async function guarded(work: () => Promise<void>): Promise<void> {
    if (persistence !== "active") return;
    const run = queue.then(async () => {
      if (persistence !== "active") return;
      try {
        await work();
      } catch (err) {
        degrade(err);
      }
    });
    queue = run.catch(() => {});
    return run;
  }

  function serialise(envelope: Envelope<T>): string {
    return JSON.stringify(envelope);
  }

  function liveEnvelopes(): string[] {
    const stamp = now();
    const lines: string[] = [];
    for (const [k, d] of memory) {
      if (!isLive(d, stamp)) continue;
      lines.push(serialise({ k, d }));
    }
    return lines;
  }

  async function compactNow(): Promise<void> {
    if (!persistent || persistence !== "active" || path === undefined || io === undefined) return;
    const lines = liveEnvelopes();
    await io.writeAtomic(path, lines.length > 0 ? `${lines.join("\n")}\n` : "");
    appended = 0;
    compactions += 1;
  }

  function shouldCompact(): boolean {
    const live = memory.size;
    return appended > Math.max(COMPACTION_FLOOR, live * compactionRatio);
  }

  return {
    async load() {
      if (!persistent || path === undefined || io === undefined) return;
      try {
        await io.ensureDir(dirname(path));
        const contents = await io.read(path);
        if (contents === undefined) return;

        const stamp = now();
        let skipped = 0;
        for (const line of contents.split("\n")) {
          const trimmed = line.trim();
          if (trimmed.length === 0) continue;
          let envelope: Envelope<T>;
          try {
            envelope = JSON.parse(trimmed) as Envelope<T>;
          } catch {
            // A torn final line from a crash mid-append. Skip it and carry on;
            // refusing to load would turn a partial write into total data loss.
            skipped += 1;
            continue;
          }
          if (envelope.x === true) memory.delete(envelope.k);
          else if (envelope.d !== undefined) memory.set(envelope.k, envelope.d);
        }

        // Drop expired entries on the way in rather than carrying them.
        for (const [k, d] of [...memory]) {
          if (!isLive(d, stamp)) memory.delete(k);
        }

        if (skipped > 0 || memory.size * compactionRatio < contents.length / 100) {
          await compactNow();
        }
      } catch (err) {
        degrade(err);
      }
    },

    get(key) {
      return memory.get(key);
    },

    values() {
      return [...memory.values()];
    },

    async put(record) {
      const key = keyOf(record);
      memory.set(key, record);
      await guarded(async () => {
        await io!.append(path!, serialise({ k: key, d: record }));
        appended += 1;
        if (shouldCompact()) await compactNow();
      });
    },

    async delete(key) {
      memory.delete(key);
      await guarded(async () => {
        await io!.append(path!, serialise({ k: key, x: true } as Envelope<T>));
        appended += 1;
      });
    },

    async prune() {
      const stamp = now();
      let removed = 0;
      for (const [k, d] of [...memory]) {
        if (!isLive(d, stamp)) {
          memory.delete(k);
          removed += 1;
        }
      }
      if (removed > 0) await guarded(compactNow);
      return removed;
    },

    async compact() {
      await guarded(compactNow);
    },

    async close() {
      // Compact on the way out so the next boot loads a clean file.
      await guarded(compactNow);
      await queue.catch(() => {});
    },

    stats() {
      return {
        entries: memory.size,
        appended,
        compactions,
        persistence,
        ...(firstError !== undefined ? { firstError } : {}),
      };
    },
  };
}

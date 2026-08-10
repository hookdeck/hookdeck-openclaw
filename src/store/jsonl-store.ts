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

export type PersistenceState = "active" | "disabled" | "off" | "readonly";

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
  /**
   * Open without ever writing. Required for a reader in another process: the
   * Gateway owns these files, and a second writer — including the compaction
   * that `load()` would otherwise perform — can corrupt them.
   */
  readOnly?: boolean;
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
/** Puts between opportunistic expiry sweeps, for modes where compaction never runs. */
const EVICT_INTERVAL = 256;

type Envelope<T> = { k: string; d?: T; x?: true };

export function createJsonlStore<T>(
  options: JsonlStoreOptions<T>,
): JsonlStore<T> {
  const {
    path,
    io,
    keyOf,
    isLive,
    onDegrade,
    compactionRatio = DEFAULT_COMPACTION_RATIO,
  } = options;
  const now = options.now ?? Date.now;

  const memory = new Map<string, T>();
  const persistent = path !== undefined && io !== undefined;

  const readOnly = options.readOnly === true;
  let persistence: PersistenceState = persistent
    ? readOnly
      ? "readonly"
      : "active"
    : "off";
  let appended = 0;
  let compactions = 0;
  let sinceEvict = 0;
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
    // `readonly` never reaches here, so a reader cannot append or compact.
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

  /**
   * Drops expired entries from memory.
   *
   * Compaction rewrites the file; this keeps the in-memory map in step. Without
   * both, a long-running process holds every entry it has ever seen while the
   * file on disk stays small.
   */
  function evictExpired(): number {
    const stamp = now();
    let removed = 0;
    for (const [k, d] of memory) {
      if (!isLive(d, stamp)) {
        memory.delete(k);
        removed += 1;
      }
    }
    return removed;
  }

  async function compactNow(): Promise<void> {
    evictExpired();
    if (
      !persistent ||
      persistence !== "active" ||
      path === undefined ||
      io === undefined
    )
      return;
    const lines = [...memory].map(([k, d]) => serialise({ k, d }));
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

        let skipped = 0;
        let lines = 0;
        for (const line of contents.split("\n")) {
          const trimmed = line.trim();
          if (trimmed.length === 0) continue;
          lines += 1;
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

        evictExpired();

        // Carry the on-disk line count forward, so a file that is already
        // mostly dead weight is compacted promptly rather than after another
        // COMPACTION_FLOOR appends. A read-only opener never compacts: the
        // file belongs to whichever process is writing it.
        appended = lines;
        if (!readOnly && (skipped > 0 || shouldCompact())) await compactNow();
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

      // Eviction must not depend on persistence. Compaction is the usual
      // trigger, but it runs inside `guarded()` and so is skipped entirely when
      // the store is memory-only or has degraded — exactly the modes where
      // nothing else would ever reclaim expired entries.
      sinceEvict += 1;
      if (sinceEvict >= EVICT_INTERVAL) {
        sinceEvict = 0;
        evictExpired();
      }

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
      const removed = evictExpired();
      if (removed > 0) await guarded(compactNow);
      return removed;
    },

    async compact() {
      // Ahead of `guarded`, which no-ops when persistence is off or degraded.
      evictExpired();
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

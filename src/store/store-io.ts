import { constants } from "node:fs";
import { access, mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

/**
 * The filesystem surface the stores need, isolated behind an interface so tests
 * can inject failures at an exact write and assert the degradation rule.
 */
export interface StoreIo {
  ensureDir(dir: string): Promise<void>;
  /** Returns undefined when the file does not exist, rather than throwing. */
  read(path: string): Promise<string | undefined>;
  append(path: string, line: string): Promise<void>;
  /** Durable replace: write a temp file, fsync it, then rename over the target. */
  writeAtomic(path: string, contents: string): Promise<void>;
  remove(path: string): Promise<void>;
}

/** Makes each temp file unique within a process. */
let tmpCounter = 0;

export function createFsStoreIo(): StoreIo {
  return {
    async ensureDir(dir) {
      await mkdir(dir, { recursive: true, mode: 0o700 });
    },

    async read(path) {
      try {
        return await readFile(path, "utf8");
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "ENOENT") return undefined;
        throw err;
      }
    },

    async append(path, line) {
      // fsync, not just append. The ledger row written here is the boundary
      // before which nothing may be acknowledged: once we answer 2xx, Hookdeck
      // records a successful delivery and will not send the event again. A row
      // still in page cache when the machine loses power leaves no trace for
      // recovery and no Issue to notice.
      const handle = await open(path, "a", 0o600);
      try {
        await handle.appendFile(`${line}\n`, "utf8");
        await handle.sync();
      } finally {
        await handle.close();
      }
    },

    async writeAtomic(path, contents) {
      // Named per file and per call: the ledger, the dead-letter log and the
      // cursors share one directory, and a tmp name with only millisecond
      // resolution can be opened by two compactions at once, renaming mixed
      // contents over a live store.
      tmpCounter += 1;
      const tmp = join(
        dirname(path),
        `.${basename(path)}.${process.pid.toString(36)}.${tmpCounter.toString(36)}.tmp`,
      );
      const handle = await open(tmp, "w", 0o600);
      try {
        await handle.writeFile(contents, "utf8");
        // fsync before rename: rename is atomic, but without the sync the
        // rename can land while the contents are still only in page cache, so
        // a power loss leaves a correctly-named empty file.
        await handle.sync();
      } finally {
        await handle.close();
      }
      await rename(tmp, path);

      // The rename is atomic but not durable until the directory entry is
      // synced. Cursors carry `pausedByUs`, and losing that leaves a paused
      // connection nothing will unpause.
      //
      // Best effort: opening a directory for reading is not portable — Windows
      // refuses it — and a platform that cannot sync the entry is still better
      // served by the rename than by a failed write.
      try {
        const dir = await open(dirname(path), "r");
        try {
          await dir.sync();
        } finally {
          await dir.close();
        }
      } catch {
        // Directory sync unsupported here; the rename still stands.
      }
    },

    async remove(path) {
      await rm(path, { force: true });
    },
  };
}

export async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

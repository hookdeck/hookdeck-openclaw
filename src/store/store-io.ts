import { constants } from "node:fs";
import { access, appendFile, mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { dirname, join } from "node:path";

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
      await appendFile(path, `${line}\n`, { encoding: "utf8", mode: 0o600 });
    },

    async writeAtomic(path, contents) {
      const tmp = join(dirname(path), `.${Date.now().toString(36)}.tmp`);
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

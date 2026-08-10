import type { StoreIo } from "../../src/store/store-io.js";

/**
 * In-memory StoreIo with injectable failures.
 *
 * `failAfter` lets a test fail at an exact write, which is the only way to
 * assert the degradation rule properly: persistence must disable itself
 * permanently on the FIRST failure, and handling must carry on regardless.
 */
export interface FakeStoreIo extends StoreIo {
  files: Map<string, string>;
  /** Fail every write once this many have succeeded. */
  failAfter?: number;
  writes: number;
  atomicWrites: number;
  /** Simulate a crash mid-append by corrupting the tail of a file. */
  tearLastLine(path: string): void;
}

export function createFakeStoreIo(options: { failAfter?: number } = {}): FakeStoreIo {
  const files = new Map<string, string>();

  const io: FakeStoreIo = {
    files,
    writes: 0,
    atomicWrites: 0,
    ...(options.failAfter !== undefined ? { failAfter: options.failAfter } : {}),

    async ensureDir() {
      /* no-op */
    },

    async read(path) {
      return files.get(path);
    },

    async append(path, line) {
      if (io.failAfter !== undefined && io.writes >= io.failAfter) {
        throw new Error("EIO: simulated append failure");
      }
      io.writes += 1;
      files.set(path, (files.get(path) ?? "") + line + "\n");
    },

    async writeAtomic(path, contents) {
      if (io.failAfter !== undefined && io.writes >= io.failAfter) {
        throw new Error("EIO: simulated atomic write failure");
      }
      io.writes += 1;
      io.atomicWrites += 1;
      files.set(path, contents);
    },

    async remove(path) {
      files.delete(path);
    },

    tearLastLine(path) {
      const contents = files.get(path);
      if (contents === undefined) return;
      const lines = contents.split("\n").filter((l) => l.length > 0);
      const last = lines.pop();
      if (last === undefined) return;
      // Truncate mid-JSON, the way a crash during append would.
      files.set(path, [...lines, last.slice(0, Math.max(1, Math.floor(last.length / 2)))].join("\n") + "\n");
    },
  };

  return io;
}

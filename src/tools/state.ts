import { join } from "node:path";
import { resolveStateDir } from "openclaw/plugin-sdk/state-paths";
import {
  createDeadLetterLog,
  type DeadLetterLog,
} from "../store/deadletter.js";
import { createCursorStore, type CursorStore } from "../store/cursor-store.js";
import { createLedger, type Ledger } from "../store/ledger.js";
import { createFsStoreIo } from "../store/store-io.js";

/**
 * Reads the plugin's state straight from disk.
 *
 * A tool call does not reliably land in the process where the service started:
 * OpenClaw loads the plugin in the CLI process too, so `register()` runs more
 * than once and the in-memory runtime may be absent. The ledger, dead-letter
 * log and cursors are JSONL files under the state directory, and
 * `resolveStateDir()` answers the same path in every process, so a reader can
 * open them wherever it happens to be.
 *
 * Strictly read-only. The Gateway owns these files; a second writer — or the
 * compaction that `load()` would otherwise perform — could corrupt them.
 */

export const PLUGIN_STATE_SUBDIR = "hookdeck";

export interface DiskState {
  ledger: Ledger;
  deadLetter: DeadLetterLog;
  cursors: CursorStore;
  stateDir: string;
}

export function resolvePluginStateDir(): string {
  return join(resolveStateDir(), PLUGIN_STATE_SUBDIR);
}

export async function openDiskState(options: {
  ttlHours: number;
  stateDir?: string;
}): Promise<DiskState> {
  const stateDir = options.stateDir ?? resolvePluginStateDir();
  const io = createFsStoreIo();
  const common = { stateDir, io, readOnly: true as const };

  const [ledger, deadLetter, cursors] = await Promise.all([
    createLedger({
      ttlHours: options.ttlHours,
      // A reader owns no work, so it must never look like the owner of a
      // `running` row — otherwise `listOrphans` would under-report.
      instanceId: "reader",
      ...common,
    }),
    createDeadLetterLog({ ttlHours: options.ttlHours, ...common }),
    createCursorStore(common),
  ]);

  return { ledger, deadLetter, cursors, stateDir };
}

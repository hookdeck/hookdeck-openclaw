import { join } from "node:path";
import { resolveStateDir } from "openclaw/plugin-sdk/state-paths";
import { createDeadLetterLog, type DeadLetterLog } from "../store/deadletter.js";
import { createCursorStore, type CursorStore } from "../store/cursor-store.js";
import { createLedger, type Ledger } from "../store/ledger.js";
import { createFsStoreIo } from "../store/store-io.js";

/**
 * Reads the plugin's state straight from disk.
 *
 * The tools used to depend on the in-memory runtime the service populates,
 * which meant they only worked in the process where the service had started.
 * That is not reliably the process an agent turn runs in — OpenClaw loads the
 * plugin in the CLI process for `openclaw agent`, and a turn logs the plugin's
 * config warnings more than once, so `register()` is plainly running more than
 * once. Every tool would then answer "the service is not running" no matter how
 * healthy the deployment was.
 *
 * The ledger, dead-letter log and cursors are already JSONL files under the
 * state directory, and `resolveStateDir()` answers the same path in any
 * process. So a reader can open them wherever it happens to be, and the
 * question of which process the tool call landed in stops mattering.
 *
 * Strictly read-only: the Gateway owns these files, and a second writer — or
 * the compaction `load()` would otherwise perform — could corrupt them.
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

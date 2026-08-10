import type { HookdeckClient } from "../hookdeck/client.js";
import type { Logger } from "../ingress/handler.js";
import type { HookdeckPluginConfig } from "../plugin/config-types.js";
import type { DeadLetterLog } from "../store/deadletter.js";
import type { CursorStore } from "../store/cursor-store.js";
import type { InFlightRegistry } from "../store/in-flight.js";
import type { Ledger } from "../store/ledger.js";

/**
 * What every tool handler is given, and the few helpers they all share.
 *
 * The view is resolved per call: the live service when the call lands in the
 * Gateway process, otherwise the same state read from disk.
 */

export interface ToolDeps {
  config: HookdeckPluginConfig;
  /** State, read from the live service when in-process, otherwise from disk. */
  ledger: Ledger;
  deadLetter: DeadLetterLog;
  cursors: CursorStore;
  logger: Logger;
  client?: HookdeckClient | undefined;
  configWarnings(): { path: string; message: string }[];
  /**
   * Whether this view came from the running service or from its state files.
   *
   * Reported to the agent rather than hidden: in-flight counts and transport
   * state exist only in the service's memory, so a disk view genuinely cannot
   * know them, and saying "0 in flight" would be a lie rather than a gap.
   */
  source: "live" | "disk";
  /** Live-only. Absent on a disk view. */
  inFlight?: InFlightRegistry | undefined;
  transportStatus?:
    | (() => Record<
        string,
        { state: string; restarts: number; recent: string[] }
      >)
    | undefined;
  retryCancels?: (() => Record<string, number>) | undefined;
  /**
   * Resolves a route's provider verification credentials. Live-only: a disk
   * view has no host secret runtime.
   *
   * `hookdeck_setup` refuses to apply a verified route without this rather than
   * provisioning around it — `PUT /connections` is an upsert, so a spec missing
   * the source auth block would strip verification off a live source.
   */
  resolveVerification?:
    | ((routeId: string) => Promise<Record<string, string> | undefined>)
    | undefined;
  now?(): number;
}

export const NO_CLIENT =
  "No Hookdeck API key is configured, so this needs an operator rather than an agent.";

/** Shortest plan retention, used to decide when to warn about a stale window. */
export const MIN_RETENTION_DAYS = 3;

/**
 * Said wherever Hookdeck answers "no such event".
 *
 * Past retention the event is genuinely gone and no replay will bring it back,
 * which is a different answer from "the id is wrong" — and one an agent would
 * otherwise spend several calls failing to distinguish.
 */
export const RETENTION_NOTE =
  "Either the id is wrong or the event has aged out of retention (3 days on free, 7 on Team, " +
  "30 on Growth). Events past retention cannot be replayed.";

export function requireClient(
  deps: ToolDeps,
): HookdeckClient | { error: string } {
  return deps.client ?? { error: NO_CLIENT };
}

export function isError(value: unknown): value is { error: string } {
  return typeof value === "object" && value !== null && "error" in value;
}

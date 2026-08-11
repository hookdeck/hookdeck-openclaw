import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Which Hookdeck project the CLI is logged into.
 *
 * In `cli` transport "which project" has two independent answers and nothing
 * reconciles them: `hookdeck_setup` provisions in the API key's project, while
 * `hookdeck listen` looks for that connection in whichever project the CLI's
 * own session points at. When they differ the Gateway starts, reports itself
 * healthy, and receives nothing — the tunnel restart-loops on `no connection
 * found matching filter` while every event becomes an ignored
 * `CLI_DISCONNECTED`.
 *
 * The plugin deliberately does not run `hookdeck ci` to force the two together:
 * that rewrites the CLI's global config and switches the active project for
 * every other use on the machine. So the split stays, and the job here is to
 * make it *visible* — `doctor` compares the two and says so.
 *
 * Read from the CLI's own config file rather than by running the CLI: a
 * subcommand against an unauthenticated config prompts interactively, which is
 * not something a diagnostic may do.
 */

export const DEFAULT_CLI_CONFIG_PATH = ".config/hookdeck/config.toml";

export interface CliProject {
  /** The project id the active profile points at, when there is one. */
  projectId?: string;
  /** Which profile was read, for a message that has to be actionable. */
  profile?: string;
  /** Why no project id could be read, when that is the answer. */
  reason?: "no_config" | "no_session" | "unreadable";
}

export function defaultCliConfigPath(home = homedir()): string {
  return join(home, DEFAULT_CLI_CONFIG_PATH);
}

/**
 * Parses the CLI's TOML by hand.
 *
 * The file is flat — a `profile` key and one table per profile — so a real TOML
 * parser would be a dependency bought for six lines of matching, in a plugin
 * whose whole argument is that it does not carry unmaintained ones.
 */
export function parseCliConfig(contents: string): CliProject {
  const activeProfile = /^\s*profile\s*=\s*['"]([^'"]+)['"]/m.exec(
    contents,
  )?.[1];

  // Walked line by line rather than split on tables: a profile with no
  // project_id would otherwise shift every following table's body onto the
  // wrong name, and read the wrong project as a result.
  const tables = new Map<string, string>();
  let current: string | undefined;
  for (const line of contents.split(/\r?\n/)) {
    const table = /^\s*\[([^\]]+)\]\s*$/.exec(line);
    if (table !== null) {
      current = table[1]!.trim();
      continue;
    }
    if (current === undefined) continue;
    const id = /^\s*project_id\s*=\s*['"]([^'"]+)['"]/.exec(line)?.[1];
    if (id !== undefined && !tables.has(current)) tables.set(current, id);
  }

  // The named profile, or the only one there is. Never a guess between
  // several: pointing an operator at the wrong project is the failure this
  // whole check exists to prevent.
  const chosen =
    activeProfile !== undefined
      ? tables.get(activeProfile)
      : tables.size === 1
        ? [...tables.values()][0]
        : undefined;

  if (chosen === undefined) {
    return {
      reason: "no_session",
      ...(activeProfile !== undefined ? { profile: activeProfile } : {}),
    };
  }

  return {
    projectId: chosen,
    ...(activeProfile !== undefined ? { profile: activeProfile } : {}),
  };
}

export async function readCliProject(
  path: string,
  readFile: (p: string) => Promise<string>,
): Promise<CliProject> {
  let contents: string;
  try {
    contents = await readFile(path);
  } catch (err) {
    return {
      reason:
        (err as NodeJS.ErrnoException)?.code === "ENOENT"
          ? "no_config"
          : "unreadable",
    };
  }
  return parseCliConfig(contents);
}

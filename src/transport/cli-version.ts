/**
 * Version gating for the Hookdeck CLI.
 *
 * The floor is not arbitrary. Before 2.3.2 the CLI does not recover an expired
 * WebSocket session: it stays connected, reports itself healthy, and silently
 * stops delivering. That is precisely the failure this plugin exists to prevent,
 * and it is invisible from our side — no error, no reconnect, just nothing
 * arriving. 2.4.0 is the first stable release above that line.
 */
export const MIN_CLI_VERSION = "2.4.0";

export interface ParsedVersion {
  major: number;
  minor: number;
  patch: number;
  prerelease?: string;
}

/** Parses `hookdeck version 2.4.0` / `2.3.0-beta.1` / bare `2.4.0`. */
export function parseCliVersion(output: string): ParsedVersion | undefined {
  const match = /(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?/.exec(output);
  if (match === null) return undefined;
  const [, major, minor, patch, prerelease] = match;
  return {
    major: Number(major),
    minor: Number(minor),
    patch: Number(patch),
    ...(prerelease !== undefined ? { prerelease } : {}),
  };
}

export function compareVersions(a: ParsedVersion, b: ParsedVersion): number {
  if (a.major !== b.major) return a.major - b.major;
  if (a.minor !== b.minor) return a.minor - b.minor;
  if (a.patch !== b.patch) return a.patch - b.patch;
  // A prerelease sorts below its own release: 2.4.0-beta.1 < 2.4.0.
  if (a.prerelease === b.prerelease) return 0;
  if (a.prerelease === undefined) return 1;
  if (b.prerelease === undefined) return -1;
  return comparePrerelease(a.prerelease, b.prerelease);
}

/**
 * Compares prerelease identifiers the way semver does: dot-separated, numeric
 * parts numerically and everything else as text.
 *
 * A plain string compare puts `beta.10` below `beta.9`, which is exactly the
 * range where a version gate has to be right.
 */
function comparePrerelease(a: string, b: string): number {
  const left = a.split(".");
  const right = b.split(".");

  for (let i = 0; i < Math.max(left.length, right.length); i += 1) {
    const x = left[i];
    const y = right[i];
    // A shorter identifier list sorts lower: `beta` < `beta.1`.
    if (x === undefined) return -1;
    if (y === undefined) return 1;

    const xNumeric = /^\d+$/.test(x);
    const yNumeric = /^\d+$/.test(y);
    if (xNumeric && yNumeric) {
      if (Number(x) !== Number(y)) return Number(x) - Number(y);
      continue;
    }
    // Numeric identifiers always sort below alphanumeric ones.
    if (xNumeric !== yNumeric) return xNumeric ? -1 : 1;
    if (x !== y) return x < y ? -1 : 1;
  }

  return 0;
}

export interface VersionCheck {
  ok: boolean;
  version?: ParsedVersion;
  raw: string;
  message?: string;
}

export function checkCliVersion(
  output: string,
  minimum = MIN_CLI_VERSION,
): VersionCheck {
  const version = parseCliVersion(output);
  const floor = parseCliVersion(minimum);
  if (version === undefined || floor === undefined) {
    return {
      ok: false,
      raw: output.trim(),
      message: `could not parse a version from '${output.trim()}'`,
    };
  }
  if (compareVersions(version, floor) < 0) {
    return {
      ok: false,
      version,
      raw: output.trim(),
      message:
        `hookdeck CLI ${formatVersion(version)} is below the required ${minimum}. ` +
        `Versions before 2.3.2 silently stop delivering after a session expires — ` +
        `the failure this plugin exists to prevent. Upgrade with ` +
        `\`brew upgrade hookdeck\` or \`npm i -g hookdeck-cli@latest\`.`,
    };
  }
  return { ok: true, version, raw: output.trim() };
}

export function formatVersion(v: ParsedVersion): string {
  return `${v.major}.${v.minor}.${v.patch}${v.prerelease ? `-${v.prerelease}` : ""}`;
}

/**
 * Warns when several `hookdeck` binaries are on PATH.
 *
 * An npm-global install shadowing a newer Homebrew one is not hypothetical: on
 * this project's own machine a 2.3.0-beta.1 shim masked a 2.4.0 install, so a
 * naive gate would check one binary while the tunnel launched another — exactly
 * the failure the gate exists to prevent.
 */
export function describeShadowing(
  paths: readonly string[],
): string | undefined {
  if (paths.length <= 1) return undefined;
  return (
    `multiple hookdeck binaries on PATH; using ${paths[0]}. ` +
    `Shadowed: ${paths.slice(1).join(", ")}. ` +
    `A version check against one binary means nothing if another is launched.`
  );
}

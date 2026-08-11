import { describe, expect, it, vi } from "vitest";
import {
  defaultCliConfigPath,
  parseCliConfig,
  readCliProject,
} from "../src/transport/cli-project.js";

/**
 * Reading which project the Hookdeck CLI is logged into.
 *
 * This is one half of the mismatch check. Reading the wrong project would be
 * worse than reading none, because it would report a mismatch that is not there
 * — or, worse, silence where one is.
 */

/** The shape the CLI actually writes, values changed. */
const REAL = `profile = 'default'

[default]
api_key = 'redacted'
guest_url = ''
project_id = 'tm_WYrcWDMnjZpG'
project_mode = 'inbound'
project_type = 'Gateway'
`;

describe("parseCliConfig", () => {
  it("reads the active profile's project", () => {
    expect(parseCliConfig(REAL)).toEqual({
      projectId: "tm_WYrcWDMnjZpG",
      profile: "default",
    });
  });

  it("follows the profile pointer rather than taking the first table", () => {
    const two = `profile = 'work'

[default]
project_id = 'tm_personal'

[work]
project_id = 'tm_work'
`;
    expect(parseCliConfig(two).projectId).toBe("tm_work");
  });

  it("is not confused by a profile that has no project", () => {
    // Walked line by line for exactly this: splitting on tables would shift
    // the following body onto the wrong profile name.
    const gappy = `profile = 'work'

[default]
api_key = 'x'

[work]
project_id = 'tm_work'
`;
    expect(parseCliConfig(gappy).projectId).toBe("tm_work");
  });

  it("accepts double quotes and surrounding whitespace", () => {
    expect(
      parseCliConfig('profile = "p"\n\n[p]\n  project_id = "tm_x"\n').projectId,
    ).toBe("tm_x");
  });

  it("handles CRLF line endings", () => {
    expect(parseCliConfig(REAL.replace(/\n/g, "\r\n")).projectId).toBe(
      "tm_WYrcWDMnjZpG",
    );
  });

  it("takes the only profile when none is named", () => {
    expect(parseCliConfig("[solo]\nproject_id = 'tm_solo'\n").projectId).toBe(
      "tm_solo",
    );
  });

  it("refuses to guess between several unnamed profiles", () => {
    const ambiguous = "[a]\nproject_id = 'tm_a'\n\n[b]\nproject_id = 'tm_b'\n";
    expect(parseCliConfig(ambiguous)).toEqual({ reason: "no_session" });
  });

  it("reports no session when the profile holds no project", () => {
    expect(
      parseCliConfig("profile = 'default'\n\n[default]\napi_key = 'x'\n"),
    ).toEqual({
      reason: "no_session",
      profile: "default",
    });
  });

  it("reports no session for an empty file", () => {
    expect(parseCliConfig("")).toEqual({ reason: "no_session" });
  });
});

describe("readCliProject", () => {
  it("distinguishes a missing config from an unreadable one", async () => {
    const enoent = Object.assign(new Error("nope"), { code: "ENOENT" });
    expect(
      await readCliProject("/nowhere", async () => {
        throw enoent;
      }),
    ).toEqual({ reason: "no_config" });

    expect(
      await readCliProject("/denied", async () => {
        throw Object.assign(new Error("nope"), { code: "EACCES" });
      }),
    ).toEqual({ reason: "unreadable" });
  });

  it("reads from the path it is given", async () => {
    const readFile = vi.fn(async () => REAL);
    await readCliProject("/custom/config.toml", readFile);
    expect(readFile).toHaveBeenCalledWith("/custom/config.toml");
  });

  it("defaults to the CLI's own location", () => {
    expect(defaultCliConfigPath("/home/me")).toBe(
      "/home/me/.config/hookdeck/config.toml",
    );
  });
});

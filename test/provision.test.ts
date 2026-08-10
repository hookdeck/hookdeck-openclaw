import { describe, expect, it } from "vitest";
import {
  buildConnectionSpec,
  fingerprint,
  uncoveredStatuses,
  type ProvisionRouteSpec,
} from "../src/hookdeck/provision.js";
import { RETRYABLE_STATUS_CODES } from "../src/protocol/outcome.js";

const cli: ProvisionRouteSpec = {
  routeId: "stripe",
  source: "stripe",
  path: "/hookdeck/stripe",
  kind: "CLI",
};

describe("buildConnectionSpec — the two undocumented requirements", () => {
  it("sends an empty auth object alongside auth_type", () => {
    // The OpenAPI schema does not mark `auth` required; the API answers
    // `422 destination.config.auth is required` without it.
    const spec = buildConnectionSpec(cli);
    const config = spec.destination.config as Record<string, unknown>;
    expect(config.auth_type).toBe("HOOKDECK_SIGNATURE");
    expect(config.auth).toEqual({});
  });

  it("pins path_forwarding_disabled, which defaults to false", () => {
    // Left false, a provider posting to <source-url>/events is delivered to
    // <path>/events.
    const config = buildConnectionSpec(cli).destination.config as Record<string, unknown>;
    expect(config.path_forwarding_disabled).toBe(true);
  });
});

describe("buildConnectionSpec — retry rule", () => {
  it("covers every status the pipeline emits as retryable", () => {
    const rule = buildConnectionSpec(cli).rules.find((r) => r.type === "retry");
    expect(rule?.response_status_codes).toEqual([...RETRYABLE_STATUS_CODES]);
  });

  it("defaults to exponential, not a fixed interval", () => {
    const rule = buildConnectionSpec(cli).rules.find((r) => r.type === "retry");
    expect(rule?.strategy).toBe("exponential");
  });

  it("adds a deduplicate rule only when a window is configured", () => {
    expect(buildConnectionSpec(cli).rules.some((r) => r.type === "deduplicate")).toBe(false);
    const withDedupe = buildConnectionSpec({ ...cli, dedupeWindowMs: 5_000 });
    expect(withDedupe.rules.find((r) => r.type === "deduplicate")).toMatchObject({ window: 5_000 });
  });
});

describe("buildConnectionSpec — destination kinds", () => {
  it("uses path for CLI and never a rate limit", () => {
    // CLI destinations carry no rate_limit field at all.
    const config = buildConnectionSpec({ ...cli, rateLimit: 5 }).destination.config as Record<
      string,
      unknown
    >;
    expect(config.path).toBe("/hookdeck/stripe");
    expect(config.rate_limit).toBeUndefined();
  });

  it("uses url for HTTP and allows a concurrent rate limit", () => {
    const config = buildConnectionSpec({
      ...cli,
      kind: "HTTP",
      url: "https://example.test/hookdeck/stripe",
      rateLimit: 4,
    }).destination.config as Record<string, unknown>;
    expect(config.url).toBe("https://example.test/hookdeck/stripe");
    expect(config.rate_limit).toBe(4);
    // `concurrent` is valid on HTTP and MOCK_API destinations only.
    expect(config.rate_limit_period).toBe("concurrent");
  });

  it("configures provider verification with the current auth_type shape", () => {
    // Not the stale `verification: {type, configs}` shape still in the docs.
    const spec = buildConnectionSpec({
      ...cli,
      sourceAuthType: "STRIPE",
      sourceAuth: { webhook_secret_key: "whsec_x" },
    });
    expect(spec.source.config).toEqual({
      auth_type: "STRIPE",
      auth: { webhook_secret_key: "whsec_x" },
    });
  });

  it("omits source config entirely when no verification is configured", () => {
    expect(buildConnectionSpec(cli).source.config).toBeUndefined();
  });
});

describe("fingerprint", () => {
  it("is stable across key ordering, so reformatting is not a change", () => {
    const a = fingerprint(buildConnectionSpec(cli));
    const b = fingerprint(
      JSON.parse(JSON.stringify(buildConnectionSpec(cli), Object.keys(buildConnectionSpec(cli)).reverse())),
    );
    expect(a).toBe(fingerprint(buildConnectionSpec(cli)));
    expect(typeof b).toBe("string");
  });

  it("changes when the spec meaningfully changes", () => {
    expect(fingerprint(buildConnectionSpec(cli))).not.toBe(
      fingerprint(buildConnectionSpec({ ...cli, path: "/hookdeck/other" })),
    );
  });

  it("is unchanged for an identical spec built twice", () => {
    expect(fingerprint(buildConnectionSpec(cli))).toBe(fingerprint(buildConnectionSpec(cli)));
  });
});

describe("uncoveredStatuses — the doctor check", () => {
  it("reports nothing when the live rule matches what we provision", () => {
    expect(uncoveredStatuses([...RETRYABLE_STATUS_CODES])).toEqual([]);
  });

  it("catches a rule narrowed to server errors only", () => {
    // The exact drift that silently stops retries: we answer 404 expecting a
    // redelivery, and it never comes.
    const missing = uncoveredStatuses(["500-599"]);
    expect(missing).toContain("404");
    expect(missing).toContain("401");
    expect(missing).not.toContain("500-599");
  });

  it("treats an absent rule as covering nothing", () => {
    expect(uncoveredStatuses(undefined).length).toBeGreaterThan(0);
  });

  it("accepts an equivalent server range", () => {
    expect(uncoveredStatuses([...RETRYABLE_STATUS_CODES.filter((c) => c !== "500-599"), "500-599"]))
      .toEqual([]);
  });
});

import { describe, expect, it } from "vitest";
import {
  buildConnectionSpec,
  fingerprint,
  uncoveredStatuses,
  routeProvisionSpec,
  type ProvisionRouteSpec,
} from "../src/hookdeck/provision.js";
import { parseHookdeckConfig } from "../src/plugin/config-parse.js";
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
    const config = buildConnectionSpec(cli).destination.config as Record<
      string,
      unknown
    >;
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
    expect(
      buildConnectionSpec(cli).rules.some((r) => r.type === "deduplicate"),
    ).toBe(false);
    const withDedupe = buildConnectionSpec({ ...cli, dedupeWindowMs: 5_000 });
    expect(
      withDedupe.rules.find((r) => r.type === "deduplicate"),
    ).toMatchObject({ window: 5_000 });
  });
});

describe("buildConnectionSpec — destination kinds", () => {
  it("uses path for CLI and never a rate limit", () => {
    // CLI destinations carry no rate_limit field at all.
    const config = buildConnectionSpec({ ...cli, rateLimit: 5 }).destination
      .config as Record<string, unknown>;
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
    // The previous version of this test compared a spec against itself and
    // asserted the other value was a string, which proved nothing. Build a
    // genuinely reordered object instead.
    const spec = buildConnectionSpec(cli);
    const reordered = {
      rules: spec.rules,
      destination: {
        config: spec.destination.config,
        name: spec.destination.name,
        type: spec.destination.type,
      },
      source: spec.source,
      name: spec.name,
    } as unknown as typeof spec;
    expect(fingerprint(reordered)).toBe(fingerprint(spec));
  });

  it("ignores undefined-valued keys", () => {
    const spec = buildConnectionSpec(cli);
    expect(
      fingerprint({ ...spec, extra: undefined } as unknown as typeof spec),
    ).toBe(fingerprint(spec));
  });

  it("changes when the spec meaningfully changes", () => {
    expect(fingerprint(buildConnectionSpec(cli))).not.toBe(
      fingerprint(buildConnectionSpec({ ...cli, path: "/hookdeck/other" })),
    );
  });

  it("is unchanged for an identical spec built twice", () => {
    expect(fingerprint(buildConnectionSpec(cli))).toBe(
      fingerprint(buildConnectionSpec(cli)),
    );
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
    expect(
      uncoveredStatuses([
        ...RETRYABLE_STATUS_CODES.filter((c) => c !== "500-599"),
        "500-599",
      ]),
    ).toEqual([]);
  });
});

describe("we use Hookdeck's own features rather than only our local copies", () => {
  const base = () => {
    const parsed = parseHookdeckConfig({
      signingSecret: "whsec",
      maxConcurrent: 7,
      transport: { mode: "http", publicUrl: "https://gw.example.com" },
      routes: {
        stripe: {
          source: "stripe",
          dispatch: { mode: "wake", sessionKey: "main" },
        },
      },
    });
    if (!parsed.ok) throw new Error(JSON.stringify(parsed.problems));
    return parsed.config;
  };

  it("pushes maxConcurrent into the destination in HTTP mode", () => {
    // Hookdeck paces delivery natively; local admission control has to answer
    // 503, which spends one of the event's finite attempts to say "not now".
    const config = base();
    const spec = buildConnectionSpec(
      routeProvisionSpec({
        config,
        routeId: "stripe",
        route: config.routes.stripe!,
      }),
    );
    const destination = spec.destination.config as Record<string, unknown>;
    expect(destination.rate_limit).toBe(7);
    expect(destination.rate_limit_period).toBe("concurrent");
  });

  it("omits it in CLI mode, where the field does not exist", () => {
    const config = {
      ...base(),
      transport: { ...base().transport, mode: "cli" as const },
    };
    const spec = buildConnectionSpec(
      routeProvisionSpec({
        config,
        routeId: "stripe",
        route: config.routes.stripe!,
      }),
    );
    expect(spec.destination.config).not.toHaveProperty("rate_limit");
  });

  it("carries provider verification into the spec, so a source is never silently opened", () => {
    // PUT /connections is an upsert. A spec built without the source auth
    // block turns a verified Stripe source into an open endpoint.
    const config = base();
    const route = {
      ...config.routes.stripe!,
      verification: { provider: "STRIPE", credentials: {} },
    };
    const spec = buildConnectionSpec(
      routeProvisionSpec({
        config,
        routeId: "stripe",
        route,
        credentials: { webhook_secret: "s" },
      }),
    );
    expect(spec.source.config).toMatchObject({
      auth_type: "STRIPE",
      auth: { webhook_secret: "s" },
    });
  });

  it("gives the same fingerprint from either caller for the same route", () => {
    // The setup tool and the service must produce byte-identical specs, or
    // the fingerprint changes and every dry run reports a phantom diff.
    const config = base();
    const route = config.routes.stripe!;
    const a = fingerprint(
      buildConnectionSpec(
        routeProvisionSpec({ config, routeId: "stripe", route }),
      ),
    );
    const b = fingerprint(
      buildConnectionSpec(
        routeProvisionSpec({ config, routeId: "stripe", route }),
      ),
    );
    expect(a).toBe(b);
  });
});

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  matchRoute,
  normalisePath,
  parseHookdeckConfig,
} from "../src/plugin/config-parse.js";

function parseOk(raw: unknown) {
  const result = parseHookdeckConfig(raw);
  if (!result.ok)
    throw new Error(`expected ok, got ${JSON.stringify(result.problems)}`);
  return result;
}

const ROUTE = {
  source: "stripe",
  dispatch: { mode: "wake", sessionKey: "main" },
};

describe("normalisePath", () => {
  it.each([
    ["stripe", "/stripe"],
    ["/stripe", "/stripe"],
    ["/stripe/", "/stripe"],
    ["/stripe///", "/stripe"],
    ["/", ""],
  ])("%s -> %s", (input, expected) => {
    expect(normalisePath(input)).toBe(expected);
  });
});

describe("parseHookdeckConfig — defaults", () => {
  it("applies documented defaults to an empty config", () => {
    const { config } = parseOk({});
    expect(config).toMatchObject({
      headerPrefix: "x-hookdeck",
      ingress: { basePath: "/hookdeck" },
      maxConcurrent: 4,
      busyRetryAfterSeconds: 10,
      dedupe: { ttlHours: 168 },
      safety: { allowRetryCancel: false },
      routes: {},
    });
  });

  it("defaults allowRetryCancel to false", () => {
    // Off by default so wire behaviour matches the sibling plugins.
    expect(parseOk({}).config.safety.allowRetryCancel).toBe(false);
  });

  it("keeps the ledger TTL above Hookdeck's one-week retry ceiling", () => {
    expect(parseOk({}).config.dedupe.ttlHours).toBeGreaterThanOrEqual(168);
  });

  it("defaults a route path to its route id", () => {
    expect(
      parseOk({ routes: { stripe: ROUTE } }).config.routes.stripe?.path,
    ).toBe("/stripe");
  });

  it("normalises the header prefix", () => {
    expect(parseOk({ headerPrefix: "X-ACME-" }).config.headerPrefix).toBe(
      "x-acme",
    );
  });
});

describe("parseHookdeckConfig — problems", () => {
  it("never throws on malformed input", () => {
    expect(() => parseHookdeckConfig({ routes: "nope" })).not.toThrow();
    expect(parseHookdeckConfig({ routes: "nope" }).ok).toBe(false);
  });

  it("handles null and undefined", () => {
    expect(parseHookdeckConfig(undefined).ok).toBe(true);
    expect(parseHookdeckConfig(null).ok).toBe(true);
  });

  it("rejects a basePath of '/' — it would capture every Gateway request", () => {
    const result = parseHookdeckConfig({ ingress: { basePath: "/" } });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.problems[0]?.path).toBe("ingress.basePath");
  });

  it("rejects two routes resolving to the same path", () => {
    const result = parseHookdeckConfig({
      routes: {
        a: { ...ROUTE, path: "/same" },
        b: { ...ROUTE, path: "/same" },
      },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.problems[0]?.message).toMatch(/collides/);
  });

  it("requires a source", () => {
    expect(
      parseHookdeckConfig({
        routes: { s: { dispatch: { mode: "wake", sessionKey: "m" } } },
      }).ok,
    ).toBe(false);
  });

  it("requires a sessionKey for wake dispatch", () => {
    // enqueueSystemEvent throws without one, so this must fail at parse time.
    expect(
      parseHookdeckConfig({
        routes: { s: { source: "x", dispatch: { mode: "wake" } } },
      }).ok,
    ).toBe(false);
  });

  it("rejects an unknown dispatch mode", () => {
    expect(
      parseHookdeckConfig({
        routes: {
          s: { source: "x", dispatch: { mode: "agent", sessionKey: "m" } },
        },
      }).ok,
    ).toBe(false);
  });
});

describe("parseHookdeckConfig — warnings", () => {
  it("warns when a route has no signing secret anywhere", () => {
    const { warnings } = parseOk({ routes: { stripe: ROUTE } });
    expect(warnings.some((w) => w.path === "routes.stripe.signingSecret")).toBe(
      true,
    );
  });

  it("does not warn when a top-level secret covers the route", () => {
    const { warnings } = parseOk({
      signingSecret: "whsec",
      routes: { stripe: ROUTE },
    });
    expect(warnings.some((w) => w.path.endsWith("signingSecret"))).toBe(false);
  });

  it("accepts a secretRef object as a signing secret", () => {
    const ref = {
      source: "env",
      provider: "env",
      id: "HOOKDECK_SIGNING_SECRET",
    };
    const { config } = parseOk({
      signingSecret: ref,
      routes: { stripe: ROUTE },
    });
    expect(config.signingSecret).toEqual(ref);
  });

  it("requires 'provider' on a secretRef, matching OpenClaw's own schema", () => {
    // The host's secret-input schema marks all three fields required and is
    // strict. Accepting a laxer shape here would pass configs the host rejects.
    expect(
      parseHookdeckConfig({ signingSecret: { source: "env", id: "SECRET" } })
        .ok,
    ).toBe(false);
  });

  it("rejects unknown keys on a secretRef", () => {
    expect(
      parseHookdeckConfig({
        signingSecret: { source: "env", provider: "env", id: "S", extra: true },
      }).ok,
    ).toBe(false);
  });

  it("warns when there are no routes at all", () => {
    expect(parseOk({}).warnings.some((w) => w.path === "routes")).toBe(true);
  });

  it("warns about a disabled route", () => {
    const { warnings } = parseOk({
      signingSecret: "s",
      routes: { stripe: { ...ROUTE, enabled: false } },
    });
    expect(warnings.some((w) => w.message === "route is disabled")).toBe(true);
  });
});

describe("matchRoute", () => {
  const { config } = parseOk({
    signingSecret: "s",
    routes: {
      stripe: ROUTE,
      github: { ...ROUTE, source: "github", path: "/gh" },
      off: { ...ROUTE, source: "x", path: "/off", enabled: false },
    },
  });

  it("matches on the full base + route path", () => {
    expect(matchRoute(config, "/hookdeck/stripe")?.routeId).toBe("stripe");
    expect(matchRoute(config, "/hookdeck/gh")?.routeId).toBe("github");
  });

  it("tolerates a trailing slash", () => {
    expect(matchRoute(config, "/hookdeck/stripe/")?.routeId).toBe("stripe");
  });

  it("does not match the base path alone", () => {
    expect(matchRoute(config, "/hookdeck")).toBeUndefined();
  });

  it("does not match a disabled route", () => {
    expect(matchRoute(config, "/hookdeck/off")).toBeUndefined();
  });

  it("does not match an unknown path", () => {
    expect(matchRoute(config, "/hookdeck/unknown")).toBeUndefined();
  });
});

describe("matchRoute — Hookdeck path forwarding", () => {
  const { config } = parseOk({
    signingSecret: "s",
    routes: {
      stripe: ROUTE,
      stripeRefunds: { ...ROUTE, path: "/stripe/refunds" },
    },
  });

  it("matches a sub-path, because Hookdeck appends the source request path", () => {
    // path_forwarding_disabled defaults to false.
    expect(matchRoute(config, "/hookdeck/stripe/events")?.routeId).toBe(
      "stripe",
    );
    expect(matchRoute(config, "/hookdeck/stripe/a/b/c")?.routeId).toBe(
      "stripe",
    );
  });

  it("prefers the longest configured route path", () => {
    expect(matchRoute(config, "/hookdeck/stripe/refunds")?.routeId).toBe(
      "stripeRefunds",
    );
    expect(matchRoute(config, "/hookdeck/stripe/refunds/extra")?.routeId).toBe(
      "stripeRefunds",
    );
  });

  it("does not treat a longer sibling name as a sub-path", () => {
    // A bare string prefix would wrongly match route `stripe` here.
    expect(matchRoute(config, "/hookdeck/stripe-test")).toBeUndefined();
  });
});

describe("the manifest schema and the config parser must agree", () => {
  // The host validates plugin config against `configSchema` with
  // additionalProperties: false, and REFUSES TO START the whole Gateway on a
  // key it does not know. `tools` was implemented, parsed, documented in the
  // README — and missing from the schema, so any operator who set
  // `tools.allowMutations` got "Gateway failed to start: must not have
  // additional properties". Found by setting it, not by reading anything.
  const manifest = JSON.parse(
    readFileSync(new URL("../openclaw.plugin.json", import.meta.url), "utf8"),
  ) as {
    configSchema: {
      additionalProperties?: boolean;
      properties: Record<string, { properties?: Record<string, unknown> }>;
    };
  };

  it("declares every key the parser produces", () => {
    const parsed = parseHookdeckConfig({
      signingSecret: "whsec",
      routes: {
        a: { source: "a", dispatch: { mode: "wake", sessionKey: "m" } },
      },
    });
    if (!parsed.ok) throw new Error("fixture should parse");

    const declared = new Set(Object.keys(manifest.configSchema.properties));
    const missing = Object.keys(parsed.config).filter((k) => !declared.has(k));
    expect(
      missing,
      "config keys absent from openclaw.plugin.json configSchema",
    ).toEqual([]);
  });

  it("declares nothing the parser would reject", () => {
    // The other direction: a schema key with no parser support is config an
    // operator can set that silently does nothing.
    const declared = Object.keys(manifest.configSchema.properties);
    const parsed = parseHookdeckConfig({
      signingSecret: "whsec",
      routes: {
        a: { source: "a", dispatch: { mode: "wake", sessionKey: "m" } },
      },
    });
    if (!parsed.ok) throw new Error("fixture should parse");

    const known = new Set([
      ...Object.keys(parsed.config),
      "signingSecret",
      "apiKey",
    ]);
    expect(declared.filter((k) => !known.has(k))).toEqual([]);
  });

  it("accepts tools.allowMutations in both the parser and the schema", () => {
    const parsed = parseHookdeckConfig({
      signingSecret: "whsec",
      tools: { allowMutations: false },
      routes: {
        a: { source: "a", dispatch: { mode: "wake", sessionKey: "m" } },
      },
    });
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.config.tools.allowMutations).toBe(false);
    expect(manifest.configSchema.properties.tools?.properties).toHaveProperty(
      "allowMutations",
    );
  });
});

describe("validation that runs late still rejects", () => {
  // Every rule must run before the first `ok: false` return, or a check placed
  // after it silently never fires.
  const base = {
    signingSecret: "whsec",
    routes: { s: { source: "s", dispatch: { mode: "wake", sessionKey: "m" } } },
  };

  it("rejects provisioning without an apiKey", () => {
    const result = parseHookdeckConfig({
      ...base,
      provisioning: { enabled: true },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.problems.map((p) => p.path)).toContain(
        "provisioning.enabled",
      );
    }
  });

  it("rejects http transport without a publicUrl", () => {
    const result = parseHookdeckConfig({
      ...base,
      transport: { mode: "http" },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.problems.map((p) => p.path)).toContain(
        "transport.publicUrl",
      );
    }
  });

  it("still reports an early problem when a late rule also fails", () => {
    const result = parseHookdeckConfig({
      ingress: { basePath: "/" },
      transport: { mode: "http" },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      const paths = result.problems.map((p) => p.path);
      expect(paths).toContain("ingress.basePath");
      expect(paths).toContain("transport.publicUrl");
    }
  });
});

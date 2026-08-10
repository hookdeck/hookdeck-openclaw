import { describe, expect, it } from "vitest";
import { matchRoute, normalisePath, parseHookdeckConfig } from "../src/plugin/config-parse.js";

function parseOk(raw: unknown) {
  const result = parseHookdeckConfig(raw);
  if (!result.ok) throw new Error(`expected ok, got ${JSON.stringify(result.problems)}`);
  return result;
}

const ROUTE = { source: "stripe", dispatch: { mode: "wake", sessionKey: "main" } };

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
    expect(parseOk({ routes: { stripe: ROUTE } }).config.routes.stripe?.path).toBe("/stripe");
  });

  it("normalises the header prefix", () => {
    expect(parseOk({ headerPrefix: "X-ACME-" }).config.headerPrefix).toBe("x-acme");
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
      routes: { a: { ...ROUTE, path: "/same" }, b: { ...ROUTE, path: "/same" } },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.problems[0]?.message).toMatch(/collides/);
  });

  it("requires a source", () => {
    expect(
      parseHookdeckConfig({ routes: { s: { dispatch: { mode: "wake", sessionKey: "m" } } } }).ok,
    ).toBe(false);
  });

  it("requires a sessionKey for wake dispatch", () => {
    // enqueueSystemEvent throws without one, so this must fail at parse time.
    expect(parseHookdeckConfig({ routes: { s: { source: "x", dispatch: { mode: "wake" } } } }).ok).toBe(
      false,
    );
  });

  it("rejects an unknown dispatch mode", () => {
    expect(
      parseHookdeckConfig({
        routes: { s: { source: "x", dispatch: { mode: "agent", sessionKey: "m" } } },
      }).ok,
    ).toBe(false);
  });
});

describe("parseHookdeckConfig — warnings", () => {
  it("warns when a route has no signing secret anywhere", () => {
    const { warnings } = parseOk({ routes: { stripe: ROUTE } });
    expect(warnings.some((w) => w.path === "routes.stripe.signingSecret")).toBe(true);
  });

  it("does not warn when a top-level secret covers the route", () => {
    const { warnings } = parseOk({ signingSecret: "whsec", routes: { stripe: ROUTE } });
    expect(warnings.some((w) => w.path.endsWith("signingSecret"))).toBe(false);
  });

  it("accepts a secretRef object as a signing secret", () => {
    const ref = { source: "env", provider: "env", id: "HOOKDECK_SIGNING_SECRET" };
    const { config } = parseOk({ signingSecret: ref, routes: { stripe: ROUTE } });
    expect(config.signingSecret).toEqual(ref);
  });

  it("requires 'provider' on a secretRef, matching OpenClaw's own schema", () => {
    // The host's secret-input schema marks all three fields required and is
    // strict. Accepting a laxer shape here would pass configs the host rejects.
    expect(
      parseHookdeckConfig({ signingSecret: { source: "env", id: "SECRET" } }).ok,
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

import { describe, expect, it } from "vitest";
import plugin from "../index.js";

/**
 * What the plugin does when its own config is invalid.
 *
 * A Gateway that will not boot is worse than one that is not configured, so
 * nothing throws — but the ingress must still hold events rather than 404 them,
 * and the failure has to be visible to whoever asks.
 */

interface Registered {
  path: string;
  handler: (req: unknown, res: MockResponse) => boolean;
}

class MockResponse {
  statusCode = 0;
  headers: Record<string, string> = {};
  body = "";
  setHeader(name: string, value: string) {
    this.headers[name.toLowerCase()] = value;
  }
  end(payload: string) {
    this.body = payload;
  }
}

function register(pluginConfig: unknown) {
  const routes: Registered[] = [];
  const tools: {
    name: string;
    execute: (id: string, p: unknown) => Promise<unknown>;
  }[] = [];
  const errors: string[] = [];

  const api = {
    pluginConfig,
    logger: {
      error: (m: string) => errors.push(m),
      warn: () => {},
      info: () => {},
      debug: () => {},
    },
    registerHttpRoute: (route: Registered) => routes.push(route),
    registerTool: (tool: {
      name: string;
      execute: (id: string, p: unknown) => Promise<unknown>;
    }) => tools.push(tool),
    registerService: () => {},
    runtime: {},
  };

  plugin.register?.(api as never);
  return { routes, tools, errors };
}

const BAD = { ingress: { basePath: "/" } };

describe("the config-error fallback route", () => {
  it("holds events with a retryable 503 rather than 404ing them", () => {
    const { routes } = register(BAD);
    expect(routes).toHaveLength(1);

    const res = new MockResponse();
    routes[0]!.handler({}, res);

    expect(res.statusCode).toBe(503);
    expect(res.headers["retry-after"]).toBeTruthy();
    expect(JSON.parse(res.body)).toMatchObject({ code: "config_error" });
  });

  it("refuses a basePath of '/', which would capture every Gateway request", () => {
    // The invalid part of the config may BE the basePath, so it cannot be
    // trusted here of all places.
    expect(register(BAD).routes[0]!.path).toBe("/hookdeck");
  });

  it("uses a valid custom basePath, so a moved ingress still holds events", () => {
    const { routes } = register({
      ingress: { basePath: "/webhooks/in" },
      routes: { a: { source: "a", dispatch: { mode: "nonsense" } } },
    });
    expect(routes[0]!.path).toBe("/webhooks/in");
  });

  it("falls back when the basePath is not a string or not rooted", () => {
    for (const basePath of [42, "no-leading-slash", "", "///"]) {
      const { routes } = register({
        ingress: { basePath },
        routes: { a: { source: "a", dispatch: { mode: "nonsense" } } },
      });
      expect(routes[0]!.path, String(basePath)).toBe("/hookdeck");
    }
  });

  it("logs each problem so the operator can see what to fix", () => {
    expect(register(BAD).errors.join("\n")).toMatch(/basePath/);
  });
});

describe("the config-error tool surface", () => {
  it("still registers hookdeck_status", async () => {
    // A config error is exactly when someone asks "are webhooks working?".
    const { tools } = register(BAD);
    expect(tools.map((t) => t.name)).toEqual(["hookdeck_status"]);
  });

  it("answers with the problems rather than a generic failure", async () => {
    const { tools } = register(BAD);
    const result = (await tools[0]!.execute("call_1", {})) as {
      content: { text: string }[];
    };
    const payload = JSON.parse(result.content[0]!.text) as {
      ok: boolean;
      code: string;
      problems: { path: string }[];
    };

    expect(payload.ok).toBe(false);
    expect(payload.code).toBe("config_error");
    expect(payload.problems.map((p) => p.path)).toContain("ingress.basePath");
  });

  it("registers nothing extra when the config is valid", () => {
    const { tools, routes } = register({
      signingSecret: "whsec",
      routes: {
        a: { source: "a", dispatch: { mode: "wake", sessionKey: "m" } },
      },
    });
    expect(tools.length).toBeGreaterThan(1);
    expect(routes).toHaveLength(1);
  });
});

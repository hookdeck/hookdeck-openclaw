import { readFile } from "node:fs/promises";
import { describe, expect, it, vi } from "vitest";
import {
  ALL_TOOL_NAMES,
  READ_TOOL_NAMES,
  registerHookdeckTools,
} from "../src/tools/index.js";
import type { ToolDeps } from "../src/tools/handlers.js";
import { parseHookdeckConfig } from "../src/plugin/config-parse.js";
import { createCursorStore } from "../src/store/cursor-store.js";
import { createDeadLetterLog } from "../src/store/deadletter.js";
import { createInFlightRegistry } from "../src/store/in-flight.js";
import { createMemoryLedger } from "../src/store/ledger.js";
import { createFakeStoreIo } from "./fakes/fake-store-io.js";

/**
 * Drives the tools the way the host does — through `registerHookdeckTools`,
 * capturing what is handed to `registerTool`, then invoking `execute`.
 *
 * The handler tests call `statusHandler` and friends directly, which skips
 * everything in between: the registration list, the `wrap()` layer, the
 * not-started path, and the `deps()` closure. That gap is exactly where M5
 * shipped broken — every tool was refused by the host and every handler test
 * still passed.
 */

interface CapturedTool {
  name: string;
  label: string;
  description: string;
  parameters: {
    type?: string;
    properties?: Record<string, unknown>;
    required?: string[];
  };
  execute: (
    toolCallId: string,
    params: unknown,
  ) => Promise<{ content: unknown[]; details: unknown }>;
}

/** Tool results are AgentToolResults; the payload is JSON inside `content`. */
function unwrap(result: { content: unknown[] }): unknown {
  const first = result.content[0] as { text?: string } | undefined;
  return first?.text === undefined ? undefined : JSON.parse(first.text);
}

function captureTools(options: {
  allowMutations?: boolean;
  deps?: () => Promise<ToolDeps | undefined> | ToolDeps | undefined;
}): { tools: CapturedTool[]; warnings: string[] } {
  const tools: CapturedTool[] = [];
  const warnings: string[] = [];
  const api = {
    registerTool: (tool: CapturedTool) => tools.push(tool),
    logger: { warn: (m: string) => warnings.push(m), info: () => {} },
  };

  registerHookdeckTools(api as never, {
    allowMutations: options.allowMutations ?? true,
    deps: options.deps ?? (() => undefined),
  });
  return { tools, warnings };
}

async function liveDeps(): Promise<ToolDeps> {
  const parsed = parseHookdeckConfig({
    signingSecret: "whsec",
    routes: {
      stripe: {
        source: "stripe",
        dispatch: { mode: "wake", sessionKey: "main" },
      },
    },
  });
  if (!parsed.ok) throw new Error("bad fixture");
  const io = createFakeStoreIo();
  return {
    config: parsed.config,
    source: "live" as const,
    ledger: createMemoryLedger({ ttlHours: 168, instanceId: "test" }),
    deadLetter: await createDeadLetterLog({ ttlHours: 168 }),
    cursors: await createCursorStore({ stateDir: "/state", io }),
    inFlight: createInFlightRegistry(4),
    logger: { debug: () => {}, info: () => {}, warn: () => {} },
    client: undefined,
    transportStatus: () => ({}),
    retryCancels: () => ({}),
    configWarnings: () => parsed.warnings,
  };
}

describe("tool registration — the AgentTool contract", () => {
  it("gives every tool the required label", () => {
    // `AgentTool` requires `label`. Without it the host accepts the
    // registration and the agent never sees the tool — which is exactly how
    // M5 shipped: 7 declared, 0 rejections, and the model reporting it had no
    // hookdeck tools available.
    for (const tool of captureTools({}).tools) {
      expect(tool.label, tool.name).toBeTruthy();
      expect(typeof tool.label).toBe("string");
    }
  });

  it("uses the erased execute signature (toolCallId first), not (params)", () => {
    for (const tool of captureTools({}).tools) {
      expect(
        tool.execute.length,
        `${tool.name} execute arity`,
      ).toBeGreaterThanOrEqual(2);
    }
  });

  it("returns an AgentToolResult rather than a bare value", async () => {
    const { tools } = captureTools({});
    const result = await tools[0]!.execute("call_1", {});
    expect(Array.isArray(result.content)).toBe(true);
    expect(result).toHaveProperty("details");
  });
});

describe("tool registration", () => {
  it("registers exactly the names the manifest contract declares", () => {
    const { tools } = captureTools({});
    expect(tools.map((t) => t.name).sort()).toEqual([...ALL_TOOL_NAMES].sort());
  });

  it("drops the mutating tools when allowMutations is false", () => {
    const { tools } = captureTools({ allowMutations: false });
    expect(tools.map((t) => t.name).sort()).toEqual(
      [...READ_TOOL_NAMES].sort(),
    );
    expect(tools.map((t) => t.name)).not.toContain("hookdeck_pause");
  });

  it("gives every tool a JSON-schema parameter object the host can validate", () => {
    for (const tool of captureTools({}).tools) {
      expect(tool.parameters.type, `${tool.name} parameters`).toBe("object");
      expect(
        tool.description.length,
        `${tool.name} description`,
      ).toBeGreaterThan(40);
    }
  });

  it("marks only genuinely required parameters as required", () => {
    const tools = captureTools({}).tools;
    const inspect = tools.find((t) => t.name === "hookdeck_inspect_event")!;
    expect(inspect.parameters.required).toEqual(["eventId"]);

    // status must be callable with no arguments at all — it is the entry point.
    const status = tools.find((t) => t.name === "hookdeck_status")!;
    expect(status.parameters.required ?? []).toEqual([]);
  });

  it("warns rather than throwing if the host refuses a tool", () => {
    const warnings: string[] = [];
    const api = {
      registerTool: () => {
        throw new Error("nope");
      },
      logger: { warn: (m: string) => warnings.push(m), info: () => {} },
    };
    expect(() =>
      registerHookdeckTools(api as never, {
        allowMutations: true,
        deps: () => undefined,
      }),
    ).not.toThrow();
    expect(warnings.length).toBe(ALL_TOOL_NAMES.length);
  });
});

describe("tool execution through the registered surface", () => {
  it("explains that it needs a running Gateway rather than throwing", async () => {
    const { tools } = captureTools({ deps: () => undefined });
    for (const tool of tools) {
      const result = unwrap(await tool.execute("call_1", {})) as {
        ok: boolean;
        note?: string;
      };
      expect(result.ok, tool.name).toBe(false);
      expect(result.note, tool.name).toMatch(/running Gateway/i);
    }
  });

  it("runs status end to end once started", async () => {
    const deps = await liveDeps();
    const { tools } = captureTools({ deps: () => deps });
    const status = tools.find((t) => t.name === "hookdeck_status")!;

    const result = unwrap(await status.execute("call_1", {})) as {
      routes: { routeId: string }[];
      ledger: { persistence: string };
      configWarnings: unknown[];
    };
    expect(result.routes[0]?.routeId).toBe("stripe");
    expect(result.ledger.persistence).toBe("off");
  });

  it("runs doctor end to end and reports the missing API key", async () => {
    const deps = await liveDeps();
    const { tools } = captureTools({ deps: () => deps });
    const doctor = tools.find((t) => t.name === "hookdeck_doctor")!;

    const result = unwrap(await doctor.execute("call_1", {})) as {
      ok: boolean;
      checks: { name: string; ok: boolean }[];
    };
    expect(result.ok).toBe(false);
    expect(result.checks.find((c) => c.name === "api key")?.ok).toBe(false);
  });

  it("turns a handler throwing into an explanation, not a crashed tool call", async () => {
    const deps = await liveDeps();
    // A tool that throws is a worse experience for a model than one that says
    // what went wrong.
    deps.ledger = {
      ...deps.ledger,
      stats: () => {
        throw new Error("disk gone");
      },
    } as typeof deps.ledger;

    const { tools } = captureTools({ deps: () => deps });
    const status = tools.find((t) => t.name === "hookdeck_status")!;
    const result = unwrap(await status.execute("call_1", {})) as {
      ok: boolean;
      error: string;
    };

    expect(result.ok).toBe(false);
    expect(result.error).toContain("disk gone");
  });

  it("explains rather than acting when a mutating tool has no API key", async () => {
    const deps = await liveDeps();
    const { tools } = captureTools({ deps: () => deps });

    for (const name of [
      "hookdeck_setup",
      "hookdeck_pause",
      "hookdeck_replay",
    ]) {
      const tool = tools.find((t) => t.name === name)!;
      const result = unwrap(
        await tool.execute("call_1", { routeId: "stripe", paused: true }),
      ) as {
        note?: string;
      };
      expect(String(result.note), name).toMatch(/API key/i);
    }
  });
});

describe("tool descriptions carry the safety rails a model needs", () => {
  const tools = captureTools({}).tools;
  const describe_ = (name: string) =>
    tools.find((t) => t.name === name)!.description;

  it("tells the model replay is a dry run until confirmed", () => {
    expect(describe_("hookdeck_replay")).toMatch(/dry run unless confirm/i);
  });

  it("tells the model pause holds rather than drops, and is not for load", () => {
    const text = describe_("hookdeck_pause");
    expect(text).toMatch(/nothing is dropped/i);
    expect(text).toMatch(/not\s+.*for transient load/i);
  });

  it("tells the model setup defaults to a dry run", () => {
    expect(describe_("hookdeck_setup")).toMatch(/dry run/i);
  });

  it("points the model at status first", () => {
    expect(describe_("hookdeck_status")).toMatch(/start here/i);
  });
});

describe("hookdeck_issues is actually reachable", () => {
  it("is declared in the manifest contract, without which the host silently registers nothing", async () => {
    const manifest = JSON.parse(
      await readFile(
        new URL("../openclaw.plugin.json", import.meta.url),
        "utf8",
      ),
    ) as { contracts: { tools: string[] } };
    expect([...manifest.contracts.tools].sort()).toEqual(
      [...ALL_TOOL_NAMES].sort(),
    );
  });

  it("is a mutating tool, so allowMutations: false removes it", () => {
    const { tools } = captureTools({ allowMutations: false });
    expect(tools.map((t) => t.name)).not.toContain("hookdeck_issues");
  });

  it("tells the model that clearing an issue is not the same as replaying it", () => {
    const tool = captureTools({}).tools.find(
      (t) => t.name === "hookdeck_issues",
    )!;
    expect(tool.description).toMatch(/dead-letter queue/i);
    expect(tool.description).toMatch(/none of these replay/i);
  });

  it("defaults to listing rather than requiring an action", () => {
    const tool = captureTools({}).tools.find(
      (t) => t.name === "hookdeck_issues",
    )!;
    expect(tool.parameters.required ?? []).toEqual([]);
  });
});

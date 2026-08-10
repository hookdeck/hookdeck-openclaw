import { jsonResult } from "openclaw/plugin-sdk/core";
import { Type } from "typebox";
import type { OpenClawPluginApi } from "../plugin/host-api.js";
import {
  doctorHandler,
  inspectEventHandler,
  issuesHandler,
  pauseHandler,
  recentDeliveriesHandler,
  replayHandler,
  setupHandler,
  statusHandler,
  type ToolDeps,
} from "./handlers.js";

/**
 * Registers the operator surface as agent tools.
 *
 * The five verbs match the shared reliability contract — `setup`, `status`,
 * `pause`/`resume`, `replay`, `doctor` — so someone who learns one plugin
 * already knows the others. Two additional read tools exist because an agent
 * host benefits from correlated triage in a way a CLI does not.
 *
 * `tools.allowMutations: false` reduces the surface to the read tools, for
 * operators who want an agent that can diagnose but not act.
 */

/**
 * Every tool this plugin can register.
 *
 * Exported so a test can assert the manifest's `contracts.tools` matches. The
 * host refuses `registerTool` for any name absent from that contract, and it
 * LOGS the refusal rather than throwing — so a plugin that adds a tool and
 * forgets the manifest looks entirely healthy while registering nothing.
 */
export const READ_TOOL_NAMES = [
  "hookdeck_status",
  "hookdeck_recent_deliveries",
  "hookdeck_inspect_event",
  "hookdeck_doctor",
] as const;

export const MUTATION_TOOL_NAMES = [
  "hookdeck_setup",
  "hookdeck_pause",
  "hookdeck_replay",
  // Mutating because acknowledge/resolve/dismiss change what the whole project
  // sees. `action: "list"` is read-only, but a tool is registered or not, and
  // splitting one verb across both surfaces would be worse than losing the
  // listing when mutations are off — `hookdeck_recent_deliveries` still shows
  // open issues.
  "hookdeck_issues",
] as const;

export const ALL_TOOL_NAMES = [
  ...READ_TOOL_NAMES,
  ...MUTATION_TOOL_NAMES,
] as const;

export interface RegisterToolsOptions {
  allowMutations: boolean;
  /**
   * Resolves the state view for one call: the live service when in-process,
   * otherwise the same state read from disk.
   */
  deps(): Promise<ToolDeps | undefined> | ToolDeps | undefined;
  schedule?(fn: () => void, ms: number): void;
}

const NOT_STARTED = {
  ok: false,
  note:
    "No Hookdeck plugin state is readable: the service is not running in this process and its " +
    "state files could not be opened. If `storage.enabled` is false there is nothing to read " +
    "outside the running Gateway; otherwise check the state directory is accessible.",
};

export function registerHookdeckTools(
  api: OpenClawPluginApi,
  options: RegisterToolsOptions,
): void {
  // `AgentTool.execute` is `(toolCallId, params, signal?, onUpdate?)` and must
  // resolve to an AgentToolResult — not the bare value a handler returns.
  // Getting either wrong produces a tool the host accepts and the agent never
  // sees, which is exactly how this shipped the first time.
  const wrap =
    <P>(handler: (deps: ToolDeps, params: P) => Promise<unknown>) =>
    async (_toolCallId: string, params: P) => {
      const deps = await options.deps();
      if (deps === undefined) return jsonResult(NOT_STARTED);
      try {
        return jsonResult(await handler(deps, params));
      } catch (err) {
        // A tool that throws is a worse experience than one that explains.
        return jsonResult({
          ok: false,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    };

  const tools: {
    name: string;
    label: string;
    description: string;
    parameters: unknown;
    execute: unknown;
  }[] = [
    {
      name: "hookdeck_status",
      label: "Hookdeck Status",
      description:
        "Health of the Hookdeck webhook pipeline: routes and their connections, in-flight capacity, " +
        "ledger persistence, dead-letter count, open Hookdeck issues, transport state and config warnings. " +
        "Start here when asked whether webhooks are working.",
      parameters: Type.Object({
        routeId: Type.Optional(
          Type.String({ description: "Limit to one route." }),
        ),
      }),
      execute: wrap(statusHandler),
    },
    {
      name: "hookdeck_recent_deliveries",
      label: "Hookdeck Recent Deliveries",
      description:
        "What has gone wrong recently. Returns open Hookdeck Issues — which ARE the dead-letter " +
        "queue — plus failures Hookdeck cannot see because they happened after the delivery was " +
        "already acknowledged. Answers 'did anything break overnight?'. Successful deliveries leave " +
        "no local record by design.",
      parameters: Type.Object({
        routeId: Type.Optional(Type.String()),
        outcome: Type.Optional(
          Type.Union([
            Type.Literal("failed"),
            Type.Literal("succeeded"),
            Type.Literal("all"),
          ]),
        ),
        limit: Type.Optional(
          Type.Number({ description: "Default 20, max 100." }),
        ),
      }),
      execute: wrap(recentDeliveriesHandler),
    },
    {
      name: "hookdeck_inspect_event",
      label: "Hookdeck Inspect Event",
      description:
        "Everything known about one event: our ledger row, our dead-letter reason if any, and Hookdeck's " +
        "own status and attempt count. Answers 'why did this one fail?'.",
      parameters: Type.Object({ eventId: Type.String() }),
      execute: wrap(inspectEventHandler),
    },
    {
      name: "hookdeck_doctor",
      label: "Hookdeck Doctor",
      description:
        "Diagnoses the Hookdeck setup: signing secret, ledger persistence, interrupted work, API key, and " +
        "whether each connection's retry rule still covers every status this plugin emits. That last check " +
        "catches silent data loss nothing else surfaces.",
      parameters: Type.Object({}),
      execute: wrap((deps) => doctorHandler(deps)),
    },
  ];

  if (options.allowMutations) {
    tools.push(
      {
        name: "hookdeck_setup",
        label: "Hookdeck Setup",
        description:
          "Provisions Hookdeck connections for the configured routes. Defaults to a dry run that shows " +
          "what would change; pass dryRun false to apply.",
        parameters: Type.Object({
          routeId: Type.Optional(Type.String()),
          dryRun: Type.Optional(
            Type.Boolean({ description: "Defaults to true." }),
          ),
        }),
        execute: wrap(setupHandler),
      },
      {
        name: "hookdeck_pause",
        label: "Hookdeck Pause",
        description:
          "Pauses or resumes a route's Hookdeck connection. While paused, events are held durably at HOLD " +
          "and delivered on resume — nothing is dropped. Use this for a planned or diagnosed outage, not " +
          "for transient load: resuming releases the whole backlog at once. Auto-resumes within an hour.",
        parameters: Type.Object({
          routeId: Type.String(),
          paused: Type.Boolean(),
          reason: Type.Optional(Type.String()),
          autoResumeAfterSeconds: Type.Optional(
            Type.Number({
              description: "Clamped to 3600. Defaults to the clamp.",
            }),
          ),
        }),
        execute: wrap((deps, params: Parameters<typeof pauseHandler>[1]) =>
          pauseHandler(deps, params, options.schedule),
        ),
      },
      {
        name: "hookdeck_replay",
        label: "Hookdeck Replay",
        description:
          "Re-delivers events. Pass eventIds to retry specific events, or routeId plus sinceMinutes for a " +
          "scoped bulk replay of requests nothing was listening for. Bulk replay is a dry run unless " +
          "confirm is true, because an unscoped replay costs real money.",
        parameters: Type.Object({
          eventIds: Type.Optional(Type.Array(Type.String())),
          routeId: Type.Optional(Type.String()),
          sinceMinutes: Type.Optional(Type.Number()),
          confirm: Type.Optional(Type.Boolean()),
        }),
        execute: wrap(replayHandler),
      },
      {
        name: "hookdeck_issues",
        label: "Hookdeck Issues",
        description:
          "Hookdeck Issues ARE the dead-letter queue — this is where events that have been given up " +
          "on are recorded, and where they are acknowledged and resolved. action 'list' (default) shows " +
          "open issues; 'get' details one; 'acknowledge' says someone is on it; 'resolve' says the " +
          "underlying problem is fixed; 'ignore' silences it; 'dismiss' removes the record entirely and " +
          "needs confirm. None of these replay anything — use hookdeck_replay for that.",
        parameters: Type.Object({
          action: Type.Optional(
            Type.Union([
              Type.Literal("list"),
              Type.Literal("get"),
              Type.Literal("acknowledge"),
              Type.Literal("resolve"),
              Type.Literal("ignore"),
              Type.Literal("dismiss"),
            ]),
          ),
          issueId: Type.Optional(Type.String()),
          status: Type.Optional(Type.String()),
          type: Type.Optional(Type.String()),
          limit: Type.Optional(Type.Number()),
          confirm: Type.Optional(Type.Boolean()),
        }),
        execute: wrap(issuesHandler),
      },
    );
  }

  const registered: string[] = [];
  for (const tool of tools) {
    // Registered individually so an unsupported one cannot take the rest down.
    try {
      api.registerTool(tool as never, { name: tool.name });
      registered.push(tool.name);
    } catch (err) {
      api.logger?.warn?.(`could not register ${tool.name}: ${String(err)}`);
    }
  }
  // Deliberately "declared", not "registered": the host logs a refusal rather
  // than throwing, so this count proves only that registerTool did not throw.
  // The real signal is the absence of `must declare contracts.tools` in the
  // Gateway log.
  api.logger?.info?.(
    `declared ${registered.length} tool(s): ${registered.join(", ")}` +
      (options.allowMutations
        ? ""
        : " (read-only: tools.allowMutations is false)"),
  );
}

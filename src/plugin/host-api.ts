/**
 * Re-exports of the OpenClaw plugin API types this plugin depends on.
 *
 * Centralised here so drift shows up in one place. All of these were checked
 * against the published `openclaw@2026.6.34` type definitions — note that is
 * BEHIND the repo's `main` (2026.8.1 at time of writing), so anything only
 * present on main must not be relied on.
 *
 * None of the APIs used here is trust-gated. Deliberately unused, because they
 * ARE gated to bundled/trusted-official plugins and we cannot qualify:
 * `runtime.state.openKeyedStore` and friends, `runtime.gateway`, and
 * `session.workflow.scheduleSessionTurn` (bundled-only).
 */
export type {
  OpenClawPluginApi,
  OpenClawPluginService,
  OpenClawPluginServiceContext,
  OpenClawPluginHttpRouteHandler,
} from "openclaw/plugin-sdk/plugin-entry";

/**
 * Structural subsets of the host's TaskFlow and subagent runtimes.
 *
 * Declared as the minimum this plugin actually calls, rather than re-exported
 * wholesale: the real interfaces are large, and a narrow subset both documents
 * the true dependency surface and keeps the test fakes honest. The real
 * runtimes satisfy these structurally, so a signature change still breaks the
 * build at the wiring point in `index.ts`.
 *
 * Verified against `openclaw@2026.6.34`: the mutators are synchronous and
 * return a discriminated result; only `cancel` is async.
 */

export type TaskFlowMutationResult =
  | { applied: true; flow: { flowId: string; revision: number } }
  | { applied: false; code: string; current?: { revision: number } };

export interface BoundTaskFlowRuntime {
  tryCreateManaged(params: {
    controllerId: string;
    goal: string;
    currentStep?: string | null;
    stateJson?: unknown;
  }): { flowId: string } | null;
  get(flowId: string): { flowId: string } | undefined;
  list(): unknown[];
  findLatest(): { flowId: string } | undefined;
  resolve(token: string): { flowId: string } | undefined;
  getTaskSummary(flowId: string): unknown;
  setWaiting(
    params: Record<string, unknown> & { flowId: string; expectedRevision: number },
  ): TaskFlowMutationResult;
  resume(
    params: Record<string, unknown> & { flowId: string; expectedRevision: number },
  ): TaskFlowMutationResult;
  finish(
    params: Record<string, unknown> & { flowId: string; expectedRevision: number },
  ): TaskFlowMutationResult;
  fail(
    params: Record<string, unknown> & { flowId: string; expectedRevision: number },
  ): TaskFlowMutationResult;
  requestCancel(params: { flowId: string; expectedRevision: number }): TaskFlowMutationResult;
  cancel(params: { flowId: string; cfg: never }): Promise<{ cancelled: boolean; reason?: string }>;
  runTask(
    params: Record<string, unknown> & { flowId: string },
  ): { created: boolean; found?: boolean; reason?: string };
}

export interface TaskFlowRuntime {
  managedFlows: { bindSession(params: { sessionKey: string }): BoundTaskFlowRuntime };
}

/**
 * `src/plugins/runtime/types.ts`. Ungated for third-party plugins — only
 * `provider`/`model` overrides require the operator opt-in
 * `plugins.entries.<id>.subagent.allowModelOverride`, which is why neither is
 * ever passed here.
 */
export interface SubagentRuntime {
  run(params: {
    sessionKey: string;
    message: string;
    idempotencyKey?: string;
    deliver?: boolean;
    lane?: string;
    extraSystemPrompt?: string;
  }): Promise<{ runId: string }>;
  waitForRun(params: { runId: string; timeoutMs?: number }): Promise<{
    status: "ok" | "error" | "timeout";
    error?: string;
  }>;
}

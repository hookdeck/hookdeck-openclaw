import type { BoundTaskFlowRuntime, SubagentRuntime } from "../plugin/host-api.js";
import { TRUST_HINT } from "../protocol/template.js";
import type { AgentRunner } from "./agent.js";

/**
 * The two ways to start an agent turn, and why there are two.
 *
 * `subagent.run` is the obvious API and the one the SDK documentation points
 * at. It requires the `operator.write` scope. A plugin-registered HTTP route
 * with `auth: "plugin"` is given `scopes: []` **unconditionally** — the
 * Gateway's own `createPluginRouteRuntimeScope` reads
 * `route.auth !== "gateway" ? [] : …`, and `gatewayRuntimeScopeSurface` only
 * applies on the `"gateway"` branch. Since this plugin authenticates with
 * Hookdeck's signature rather than the Gateway's own credentials, that scope is
 * structurally unreachable and `subagent.run` answers
 * `missing scope: operator.write`.
 *
 * TaskFlow `run_task` has no such requirement and works from a
 * signature-verified route — verified live. It is also a better fit: the run
 * becomes durable flow state rather than a bare run id, so it survives a
 * restart and stays inspectable.
 *
 * The subagent runner is kept for hosts where the route does carry operator
 * scopes, because it is the only one that can observe completion, and
 * completion observability is what `sync` and the agent-retry budget need.
 */

export interface TaskFlowRunnerOptions {
  controllerId: string;
  bind(sessionKey: string): BoundTaskFlowRuntime;
}

export function createTaskFlowRunner(options: TaskFlowRunnerOptions): AgentRunner {
  return {
    async start({ sessionKey, prompt, eventId, routeId }) {
      const flows = options.bind(sessionKey);

      const flow = flows.tryCreateManaged({
        controllerId: options.controllerId,
        goal: `Webhook ${routeId} (${eventId})`,
      });
      if (flow === null) {
        return { ok: false, retryable: true, message: "flow could not be persisted" };
      }

      const task = flows.runTask({ flowId: flow.flowId, runtime: "subagent", task: prompt });
      if (!task.created) {
        return {
          ok: false,
          // A missing flow here would be a host-side race, not bad input.
          retryable: true,
          message: task.reason ?? "task could not be created",
        };
      }

      return { ok: true, handle: flow.flowId };
    },
    // Deliberately no `waitFor`: TaskFlow exposes flow state, not a completion
    // promise. Claiming to observe completion would mean polling and guessing,
    // and the shared contract is explicit that a host without a completion hook
    // should say so rather than fake it.
  };
}

export interface SubagentRunnerOptions {
  subagent: SubagentRuntime;
  deliver: boolean;
  lane?: string;
}

export function createSubagentRunner(options: SubagentRunnerOptions): AgentRunner {
  return {
    async start({ sessionKey, prompt, eventId }) {
      try {
        const started = await options.subagent.run({
          sessionKey,
          message: prompt,
          // A second dedupe layer inside the host, below our ledger.
          idempotencyKey: eventId,
          deliver: options.deliver,
          // The payload is untrusted third-party text reaching a model with
          // tools. Say so where the model will actually read it.
          extraSystemPrompt: TRUST_HINT,
          ...(options.lane !== undefined ? { lane: options.lane } : {}),
        });
        return { ok: true, handle: started.runId };
      } catch (err) {
        return {
          ok: false,
          retryable: true,
          message: err instanceof Error ? err.message : String(err),
        };
      }
    },

    async waitFor(handle, timeoutMs) {
      return options.subagent.waitForRun({
        runId: handle,
        ...(timeoutMs !== undefined ? { timeoutMs } : {}),
      });
    },
  };
}

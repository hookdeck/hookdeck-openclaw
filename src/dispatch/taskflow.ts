import { parseTaskFlowEnvelope, isWriteAction, type TaskFlowEnvelope } from "../protocol/envelope.js";
import { accepted, cancelRetries, deferFor, ok, retryable } from "../protocol/outcome.js";
import type { BoundTaskFlowRuntime, TaskFlowMutationResult } from "../plugin/host-api.js";
import type { DispatchContext, DispatchOutcome, Dispatcher } from "./types.js";

/**
 * TaskFlow action dispatch.
 *
 * Mirrors the built-in Webhooks plugin's vocabulary and status taxonomy, so an
 * automation source already speaking it keeps working — but with signature
 * verification, deduplication and a real retry contract in front.
 *
 * The taxonomy below is chosen for what Hookdeck does next, and two entries are
 * worth reading twice:
 *
 *  - `revision_conflict` **cancels retries**. `expectedRevision` is baked into
 *    the stored request and TaskFlow revisions only ever increase, so a retry of
 *    that exact envelope can never succeed. The current revision is returned in
 *    the body so the caller can re-read and re-send a corrected one.
 *  - `not_found` does **not** cancel. The flow may simply not exist yet — an
 *    envelope can race ahead of the creation that produces it — and Hookdeck's
 *    backoff resolves that race for free. If it never resolves, last-attempt
 *    dead-lettering records it and the resulting Issue is the operator's alert.
 */

export interface TaskFlowDispatchOptions {
  controllerId: string;
  /** When set, only these actions are accepted on this route. */
  allowedActions?: readonly string[];
  /** Passed to `cancel`, which needs the host config. */
  hostConfig?: unknown;
}

function mapMutation(result: TaskFlowMutationResult, action: string): DispatchOutcome {
  if (result.applied) {
    return {
      settle: "succeeded",
      plan: ok("dispatched", `${action} applied (revision ${result.flow.revision})`),
    };
  }

  switch (result.code) {
    case "not_found":
      // Retryable: the flow may not exist yet.
      return { settle: "failed", plan: retryable(404, "flow_not_found", `no flow for ${action}`) };

    case "revision_conflict":
      return {
        settle: "failed",
        plan: cancelRetries(
          "flow_revision_conflict",
          409,
          `expectedRevision is stale${
            result.current ? `; current revision is ${result.current.revision}` : ""
          }. Re-read the flow and send a corrected revision — retrying this envelope cannot succeed.`,
        ),
      };

    case "not_managed":
      return {
        settle: "failed",
        plan: cancelRetries("flow_not_managed", 409, "flow is not managed by this controller"),
      };

    case "persist_failed":
      // Genuinely transient — disk or state pressure. This is what retries are for.
      return { settle: "failed", plan: deferFor(503, "persist_failed", 15, "state write failed") };

    default:
      return {
        settle: "failed",
        plan: retryable(409, "mutation_rejected", `${action} rejected: ${String(result.code)}`),
      };
  }
}

export function createTaskFlowDispatcher(
  options: TaskFlowDispatchOptions,
  bind: () => BoundTaskFlowRuntime,
): Dispatcher {
  return {
    async dispatch(ctx: DispatchContext): Promise<DispatchOutcome> {
      const parsed = parseTaskFlowEnvelope(ctx.payload);
      if (!parsed.ok) {
        // Schema-invalid will never become valid: the body is fixed.
        return {
          settle: "failed",
          plan: cancelRetries(
            "invalid_envelope",
            400,
            `invalid TaskFlow envelope: ${parsed.errors.join("; ")}`,
          ),
        };
      }

      const envelope: TaskFlowEnvelope = parsed.envelope;

      if (
        options.allowedActions !== undefined &&
        !options.allowedActions.includes(envelope.action)
      ) {
        return {
          settle: "failed",
          plan: cancelRetries(
            "forbidden_action",
            403,
            `action '${envelope.action}' is not allowed on this route`,
          ),
        };
      }

      const flows = bind();

      switch (envelope.action) {
        // Reads. Absent flows are 200 with a null result, matching the built-in
        // plugin: "not found" is an answer, not a failure.
        case "get_flow":
          return { settle: "succeeded", plan: ok("dispatched", describe(flows.get(envelope.flowId))) };
        case "list_flows":
          return { settle: "succeeded", plan: ok("dispatched", `${flows.list().length} flow(s)`) };
        case "find_latest_flow":
          return { settle: "succeeded", plan: ok("dispatched", describe(flows.findLatest())) };
        case "resolve_flow":
          return { settle: "succeeded", plan: ok("dispatched", describe(flows.resolve(envelope.token))) };
        case "get_task_summary":
          return {
            settle: "succeeded",
            plan: ok(
              "dispatched",
              flows.getTaskSummary(envelope.flowId) === undefined ? "no summary" : "summary",
            ),
          };

        case "create_flow": {
          const flow = flows.tryCreateManaged({
            controllerId: envelope.controllerId ?? options.controllerId,
            goal: envelope.goal,
            ...(envelope.currentStep !== undefined ? { currentStep: envelope.currentStep } : {}),
            ...(envelope.stateJson !== undefined ? { stateJson: envelope.stateJson } : {}),
          });
          if (flow === null) {
            return {
              settle: "failed",
              plan: deferFor(503, "create_rejected", 15, "flow could not be persisted"),
            };
          }
          return { settle: "succeeded", plan: ok("dispatched", `created flow ${flow.flowId}`) };
        }

        case "set_waiting":
          return mapMutation(
            flows.setWaiting({
              flowId: envelope.flowId,
              expectedRevision: envelope.expectedRevision,
              ...(envelope.currentStep !== undefined ? { currentStep: envelope.currentStep } : {}),
              ...(envelope.stateJson !== undefined ? { stateJson: envelope.stateJson } : {}),
              ...(envelope.waitJson !== undefined ? { waitJson: envelope.waitJson } : {}),
            }),
            envelope.action,
          );

        case "resume_flow":
          return mapMutation(
            flows.resume({
              flowId: envelope.flowId,
              expectedRevision: envelope.expectedRevision,
              ...(envelope.status !== undefined ? { status: envelope.status } : {}),
              ...(envelope.currentStep !== undefined ? { currentStep: envelope.currentStep } : {}),
              ...(envelope.stateJson !== undefined ? { stateJson: envelope.stateJson } : {}),
            }),
            envelope.action,
          );

        case "finish_flow":
          return mapMutation(
            flows.finish({
              flowId: envelope.flowId,
              expectedRevision: envelope.expectedRevision,
              ...(envelope.stateJson !== undefined ? { stateJson: envelope.stateJson } : {}),
            }),
            envelope.action,
          );

        case "fail_flow":
          return mapMutation(
            flows.fail({
              flowId: envelope.flowId,
              expectedRevision: envelope.expectedRevision,
              ...(envelope.stateJson !== undefined ? { stateJson: envelope.stateJson } : {}),
              ...(envelope.blockedSummary !== undefined
                ? { blockedSummary: envelope.blockedSummary }
                : {}),
            }),
            envelope.action,
          );

        case "request_cancel":
          return mapMutation(
            flows.requestCancel({
              flowId: envelope.flowId,
              expectedRevision: envelope.expectedRevision,
            }),
            envelope.action,
          );

        case "cancel_flow": {
          const result = await flows.cancel({
            flowId: envelope.flowId,
            cfg: options.hostConfig as never,
          });
          if (result.cancelled) {
            return { settle: "succeeded", plan: ok("dispatched", "flow cancelled") };
          }
          if (/still active|child tasks/i.test(result.reason ?? "")) {
            // Accepted, work continues, no retry wanted — mirrors the built-in
            // plugin's one 2xx-but-incomplete case.
            return { settle: "succeeded", plan: accepted("cancel_pending", result.reason) };
          }
          if (/not found/i.test(result.reason ?? "")) {
            return { settle: "failed", plan: retryable(404, "flow_not_found", result.reason) };
          }
          return {
            settle: "failed",
            plan: retryable(409, "cancel_rejected", result.reason ?? "cancel rejected"),
          };
        }

        case "run_task": {
          const result = flows.runTask({
            flowId: envelope.flowId,
            runtime: envelope.runtime,
            task: envelope.task,
            ...(envelope.childSessionKey !== undefined
              ? { childSessionKey: envelope.childSessionKey }
              : {}),
          });
          if (result.created) {
            return { settle: "succeeded", plan: ok("dispatched", "task created") };
          }
          if (!result.found) {
            return { settle: "failed", plan: retryable(404, "flow_not_found", result.reason) };
          }
          return {
            settle: "failed",
            plan: retryable(409, "task_not_created", result.reason ?? "task not created"),
          };
        }

        default: {
          // Exhaustiveness guard: adding an action to the schema without
          // handling it here becomes a compile error rather than a 500.
          const unreachable: never = envelope;
          return {
            settle: "failed",
            plan: retryable(
              409,
              "unsupported_action",
              `unhandled action ${JSON.stringify(unreachable)}`,
            ),
          };
        }
      }
    },
  };
}

function describe(flow: { flowId?: string } | undefined): string {
  return flow === undefined ? "no flow" : `flow ${flow.flowId ?? "(unknown)"}`;
}

export { isWriteAction };

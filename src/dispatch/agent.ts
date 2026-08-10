import type { EventRetrier } from "../hookdeck/client.js";
import type { Logger } from "../ingress/handler.js";
import {
  cancelRetries,
  deferFor,
  ok,
  retryable,
  accepted,
} from "../protocol/outcome.js";
import { buildPrompt, TRUST_HINT } from "../protocol/template.js";
import type { DeadLetterLog } from "../store/deadletter.js";
import type { Ledger } from "../store/ledger.js";
import type { DispatchContext, DispatchOutcome, Dispatcher } from "./types.js";

/**
 * Agent dispatch: render the payload into a prompt and run an isolated turn.
 *
 * This is the mode that works with any of Hookdeck's ~145 verified providers on
 * day one, because it needs no payload shaping — a raw Stripe body is not a
 * TaskFlow envelope and never will be.
 *
 * Two acknowledgement modes, named to match the shared reliability contract:
 *
 *  - `async_retry` (default): acknowledge 202 once admitted, run in the
 *    background, and on failure ask Hookdeck to redeliver. Retry state lives in
 *    Hookdeck, so it survives a host restart. Stops after `maxAgentRetries` and
 *    marks the event exhausted rather than looping.
 *  - `sync`: hold the response until the run finishes, bounded by
 *    `syncTimeoutSeconds`. On timeout, degrade to 202 — answering 5xx would
 *    redeliver work that is still running.
 */

export interface AgentDispatchOptions {
  sessionKey: string;
  prompt: string;
  ackMode: "async_retry" | "sync";
  syncTimeoutSeconds: number;
  maxAgentRetries: number;
  /**
   * Whether the agent's reply is delivered to a messaging channel. Defaults to
   * false: a webhook-triggered route must not send anything outbound by
   * default, or an injected payload gains a way out.
   */
  deliver: boolean;
  lane?: string;
  maxConcurrentRuns: number;
  busyRetryAfterSeconds: number;
}

/**
 * How the turn is actually started.
 *
 * `subagent.run` is the natural API, but it requires the `operator.write`
 * scope, and a plugin-auth HTTP route is given `scopes: []` unconditionally —
 * `route.auth !== "gateway" ? [] : ...` in the Gateway's own
 * `createPluginRouteRuntimeScope`. Since we authenticate with Hookdeck's
 * signature rather than the Gateway's credentials, that scope is unreachable,
 * and `subagent.run` answers `missing scope: operator.write`.
 *
 * TaskFlow `run_task` is the path that does work from a signature-verified
 * route, and it is strictly better here: the run is recorded as durable flow
 * state rather than a bare run id, so it stays inspectable after a restart.
 */
export interface AgentRunner {
  start(params: {
    sessionKey: string;
    prompt: string;
    eventId: string;
    routeId: string;
  }): Promise<
    | { ok: true; handle: string }
    | { ok: false; retryable: boolean; message: string }
  >;
  /** Absent when the transport cannot observe completion. */
  waitFor?(
    handle: string,
    timeoutMs?: number,
  ): Promise<{ status: "ok" | "error" | "timeout"; error?: string }>;
}

export interface AgentDispatchDeps {
  runner: AgentRunner;
  ledger: Ledger;
  deadLetter: DeadLetterLog;
  logger: Logger;
  client?: EventRetrier | undefined;
}

/** Background waits are bounded so a wedged run cannot leak a slot forever. */
const BACKGROUND_WAIT_MS = 60 * 60 * 1000;

/** Session keys reach the host verbatim, so keep them to a boring alphabet. */
export function renderSessionKey(
  template: string,
  ctx: { routeId: string; eventId?: string; source?: string },
): string {
  return template
    .replaceAll("{routeId}", ctx.routeId)
    .replaceAll("{eventId}", ctx.eventId ?? "unknown")
    .replaceAll("{source}", ctx.source ?? ctx.routeId)
    .replace(/[^A-Za-z0-9:_-]/g, "-")
    .slice(0, 200);
}

export function createAgentDispatcher(
  options: AgentDispatchOptions,
  deps: AgentDispatchDeps,
): Dispatcher {
  // Background runs outlive the request, so the handler's in-flight registry
  // cannot bound them — it releases its slot the moment we return 202. Without
  // this counter `maxConcurrent` would silently stop applying in async_retry
  // mode, which is exactly where it matters most.
  let activeRuns = 0;

  async function settleAfterRun(
    eventId: string,
    runId: string,
    routeId: string,
  ): Promise<void> {
    try {
      const result = await deps.runner.waitFor!(runId, BACKGROUND_WAIT_MS);
      if (result.status === "ok") {
        await deps.ledger.settle(eventId, "succeeded");
        return;
      }

      const attempted = (deps.ledger.get(eventId)?.agentRetries ?? 0) + 1;
      const reason = result.error ?? result.status;

      if (deps.client !== undefined && attempted <= options.maxAgentRetries) {
        // Settled BEFORE the retry is requested. Hookdeck can redeliver almost
        // immediately, and the redelivery calls `begin` to open the next run's
        // row — a settle afterwards would stamp that live row `failed`.
        await deps.ledger.settle(eventId, "failed", {
          agentRetries: attempted,
        });

        const retried = await deps.client.retryEvent(eventId);
        if (retried.ok) {
          deps.logger.warn(
            `agent run failed for ${eventId} (${reason}); asked Hookdeck to redeliver (${attempted}/${options.maxAgentRetries})`,
          );
          return;
        }
        deps.logger.warn(`could not re-queue ${eventId}: ${retried.message}`);
      }

      // Out of budget, or no API key. Mark exhausted so a later redelivery is
      // not silently re-run, and record it where an agent can find it.
      await deps.ledger.settle(eventId, "exhausted", {
        agentRetries: attempted,
      });
      await deps.deadLetter.record({
        eventId,
        routeId,
        code: "agent_run_failed",
        // Hookdeck recorded a successful delivery before this happened, so no
        // Issue will ever open. Nothing else knows about it.
        hookdeckVisible: false,
        reason:
          deps.client === undefined
            ? `agent run failed (${reason}); no API key configured, so it was not re-queued`
            : `agent run failed (${reason}); exhausted after ${options.maxAgentRetries} retries`,
        retriesCancelled: false,
        lastAttempt: true,
      });
    } catch (err) {
      deps.logger.warn(
        `background settle failed for ${eventId}: ${err instanceof Error ? err.message : err}`,
      );
      await deps.ledger.settle(eventId, "failed").catch(() => {});
    } finally {
      activeRuns -= 1;
    }
  }

  return {
    // Checked by the handler before it writes a ledger row, so a deferral
    // leaves no trace. The duplicate check inside `dispatch` remains as a
    // guard for callers that skip this.
    canAccept: () => activeRuns < options.maxConcurrentRuns,

    async dispatch(ctx: DispatchContext): Promise<DispatchOutcome> {
      const eventId = ctx.delivery.eventId;
      if (eventId === undefined) {
        // The handler rejects these earlier; belt and braces, since the whole
        // retry accounting below is keyed on the event id.
        return {
          settle: "failed",
          plan: retryable(
            400,
            "no_event_id",
            "agent dispatch requires an event id",
          ),
        };
      }

      if (activeRuns >= options.maxConcurrentRuns) {
        return {
          settle: "deferred",
          plan: deferFor(
            503,
            "busy",
            options.busyRetryAfterSeconds,
            `at capacity (${options.maxConcurrentRuns} agent runs)`,
          ),
        };
      }

      const templateCtx = {
        routeId: ctx.routeId,
        payload: ctx.payload,
        ...(ctx.delivery.sourceName !== undefined
          ? { source: ctx.delivery.sourceName }
          : {}),
        ...(ctx.delivery.eventId !== undefined
          ? { eventId: ctx.delivery.eventId }
          : {}),
        ...(ctx.delivery.requestId !== undefined
          ? { requestId: ctx.delivery.requestId }
          : {}),
        ...(ctx.delivery.attemptCount !== undefined
          ? { attemptCount: ctx.delivery.attemptCount }
          : {}),
      };

      let message: string;
      let sessionKey: string;
      try {
        message = buildPrompt(options.prompt, templateCtx);
        sessionKey = renderSessionKey(options.sessionKey, {
          routeId: ctx.routeId,
          ...(ctx.delivery.eventId !== undefined
            ? { eventId: ctx.delivery.eventId }
            : {}),
          ...(ctx.delivery.sourceName !== undefined
            ? { source: ctx.delivery.sourceName }
            : {}),
        });
      } catch (err) {
        return {
          settle: "failed",
          plan: cancelRetries(
            "agent_input_invalid",
            422,
            `could not build the prompt: ${err instanceof Error ? err.message : err}`,
          ),
        };
      }

      if (sessionKey.length === 0) {
        return {
          settle: "failed",
          plan: cancelRetries(
            "agent_input_invalid",
            422,
            "sessionKey rendered empty",
          ),
        };
      }

      activeRuns += 1;
      const started = await deps.runner.start({
        sessionKey,
        prompt: message,
        eventId,
        routeId: ctx.routeId,
      });
      if (!started.ok) {
        activeRuns -= 1;
        // Infrastructure, not input. Keep it retryable and let exponential
        // backoff pace it — a fixed interval would burn the budget.
        return {
          settle: "failed",
          plan: retryable(
            started.retryable ? 503 : 500,
            "agent_start_failed",
            started.message,
          ),
        };
      }
      const runId = started.handle;

      if (deps.runner.waitFor === undefined) {
        // The transport cannot observe completion, so there is nothing to wait
        // for and no failure to retry on. Hookdeck's job — durable delivery —
        // is done; run durability belongs to the flow record from here.
        activeRuns -= 1;
        return {
          settle: "succeeded",
          plan: accepted("accepted", `run ${runId} started`),
        };
      }

      if (options.ackMode === "async_retry") {
        // The dispatcher owns settling from here: the row must stay `running`
        // until the background run finishes, so a crash mid-run is recoverable.
        void settleAfterRun(eventId, runId, ctx.routeId);
        return {
          settle: "deferred",
          plan: accepted("accepted", `run ${runId} started`),
        };
      }

      // sync
      try {
        const result = await deps.runner.waitFor(
          runId,
          options.syncTimeoutSeconds * 1000,
        );

        if (result.status === "ok") {
          activeRuns -= 1;
          return {
            settle: "succeeded",
            plan: ok("dispatched", `run ${runId} completed`),
          };
        }

        if (result.status === "timeout") {
          // Degrade to 202: answering 5xx would redeliver work still running.
          // The run keeps going, so the background waiter settles the row.
          void settleAfterRun(eventId, runId, ctx.routeId);
          return {
            settle: "deferred",
            plan: accepted(
              "accepted_timeout",
              `run ${runId} still running after timeout`,
            ),
          };
        }

        activeRuns -= 1;
        return {
          settle: "failed",
          plan: retryable(
            500,
            "agent_run_failed",
            result.error ?? "agent run failed",
          ),
        };
      } catch (err) {
        activeRuns -= 1;
        return {
          settle: "failed",
          plan: retryable(
            500,
            "agent_run_failed",
            err instanceof Error ? err.message : String(err),
          ),
        };
      }
    },
  };
}

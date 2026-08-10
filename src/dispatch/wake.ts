import type { WakeDispatchConfig } from "../plugin/config-types.js";
import { ok, retryable } from "../protocol/outcome.js";
import type { DispatchContext, DispatchOutcome, Dispatcher } from "./types.js";

/**
 * Wake dispatch: enqueue a system event, optionally requesting an immediate
 * heartbeat.
 *
 * This is the in-process equivalent of `POST {hooks.basePath}/wake`. The
 * Gateway's own wake handler calls `enqueueSystemEvent` then, for `mode: "now"`,
 * `requestHeartbeat` — and `api.runtime.system` re-exports both by reference.
 * Neither is trust-gated, so we call them directly rather than looping back over
 * HTTP, which would additionally require the operator to set `hooks.enabled`
 * and `hooks.token`.
 *
 * `enqueueSystemEvent` throws without a session key, so route config requires one.
 */

export interface SystemRuntime {
  enqueueSystemEvent(
    text: string,
    options: { sessionKey: string; contextKey?: string | null; replace?: boolean },
  ): boolean;
  requestHeartbeat(options: {
    source: string;
    intent: string;
    reason?: string;
    sessionKey?: string;
  }): void;
}

const DEFAULT_TEXT = "Webhook received from {source}";

/** Placeholder substitution, deliberately not a template engine. */
export function renderWakeText(
  template: string,
  ctx: { routeId: string; source?: string; eventId?: string },
): string {
  return template
    .replaceAll("{routeId}", ctx.routeId)
    .replaceAll("{source}", ctx.source ?? ctx.routeId)
    .replaceAll("{eventId}", ctx.eventId ?? "unknown");
}

export function createWakeDispatcher(
  config: WakeDispatchConfig,
  system: SystemRuntime,
): Dispatcher {
  return {
    async dispatch(ctx: DispatchContext): Promise<DispatchOutcome> {
      const text = renderWakeText(config.text ?? DEFAULT_TEXT, {
        routeId: ctx.routeId,
        source: ctx.delivery.sourceName,
        eventId: ctx.delivery.eventId,
      });

      let enqueued: boolean;
      try {
        enqueued = system.enqueueSystemEvent(text, { sessionKey: config.sessionKey });
      } catch (err) {
        // A throw here is an infrastructure problem, not bad input — keep the
        // event alive in Hookdeck so it lands after the operator fixes it.
        return {
          settle: "failed",
          plan: retryable(503, "wake_failed", err instanceof Error ? err.message : String(err)),
        };
      }

      if (!enqueued) {
        // `enqueueSystemEvent` returns false for empty text or duplicate
        // suppression. Both mean "this event will not wake anything", and
        // neither improves on retry.
        return { settle: "succeeded", plan: ok("dispatched", "suppressed") };
      }

      if ((config.wakeMode ?? "now") === "now") {
        try {
          system.requestHeartbeat({
            source: "hook",
            intent: "immediate",
            reason: `hookdeck:${ctx.routeId}`,
          });
        } catch (err) {
          // The event is already queued; failing to nudge the heartbeat only
          // delays it to the next tick. Not worth a retry, which would
          // re-enqueue and duplicate.
          return {
            settle: "succeeded",
            plan: ok("dispatched", `enqueued; heartbeat request failed: ${String(err)}`),
          };
        }
      }

      return { settle: "succeeded", plan: ok("dispatched") };
    },
  };
}

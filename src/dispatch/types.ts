import type { HookdeckDelivery } from "../protocol/delivery.js";
import type { ResponsePlan } from "../protocol/outcome.js";

/**
 * How the handler should settle the ledger row after a dispatch.
 *
 * `deferred` is the interesting one: it means the dispatcher has taken
 * ownership and will settle the row itself, later. `async_retry` needs this —
 * it acknowledges 202 immediately and the run continues in the background, so
 * the row must stay `running` until that run actually finishes. Settling it
 * eagerly would tell the next boot the work completed, and a crash mid-run
 * would go unrecovered.
 */
export type SettleInstruction = "succeeded" | "failed" | "exhausted" | "deferred";

export interface DispatchOutcome {
  settle: SettleInstruction;
  plan: ResponsePlan;
}

export interface DispatchContext {
  routeId: string;
  delivery: HookdeckDelivery;
  payload: unknown;
}

export interface Dispatcher {
  dispatch(ctx: DispatchContext): Promise<DispatchOutcome>;
}

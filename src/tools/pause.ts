import {
  requireClient,
  isError,
  requireWritableState,
  type ToolDeps,
} from "./deps.js";

/**
 * `hookdeck_pause` — holds events durably at HOLD for a planned or diagnosed
 * outage. Nothing is dropped, and resuming releases the backlog.
 *
 * Not a load-shedding tool: admission control handles transient load per event,
 * where resuming a pause delivers everything at once into the same overload.
 */

export const DEFAULT_MAX_AUTO_RESUME_SECONDS = 3600;

/**
 * One pending auto-resume per route. Without this, pausing twice leaves two
 * timers, and the older one can unpause a connection the agent has just
 * deliberately re-paused.
 */
const autoResumeCancels = new Map<string, () => void>();

export function cancelPendingAutoResume(routeId: string): void {
  autoResumeCancels.get(routeId)?.();
  autoResumeCancels.delete(routeId);
}

export async function pauseHandler(
  deps: ToolDeps,
  params: {
    routeId: string;
    paused: boolean;
    reason?: string;
    autoResumeAfterSeconds?: number;
  },
  schedule?: (fn: () => void, ms: number) => (() => void) | void,
) {
  const client = requireClient(deps);
  if (isError(client)) return { ok: false, note: client.error };

  // Checked before the API call, not after: pausing at Hookdeck and failing to
  // record it is worse than not pausing at all.
  const unwritable = requireWritableState(
    deps,
    params.paused ? "Pausing a connection" : "Resuming a connection",
  );
  if (unwritable !== undefined) return { ok: false, note: unwritable.error };

  const cursor = deps.cursors.get(params.routeId);
  if (cursor?.connectionId === undefined) {
    return {
      ok: false,
      note: `No connection id known for route '${params.routeId}'. Run setup, or set routes.${params.routeId}.connectionId.`,
    };
  }

  if (params.paused) {
    await deps.cursors.patch(params.routeId, { pausedByUs: true });
    const result = await client.pauseConnection(cursor.connectionId);
    if (!result.ok) {
      await deps.cursors.patch(params.routeId, { pausedByUs: false });
      return { ok: false, note: result.message };
    }

    // An agent that pauses and then loses the thread must not stop the pipeline
    // forever, so auto-resume is clamped and applied by default rather than
    // being opt-in.
    const seconds = Math.min(
      params.autoResumeAfterSeconds ?? DEFAULT_MAX_AUTO_RESUME_SECONDS,
      DEFAULT_MAX_AUTO_RESUME_SECONDS,
    );
    cancelPendingAutoResume(params.routeId);
    const cancel = schedule?.(() => {
      autoResumeCancels.delete(params.routeId);
      void pauseHandler(deps, { routeId: params.routeId, paused: false });
    }, seconds * 1000);
    if (typeof cancel === "function")
      autoResumeCancels.set(params.routeId, cancel);

    return {
      ok: true,
      paused: true,
      autoResumeAfterSeconds: seconds,
      note: "Events are held at HOLD and delivered on resume. Nothing is dropped.",
    };
  }

  // An explicit resume retires any pending auto-resume for this route.
  cancelPendingAutoResume(params.routeId);
  const result = await client.unpauseConnection(cursor.connectionId);
  if (!result.ok) return { ok: false, note: result.message };
  await deps.cursors.patch(params.routeId, { pausedByUs: false });
  return {
    ok: true,
    paused: false,
    note: "Held events will be delivered with trigger UNPAUSE.",
  };
}

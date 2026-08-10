import { runCatchUp } from "../catchup.js";
import type { HookdeckClient } from "../hookdeck/client.js";
import { buildConnectionSpec, fingerprint, uncoveredStatuses } from "../hookdeck/provision.js";
import type { Logger } from "../ingress/handler.js";
import type { HookdeckPluginConfig } from "../plugin/config-types.js";
import { RETRYABLE_STATUS_CODES } from "../protocol/outcome.js";
import type { DeadLetterLog } from "../store/deadletter.js";
import type { CursorStore } from "../store/cursor-store.js";
import type { InFlightRegistry } from "../store/in-flight.js";
import type { Ledger } from "../store/ledger.js";

/**
 * The agent-facing surface.
 *
 * Bias throughout: an agent wants correlated, already-triaged state, not a REST
 * wrapper it has to join by hand. The interesting question is almost always
 * "Hookdeck says delivered — did *we* actually do anything with it?", so the
 * read tools answer that in one call rather than making the model fetch both
 * sides and reason about the overlap.
 *
 * Deliberately absent: `disable`, any delete, raw source/destination CRUD, and
 * transformation overwrite. Their failure mode is irrecoverable event loss and
 * an agent cannot judge the blast radius.
 */

export interface ToolDeps {
  config: HookdeckPluginConfig;
  /** State, read from the live service when in-process, otherwise from disk. */
  ledger: Ledger;
  deadLetter: DeadLetterLog;
  cursors: CursorStore;
  logger: Logger;
  client?: HookdeckClient | undefined;
  configWarnings(): { path: string; message: string }[];
  /**
   * Whether this view came from the running service or from its state files.
   *
   * Reported to the agent rather than hidden: in-flight counts and transport
   * state exist only in the service's memory, so a disk view genuinely cannot
   * know them, and saying "0 in flight" would be a lie rather than a gap.
   */
  source: "live" | "disk";
  /** Live-only. Absent on a disk view. */
  inFlight?: InFlightRegistry | undefined;
  transportStatus?: (() => Record<string, { state: string; restarts: number; recent: string[] }>) | undefined;
  retryCancels?: (() => Record<string, number>) | undefined;
  now?(): number;
}

const NO_CLIENT = "No Hookdeck API key is configured, so this needs an operator rather than an agent.";

function requireClient(deps: ToolDeps): HookdeckClient | { error: string } {
  return deps.client ?? { error: NO_CLIENT };
}

function isError(value: unknown): value is { error: string } {
  return typeof value === "object" && value !== null && "error" in value;
}

// ---------------------------------------------------------------------------
// status
// ---------------------------------------------------------------------------

/**
 * `readonly` describes OUR handle on the file, not the system's health. Leaking
 * it into status invited a real misreading: an agent reported that events were
 * "stuck with no automatic retry path" because persistence was read-only, when
 * the Gateway was persisting normally and the reader simply had a read-only
 * view. `source` already carries that nuance.
 */
function reportedPersistence(state: string): string {
  return state === "readonly" ? "active" : state;
}

export async function statusHandler(deps: ToolDeps, params: { routeId?: string }) {
  const ledgerStats = deps.ledger.stats();
  const routes = Object.entries(deps.config.routes)
    .filter(([id]) => params.routeId === undefined || id === params.routeId)
    .map(([routeId, route]) => {
      const cursor = deps.cursors.get(routeId);
      return {
        routeId,
        path: `${deps.config.ingress.basePath}${route.path}`,
        source: route.source,
        dispatch: route.dispatch.mode,
        enabled: route.enabled,
        connectionId: cursor?.connectionId ?? null,
        pausedByUs: cursor?.pausedByUs === true,
        pendingCatchUp: cursor?.lastDisconnectAt !== undefined,
      };
    });

  let openIssues: number | null = null;
  if (deps.client !== undefined) {
    // Counted, not measured from a capped list — otherwise 500 open issues
    // report as whatever the page size happens to be.
    const issues = await deps.client.countIssues({ status: "OPENED" });
    openIssues = issues.ok ? issues.data : null;
  }

  return {
    source: deps.source,
    ...(deps.source === "disk"
      ? {
          note:
            "Read from the plugin's state files rather than a running service, so in-flight " +
            "capacity and transport state are unavailable here. Everything else is current.",
        }
      : {}),
    routes,
    inFlight:
      deps.inFlight === undefined
        ? null
        : { current: deps.inFlight.size, max: deps.inFlight.capacity },
    ledger: {
      entries: ledgerStats.entries,
      running: ledgerStats.running,
      // Says so out loud rather than implying a guarantee we are not making.
      persistence: reportedPersistence(ledgerStats.persistence),
      ...(ledgerStats.firstError !== undefined ? { firstError: ledgerStats.firstError } : {}),
    },
    deadLetters: deps.deadLetter.count(),
    retryCancellations: deps.retryCancels?.() ?? null,
    transport: { mode: deps.config.transport.mode, listeners: deps.transportStatus?.() ?? null },
    openIssues,
    configWarnings: deps.configWarnings(),
  };
}

// ---------------------------------------------------------------------------
// recent deliveries — the "did anything break overnight?" tool
// ---------------------------------------------------------------------------

export async function recentDeliveriesHandler(
  deps: ToolDeps,
  params: { routeId?: string; limit?: number },
) {
  const limit = Math.min(params.limit ?? 20, 100);

  // Filter first, then limit: filtering a pre-truncated page silently returns
  // fewer rows than asked for.
  const local = deps.deadLetter
    .list(500)
    .filter((r) => params.routeId === undefined || r.routeId === params.routeId)
    .slice(0, limit);

  // Joined rather than returned separately: Hookdeck's view and ours disagree
  // precisely when something interesting happened.
  const rows = local.map((entry) => {
    const row = entry.eventId !== undefined ? deps.ledger.get(entry.eventId) : undefined;
    return {
      eventId: entry.eventId ?? null,
      routeId: entry.routeId ?? null,
      ourCode: entry.code,
      reason: entry.reason,
      retriesCancelled: entry.retriesCancelled,
      lastAttempt: entry.lastAttempt,
      ledgerStatus: row?.status ?? null,
      attempt: row?.attempt ?? entry.attemptCount ?? null,
      at: new Date(entry.createdAt).toISOString(),
    };
  });

  return {
    deadLetters: rows,
    note:
      rows.length === 0
        ? "Nothing dead-lettered. Successful deliveries leave no local record by design, so an empty result means nothing has been given up on — not that nothing arrived. Use hookdeck_status for throughput, or Hookdeck's event log for the full picture."
        : undefined,
  };
}

// ---------------------------------------------------------------------------
// inspect one event — the "why did THIS fail?" tool
// ---------------------------------------------------------------------------

export async function inspectEventHandler(deps: ToolDeps, params: { eventId: string }) {
  const row = deps.ledger.get(params.eventId);
  const dead = deps.deadLetter.list(500).find((d) => d.eventId === params.eventId);

  const local = {
    ledger: row ?? null,
    deadLetter: dead ?? null,
  };

  const client = requireClient(deps);
  if (isError(client)) return { local, hookdeck: null, note: client.error };

  const event = await client.getEvent(params.eventId);
  if (!event.ok) return { local, hookdeck: null, note: `Hookdeck lookup failed: ${event.message}` };

  return {
    local,
    hookdeck: {
      id: event.data.id,
      status: event.data.status ?? null,
      attempts: event.data.attempts ?? null,
      responseStatus: event.data.response_status ?? null,
      createdAt: event.data.created_at ?? null,
    },
  };
}

// ---------------------------------------------------------------------------
// doctor
// ---------------------------------------------------------------------------

export async function doctorHandler(deps: ToolDeps) {
  const checks: { name: string; ok: boolean; detail: string }[] = [];

  const secretConfigured =
    deps.config.signingSecret !== undefined ||
    Object.values(deps.config.routes).some((r) => r.signingSecret !== undefined);
  checks.push({
    name: "signing secret",
    ok: secretConfigured,
    detail: secretConfigured
      ? "configured"
      : "absent — every delivery is rejected with a retryable 503 until one is set",
  });

  const stats = deps.ledger.stats();
  checks.push({
    name: "ledger persistence",
    ok: stats.persistence !== "disabled",
    detail:
      stats.persistence === "disabled"
        ? `disabled after a write failure (${stats.firstError ?? "unknown"}); a restart may now re-run work`
        : reportedPersistence(stats.persistence),
  });

  const orphans = deps.ledger.listOrphans().length;
  checks.push({
    name: "interrupted work",
    ok: orphans === 0,
    detail: orphans === 0 ? "none" : `${orphans} row(s) left running by a previous process`,
  });

  checks.push({
    name: "api key",
    ok: deps.client !== undefined,
    detail:
      deps.client !== undefined
        ? "configured"
        : "absent — provisioning, pause/resume, replay and crash recovery are unavailable",
  });

  for (const [routeId, route] of Object.entries(deps.config.routes)) {
    const cursor = deps.cursors.get(routeId);
    const hasConnection = cursor?.connectionId !== undefined;
    checks.push({
      name: `route ${routeId}: connection`,
      ok: hasConnection,
      detail: hasConnection
        ? `${cursor!.connectionId}`
        : "unknown — pause-on-shutdown and catch-up cannot run for this route",
    });

    // The check that matters most, and the one nothing else surfaces: a retry
    // rule narrower than what we emit means events are answered expecting a
    // redelivery that never comes, with nothing recording the choice.
    if (deps.client !== undefined && cursor?.connectionId !== undefined) {
      const connection = await deps.client.getConnection(cursor.connectionId);
      if (connection.ok) {
        const retry = connection.data.rules?.find((r) => r.type === "retry");
        const missing = uncoveredStatuses(retry?.response_status_codes);
        checks.push({
          name: `route ${routeId}: retry rule`,
          ok: missing.length === 0,
          detail:
            missing.length === 0
              ? `covers ${RETRYABLE_STATUS_CODES.join(", ")}`
              : `does NOT cover ${missing.join(", ")} — events answered with those codes will never be retried`,
        });
      }
    }

    void route;
  }

  return { ok: checks.every((c) => c.ok), checks };
}

// ---------------------------------------------------------------------------
// setup (provisioning)
// ---------------------------------------------------------------------------

export async function setupHandler(
  deps: ToolDeps,
  params: { routeId?: string; dryRun?: boolean },
) {
  const client = requireClient(deps);
  if (isError(client)) return { applied: false, note: client.error };

  const dryRun = params.dryRun ?? true;
  const results: Record<string, unknown>[] = [];

  for (const [routeId, route] of Object.entries(deps.config.routes)) {
    if (params.routeId !== undefined && routeId !== params.routeId) continue;
    if (!route.enabled) continue;

    const path = `${deps.config.ingress.basePath}${route.path}`;
    const spec = buildConnectionSpec({
      routeId,
      source: route.source,
      path,
      kind: deps.config.transport.mode === "http" ? "HTTP" : "CLI",
      ...(deps.config.transport.publicUrl !== undefined
        ? { url: `${deps.config.transport.publicUrl.replace(/\/+$/, "")}${path}` }
        : {}),
    });
    const print = fingerprint(spec);
    const unchanged = deps.cursors.get(routeId)?.provisioningFingerprint === print;

    if (dryRun) {
      // Summarised rather than dumped: the spec carries `source.config.auth`
      // and `destination.config.auth`, and a provider webhook secret must not
      // be echoed into a model's context because someone asked what would
      // change.
      results.push({
        routeId,
        wouldApply: !unchanged,
        unchanged,
        summary: {
          connectionName: spec.name,
          source: (spec.source as { name: string }).name,
          destination: {
            name: (spec.destination as { name: string }).name,
            type: (spec.destination as { type: string }).type,
          },
          rules: spec.rules.map((r) => r.type),
          retryStatuses: RETRYABLE_STATUS_CODES,
        },
      });
      continue;
    }

    const result = await client.upsertConnection(spec);
    if (!result.ok) {
      results.push({ routeId, applied: false, error: result.message });
      continue;
    }
    await deps.cursors.patch(routeId, {
      provisioningFingerprint: print,
      connectionId: result.data.id,
    });
    results.push({ routeId, applied: true, connectionId: result.data.id });
  }

  return { dryRun, results };
}

// ---------------------------------------------------------------------------
// pause / resume
// ---------------------------------------------------------------------------

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
  params: { routeId: string; paused: boolean; reason?: string; autoResumeAfterSeconds?: number },
  schedule?: (fn: () => void, ms: number) => (() => void) | void,
) {
  const client = requireClient(deps);
  if (isError(client)) return { ok: false, note: client.error };

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
    if (typeof cancel === "function") autoResumeCancels.set(params.routeId, cancel);

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
  return { ok: true, paused: false, note: "Held events will be delivered with trigger UNPAUSE." };
}

// ---------------------------------------------------------------------------
// replay
// ---------------------------------------------------------------------------

export async function replayHandler(
  deps: ToolDeps,
  params: { eventIds?: string[]; routeId?: string; sinceMinutes?: number; confirm?: boolean },
) {
  const client = requireClient(deps);
  if (isError(client)) return { ok: false, note: client.error };

  if (params.eventIds !== undefined && params.eventIds.length > 0) {
    const MAX_EVENT_IDS = 100;
    const accepted = params.eventIds.slice(0, MAX_EVENT_IDS);
    const dropped = params.eventIds.length - accepted.length;
    const outcomes = [];
    for (const id of accepted) {
      const result = await client.retryEvent(id);
      outcomes.push({ eventId: id, ok: result.ok, ...(result.ok ? {} : { error: result.message }) });
    }
    return {
      ok: true,
      mode: "events",
      outcomes,
      // Never truncate quietly: a caller who passed 250 ids and saw "ok" would
      // reasonably believe all 250 were retried.
      ...(dropped > 0
        ? { dropped, note: `Only the first ${MAX_EVENT_IDS} ids were retried; ${dropped} were not. Call again with the rest.` }
        : {}),
    };
  }

  if (params.routeId === undefined || params.sinceMinutes === undefined) {
    return {
      ok: false,
      note: "Provide eventIds, or routeId plus sinceMinutes to scope a bulk replay.",
    };
  }

  const cursor = deps.cursors.get(params.routeId);
  if (cursor?.connectionId === undefined) {
    return { ok: false, note: `No connection id known for route '${params.routeId}'.` };
  }

  // An unscoped retry-everything costs real money, so a filtered replay is a
  // dry run until explicitly confirmed.
  if (params.confirm !== true) {
    return {
      ok: false,
      dryRun: true,
      note:
        `Would replay requests for route '${params.routeId}' from the last ${params.sinceMinutes} minute(s) ` +
        `that produced no CLI event. Re-run with confirm: true to execute.`,
    };
  }

  const now = deps.now ?? Date.now;
  const result = await runCatchUp({
    client,
    logger: deps.logger,
    connectionId: cursor.connectionId,
    sinceMs: now() - params.sinceMinutes * 60_000,
    minGapMs: 0,
    now,
  });

  return result.ran
    ? { ok: true, mode: "bulk", batchId: result.batchId ?? null, estimated: result.estimated ?? null }
    : { ok: false, note: `replay did not run: ${result.reason}` };
}

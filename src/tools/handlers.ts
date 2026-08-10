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
  ledger: Ledger;
  deadLetter: DeadLetterLog;
  cursors: CursorStore;
  inFlight: InFlightRegistry;
  logger: Logger;
  client?: HookdeckClient | undefined;
  transportStatus(): Record<string, { state: string; restarts: number; recent: string[] }>;
  retryCancels(): Record<string, number>;
  configWarnings(): { path: string; message: string }[];
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
    const issues = await deps.client.listIssues({ status: "OPENED", limit: 100 });
    openIssues = issues.ok ? issues.data.length : null;
  }

  return {
    routes,
    inFlight: { current: deps.inFlight.size, max: deps.inFlight.capacity },
    ledger: {
      entries: ledgerStats.entries,
      running: ledgerStats.running,
      // Says so out loud rather than implying a guarantee we are not making.
      persistence: ledgerStats.persistence,
      ...(ledgerStats.firstError !== undefined ? { firstError: ledgerStats.firstError } : {}),
    },
    deadLetters: deps.deadLetter.count(),
    retryCancellations: deps.retryCancels(),
    transport: { mode: deps.config.transport.mode, listeners: deps.transportStatus() },
    openIssues,
    configWarnings: deps.configWarnings(),
  };
}

// ---------------------------------------------------------------------------
// recent deliveries — the "did anything break overnight?" tool
// ---------------------------------------------------------------------------

export async function recentDeliveriesHandler(
  deps: ToolDeps,
  params: { routeId?: string; outcome?: "failed" | "succeeded" | "all"; limit?: number },
) {
  const limit = Math.min(params.limit ?? 20, 100);
  const outcome = params.outcome ?? "all";

  const local = deps.deadLetter
    .list(limit)
    .filter((r) => params.routeId === undefined || r.routeId === params.routeId);

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

  const filtered =
    outcome === "all"
      ? rows
      : rows.filter((r) => (outcome === "succeeded" ? r.ledgerStatus === "succeeded" : r.ledgerStatus !== "succeeded"));

  return {
    deadLetters: filtered,
    note:
      filtered.length === 0
        ? "Nothing dead-lettered. Deliveries that succeeded leave no local record by design — check Hookdeck for the full event log."
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
        : stats.persistence,
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
      results.push({ routeId, wouldApply: !unchanged, unchanged, spec });
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

export async function pauseHandler(
  deps: ToolDeps,
  params: { routeId: string; paused: boolean; reason?: string; autoResumeAfterSeconds?: number },
  schedule?: (fn: () => void, ms: number) => void,
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
    schedule?.(() => {
      void pauseHandler(deps, { routeId: params.routeId, paused: false });
    }, seconds * 1000);

    return {
      ok: true,
      paused: true,
      autoResumeAfterSeconds: seconds,
      note: "Events are held at HOLD and delivered on resume. Nothing is dropped.",
    };
  }

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
    const outcomes = [];
    for (const id of params.eventIds.slice(0, 100)) {
      const result = await client.retryEvent(id);
      outcomes.push({ eventId: id, ok: result.ok, ...(result.ok ? {} : { error: result.message }) });
    }
    return { ok: true, mode: "events", outcomes };
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

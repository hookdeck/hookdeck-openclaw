import { type ToolDeps } from "./deps.js";

/**
 * `hookdeck_status` — the one call to make if you can only make one.
 */

/**
 * `readonly` describes OUR handle on the file, not the system's health. Leaking
 * it into status invited a real misreading: an agent reported that events were
 * "stuck with no automatic retry path" because persistence was read-only, when
 * the Gateway was persisting normally and the reader simply had a read-only
 * view. `source` already carries that nuance.
 */
export function reportedPersistence(state: string): string {
  return state === "readonly" ? "active" : state;
}

export async function statusHandler(
  deps: ToolDeps,
  params: { routeId?: string },
) {
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
      ...(ledgerStats.firstError !== undefined
        ? { firstError: ledgerStats.firstError }
        : {}),
    },
    deadLetters: deps.deadLetter.count(),
    retryCancellations: deps.retryCancels?.() ?? null,
    transport: {
      mode: deps.config.transport.mode,
      listeners: deps.transportStatus?.() ?? null,
    },
    openIssues,
    configWarnings: deps.configWarnings(),
  };
}

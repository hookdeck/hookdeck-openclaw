import { runCatchUp } from "../catchup.js";
import type { HookdeckClient } from "../hookdeck/client.js";
import {
  buildConnectionSpec,
  fingerprint,
  routeProvisionSpec,
  type ProvisionRouteSpec,
} from "../hookdeck/provision.js";
import type { Logger } from "../ingress/handler.js";
import type {
  HookdeckPluginConfig,
  RouteConfig,
} from "../plugin/config-types.js";
import type { CursorStore } from "../store/cursor-store.js";
import {
  createCliListener,
  type CliListener,
  type SpawnChild,
} from "./cli-transport.js";
import { checkCliVersion, describeShadowing } from "./cli-version.js";

/**
 * Owns everything that talks to Hookdeck's control plane or supervises a child:
 * provisioning, the CLI listeners, pause/unpause, and outage catch-up.
 *
 * Kept out of `index.ts` so the ordering rules below are testable, because the
 * ordering is where the data loss lives:
 *
 *  - **pause before stopping the listener.** A clean CLI shutdown tombstones
 *    the session immediately and forfeits the server's ~2 minute grace window,
 *    so events that arrive next become `CLI_DISCONNECTED` ignored events and
 *    the request is discarded. Paused, they are held at `HOLD` instead.
 *  - **write `pausedByUs` before calling pause**, so a crash mid-shutdown still
 *    leaves the breadcrumb that unpauses on the next start. A connection left
 *    paused forever is a silent outage.
 *  - **write `lastDisconnectAt` on every listener exit**, since it is the only
 *    durable evidence of the window a catch-up query needs to bound.
 */

export interface TransportManagerDeps {
  config: HookdeckPluginConfig;
  cursors: CursorStore;
  logger: Logger;
  client?: HookdeckClient | undefined;
  spawn: SpawnChild;
  /**
   * Resolved from plugin config, not read from the ambient environment: an
   * operator who configures a secretRef expects that key to be used, and
   * silently falling back to whatever `HOOKDECK_API_KEY` happens to be set to
   * is both surprising and hard to debug.
   */
  apiKey?: string | undefined;
  resolveBinary(name: string): Promise<{ path: string; all: string[] }>;
  /** Resolves a route's provider credentials; they are secret inputs like any other. */
  resolveVerification?(
    routeId: string,
  ): Promise<Record<string, string> | undefined>;
  readVersion(path: string): Promise<string>;
  now?(): number;
}

export interface TransportManager {
  start(): Promise<void>;
  stop(): Promise<void>;
  status(): Record<
    string,
    { state: string; restarts: number; recent: string[] }
  >;
}

export function createTransportManager(
  deps: TransportManagerDeps,
): TransportManager {
  const { config, cursors, logger } = deps;
  const now = deps.now ?? Date.now;
  const listeners = new Map<string, CliListener>();
  let started = false;

  /**
   * Stamps the start of an outage, once.
   *
   * The listener exits on every failed respawn during backoff and on clean
   * shutdown too. Overwriting the stamp each time slides the catch-up window
   * forward, so the events from the original outage fall outside every window
   * that is ever queried and are never replayed. The cursor is cleared after a
   * successful catch-up, so an existing value always means "not yet
   * recovered" and must be left alone.
   */
  async function recordDisconnect(routeId: string): Promise<void> {
    if (cursors.get(routeId)?.lastDisconnectAt !== undefined) return;
    await cursors.patch(routeId, { lastDisconnectAt: now() });
  }

  async function specFor(
    routeId: string,
    route: RouteConfig,
  ): Promise<ProvisionRouteSpec> {
    const credentials =
      route.verification !== undefined
        ? await deps.resolveVerification?.(routeId)
        : undefined;
    return routeProvisionSpec({ config, routeId, route, credentials });
  }

  /** Adopts an operator-supplied connection id, so pause and catch-up work
   * without provisioning having run. */
  async function seedConfiguredConnectionIds(): Promise<void> {
    for (const [routeId, route] of Object.entries(config.routes)) {
      if (route.connectionId === undefined) continue;
      if (cursors.get(routeId)?.connectionId === route.connectionId) continue;
      await cursors.patch(routeId, { connectionId: route.connectionId });
    }
  }

  async function provision(): Promise<void> {
    if (!config.provisioning.enabled || deps.client === undefined) return;

    for (const [routeId, route] of Object.entries(config.routes)) {
      if (!route.enabled) continue;
      const spec = buildConnectionSpec(await specFor(routeId, route));
      const print = fingerprint(spec);
      const cursor = cursors.get(routeId);

      if (
        !config.provisioning.force &&
        cursor?.provisioningFingerprint === print
      ) {
        logger.debug(
          `route '${routeId}': provisioning unchanged, skipping upsert`,
        );
        continue;
      }

      const result = await deps.client.upsertConnection(spec);
      if (!result.ok) {
        // Never fatal: an operator may have provisioned by hand, and a Gateway
        // that will not boot is worse than one that is not provisioned.
        logger.warn(
          `route '${routeId}': provisioning failed (${result.message})`,
        );
        continue;
      }
      await cursors.patch(routeId, {
        provisioningFingerprint: print,
        connectionId: result.data.id,
      });
      logger.info(
        `route '${routeId}': connection ${result.data.id} provisioned`,
      );
    }
  }

  async function unpauseIfWePaused(routeId?: string): Promise<void> {
    if (deps.client === undefined) return;
    for (const cursor of cursors.all()) {
      if (routeId !== undefined && cursor.routeId !== routeId) continue;
      if (cursor.pausedByUs !== true || cursor.connectionId === undefined)
        continue;
      // An operator's pause is a decision, not a breadcrumb: a reconnecting
      // tunnel must not undo it.
      if (cursor.pauseReason === "operator") {
        logger.info(
          `route '${cursor.routeId}': left paused; it was paused deliberately, not by a shutdown`,
        );
        continue;
      }
      const result = await deps.client.unpauseConnection(cursor.connectionId);
      if (result.ok) {
        await cursors.patch(cursor.routeId, { pausedByUs: false });
        logger.info(
          `route '${cursor.routeId}': unpaused; held events will be delivered`,
        );
      } else {
        logger.warn(
          `route '${cursor.routeId}': could not unpause (${result.message})`,
        );
      }
    }
  }

  async function catchUp(routeId?: string): Promise<void> {
    if (!config.catchUp.enabled || deps.client === undefined) return;
    const routeIds =
      routeId === undefined ? Object.keys(config.routes) : [routeId];
    for (const routeId of routeIds) {
      const cursor = cursors.get(routeId);
      if (
        cursor?.lastDisconnectAt === undefined ||
        cursor.connectionId === undefined
      )
        continue;

      const result = await runCatchUp({
        client: deps.client,
        logger,
        connectionId: cursor.connectionId,
        sinceMs: cursor.lastDisconnectAt,
        minGapMs: config.catchUp.minGapSeconds * 1000,
        now,
      });
      if (result.ran) {
        logger.info(
          `route '${routeId}': catch-up replay queued${
            result.estimated !== undefined
              ? ` (~${result.estimated} requests)`
              : ""
          }`,
        );
        // Cleared on accepted rather than on delivered, which is sound only
        // because this runs with a listener attached: from here the replayed
        // requests are events in Hookdeck's own retry pipeline, so a tunnel
        // that drops again fails them retryably instead of discarding them.
        await cursors.clear(routeId, "lastDisconnectAt");
      }
    }
  }

  /**
   * Releases held events and replays the outage window for one route, once its
   * listener is actually attached.
   *
   * Ordering is the whole point. Under CLI transport an event delivered with no
   * session attached is discarded rather than queued, so unpausing or replaying
   * before the tunnel is up sends the recovered traffic into nothing and it is
   * gone for good. With a session attached a delivery that fails is
   * `CLI_UNAVAILABLE` and stays in the retry pipeline, which is also what makes
   * it safe to clear the disconnect cursor once the replay is accepted.
   *
   * Also runs on every reconnect, not only at boot: a tunnel that drops and
   * returns has its own outage window to recover.
   */
  async function recoverRoute(routeId: string): Promise<void> {
    try {
      await unpauseIfWePaused(routeId);
      await catchUp(routeId);
    } catch (err) {
      logger.warn(
        `route '${routeId}': recovery after connect failed: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }

  async function startListeners(apiKey: string | undefined): Promise<void> {
    if (config.transport.mode !== "cli") return;

    const { path: binaryPath, all } = await deps.resolveBinary(
      config.transport.binaryPath,
    );
    const shadowWarning = describeShadowing(all);
    if (shadowWarning !== undefined) logger.warn(shadowWarning);

    let versionOutput: string;
    try {
      versionOutput = await deps.readVersion(binaryPath);
    } catch (err) {
      logger.warn(
        `could not run '${binaryPath} version' (${err instanceof Error ? err.message : err}); ` +
          `transport not started. Ingress still serves.`,
      );
      return;
    }

    const check = checkCliVersion(versionOutput);
    if (!check.ok) {
      if (!config.transport.allowUnsupportedVersion) {
        // A hard gate, because the failure it prevents is invisible: the CLI
        // stays connected, reports itself healthy, and stops delivering.
        logger.warn(
          `${check.message} Transport not started; ingress still serves.`,
        );
        return;
      }
      logger.warn(
        `${check.message} Continuing because allowUnsupportedVersion is set.`,
      );
    }

    for (const [routeId, route] of Object.entries(config.routes)) {
      if (!route.enabled) continue;
      const listener = createCliListener(
        {
          routeId,
          source: route.source,
          port: config.transport.port,
          path: `${config.ingress.basePath}${route.path}`,
          binaryPath,
          apiKey,
        },
        {
          spawn: deps.spawn,
          logger,
          onDisconnect: (id) => recordDisconnect(id),
          onConnected: (id) => recoverRoute(id),
          now,
        },
      );
      listeners.set(routeId, listener);
      listener.start();
    }
  }

  return {
    async start() {
      // A second start would orphan the children the first one spawned, with no
      // handle left to kill them.
      if (started) {
        logger.warn("transport already started; ignoring a second start()");
        return;
      }
      started = true;

      await seedConfiguredConnectionIds();
      await provision();

      // Under CLI transport, recovery is driven by `onConnected` per route:
      // replaying into a tunnel that is not up yet discards the events. Other
      // modes have no attach event and the destination is always reachable, so
      // they recover immediately.
      if (config.transport.mode === "cli") {
        // Passed to the child via env only, never argv.
        await startListeners(deps.apiKey);
      } else {
        await unpauseIfWePaused();
        await catchUp();
      }
    },

    async stop() {
      started = false;

      // Bounded as a whole. Pausing is a network call per route, and against an
      // unreachable API the per-call timeout alone would multiply by the route
      // count while the Gateway waits to exit.
      const budgetMs = config.pause.shutdownTimeoutMs;
      const deadline = now() + budgetMs;
      const withinBudget = (): boolean => now() < deadline;
      // Pause FIRST. Stopping the listener cleanly forfeits the grace window,
      // so anything arriving between the two would be discarded rather than
      // held.
      if (config.pause.onShutdown && deps.client !== undefined) {
        for (const cursor of cursors.all()) {
          if (cursor.connectionId === undefined) continue;
          // Only routes still configured. A route removed from config is not
          // ours to pause, and in CLI mode nothing would ever unpause it: the
          // resume runs from a listener attaching, and it has no listener.
          if (config.routes[cursor.routeId] === undefined) continue;

          if (!withinBudget()) {
            logger.warn(
              `shutdown budget of ${budgetMs}ms spent; remaining routes were not paused. ` +
                `Events arriving before the next start may be discarded rather than held.`,
            );
            break;
          }

          // Breadcrumb before the call: a crash here still unpauses next start.
          await cursors.patch(cursor.routeId, {
            pausedByUs: true,
            pauseReason: "shutdown",
          });
          const result = await deps.client.pauseConnection(cursor.connectionId);
          if (!result.ok) {
            logger.warn(
              `route '${cursor.routeId}': could not pause (${result.message})`,
            );
            await cursors.patch(cursor.routeId, { pausedByUs: false });
          }
        }
      }

      await Promise.all(
        [...listeners.values()].map((l) => l.stop().catch(() => {})),
      );
      listeners.clear();
    },

    status() {
      const out: Record<
        string,
        { state: string; restarts: number; recent: string[] }
      > = {};
      for (const [routeId, listener] of listeners) {
        out[routeId] = {
          state: listener.state,
          restarts: listener.restarts,
          recent: listener.recentOutput().slice(-10),
        };
      }
      return out;
    },
  };
}

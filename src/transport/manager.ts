import { runCatchUp } from "../catchup.js";
import type { HookdeckClient } from "../hookdeck/client.js";
import { buildConnectionSpec, fingerprint, type ProvisionRouteSpec } from "../hookdeck/provision.js";
import type { Logger } from "../ingress/handler.js";
import type { HookdeckPluginConfig, RouteConfig } from "../plugin/config-types.js";
import type { CursorStore } from "../store/cursor-store.js";
import { createCliListener, type CliListener, type SpawnChild } from "./cli-transport.js";
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
  resolveVerification?(routeId: string): Promise<Record<string, string> | undefined>;
  readVersion(path: string): Promise<string>;
  now?(): number;
}

export interface TransportManager {
  start(): Promise<void>;
  stop(): Promise<void>;
  status(): Record<string, { state: string; restarts: number; recent: string[] }>;
}

export function createTransportManager(deps: TransportManagerDeps): TransportManager {
  const { config, cursors, logger } = deps;
  const now = deps.now ?? Date.now;
  const listeners = new Map<string, CliListener>();

  async function specFor(routeId: string, route: RouteConfig): Promise<ProvisionRouteSpec> {
    const credentials =
      route.verification !== undefined ? await deps.resolveVerification?.(routeId) : undefined;
    const path = `${config.ingress.basePath}${route.path}`;
    return {
      routeId,
      source: route.source,
      path,
      kind: config.transport.mode === "http" ? "HTTP" : "CLI",
      ...(config.transport.publicUrl !== undefined
        ? { url: `${config.transport.publicUrl.replace(/\/+$/, "")}${path}` }
        : {}),
      ...(config.provisioning.dedupeWindowMs !== undefined
        ? { dedupeWindowMs: config.provisioning.dedupeWindowMs }
        : {}),
      ...(route.verification !== undefined && credentials !== undefined
        ? { sourceAuthType: route.verification.provider, sourceAuth: credentials }
        : {}),
    };
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

      if (!config.provisioning.force && cursor?.provisioningFingerprint === print) {
        logger.debug(`route '${routeId}': provisioning unchanged, skipping upsert`);
        continue;
      }

      const result = await deps.client.upsertConnection(spec);
      if (!result.ok) {
        // Never fatal: an operator may have provisioned by hand, and a Gateway
        // that will not boot is worse than one that is not provisioned.
        logger.warn(`route '${routeId}': provisioning failed (${result.message})`);
        continue;
      }
      await cursors.patch(routeId, {
        provisioningFingerprint: print,
        connectionId: result.data.id,
      });
      logger.info(`route '${routeId}': connection ${result.data.id} provisioned`);
    }
  }

  async function unpauseIfWePaused(): Promise<void> {
    if (deps.client === undefined) return;
    for (const cursor of cursors.all()) {
      if (cursor.pausedByUs !== true || cursor.connectionId === undefined) continue;
      const result = await deps.client.unpauseConnection(cursor.connectionId);
      if (result.ok) {
        await cursors.patch(cursor.routeId, { pausedByUs: false });
        logger.info(`route '${cursor.routeId}': unpaused; held events will be delivered`);
      } else {
        logger.warn(`route '${cursor.routeId}': could not unpause (${result.message})`);
      }
    }
  }

  async function catchUp(): Promise<void> {
    if (!config.catchUp.enabled || deps.client === undefined) return;
    for (const routeId of Object.keys(config.routes)) {
      const cursor = cursors.get(routeId);
      if (cursor?.lastDisconnectAt === undefined || cursor.connectionId === undefined) continue;

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
            result.estimated !== undefined ? ` (~${result.estimated} requests)` : ""
          }`,
        );
        await cursors.clear(routeId, "lastDisconnectAt");
      }
    }
  }

  async function startListeners(apiKey: string | undefined): Promise<void> {
    if (config.transport.mode !== "cli") return;

    const { path: binaryPath, all } = await deps.resolveBinary(config.transport.binaryPath);
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
        logger.warn(`${check.message} Transport not started; ingress still serves.`);
        return;
      }
      logger.warn(`${check.message} Continuing because allowUnsupportedVersion is set.`);
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
          onDisconnect: (id) => cursors.patch(id, { lastDisconnectAt: now() }),
          now,
        },
      );
      listeners.set(routeId, listener);
      listener.start();
    }
  }

  return {
    async start() {
      await seedConfiguredConnectionIds();
      await provision();
      await unpauseIfWePaused();
      await catchUp();
      // Passed to the child via env only, never argv.
      await startListeners(deps.apiKey);
    },

    async stop() {
      // Pause FIRST. Stopping the listener cleanly forfeits the grace window,
      // so anything arriving between the two would be discarded rather than
      // held.
      if (config.pause.onShutdown && deps.client !== undefined) {
        for (const cursor of cursors.all()) {
          if (cursor.connectionId === undefined) continue;
          // Breadcrumb before the call: a crash here still unpauses next start.
          await cursors.patch(cursor.routeId, { pausedByUs: true });
          const result = await deps.client.pauseConnection(cursor.connectionId);
          if (!result.ok) {
            logger.warn(`route '${cursor.routeId}': could not pause (${result.message})`);
            await cursors.patch(cursor.routeId, { pausedByUs: false });
          }
        }
      }

      await Promise.all([...listeners.values()].map((l) => l.stop().catch(() => {})));
      listeners.clear();
    },

    status() {
      const out: Record<string, { state: string; restarts: number; recent: string[] }> = {};
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

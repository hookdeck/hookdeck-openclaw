import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";

import { parseHookdeckConfig } from "./src/plugin/config-parse.js";
import type { HookdeckPluginConfig, RouteConfig } from "./src/plugin/config-types.js";
import type { OpenClawPluginApi, OpenClawPluginServiceContext } from "./src/plugin/host-api.js";
import { createHostSecretResolver } from "./src/plugin/host-secrets.js";
import { resolveSecret, UnresolvedSecretError } from "./src/plugin/secrets.js";
import { createAgentDispatcher } from "./src/dispatch/agent.js";
import { createTaskFlowRunner } from "./src/dispatch/runners.js";
import { createTaskFlowDispatcher } from "./src/dispatch/taskflow.js";
import type { Dispatcher } from "./src/dispatch/types.js";
import { createWakeDispatcher } from "./src/dispatch/wake.js";
import { createHookdeckClient, type HookdeckClient } from "./src/hookdeck/client.js";
import { handleDelivery, writePlan, type Logger } from "./src/ingress/handler.js";
import { deferFor, retryable } from "./src/protocol/outcome.js";
import { reconcileOrphans } from "./src/recovery.js";
import { registerHookdeckTools } from "./src/tools/index.js";
import type { ToolDeps } from "./src/tools/handlers.js";
import { createDeadLetterLog, type DeadLetterLog } from "./src/store/deadletter.js";
import { createInFlightRegistry, type InFlightRegistry } from "./src/store/in-flight.js";
import { createLedger, type Ledger } from "./src/store/ledger.js";
import { createCursorStore, type CursorStore } from "./src/store/cursor-store.js";
import { createFsStoreIo } from "./src/store/store-io.js";
import { createTransportManager, type TransportManager } from "./src/transport/manager.js";
import { findBinaries, nodeSpawnChild, readCliVersion } from "./src/transport/node-spawn.js";

const PLUGIN_ID = "hookdeck";

interface Runtime {
  ledger: Ledger;
  deadLetter: DeadLetterLog;
  inFlight: InFlightRegistry;
  cursors: CursorStore;
  transport: TransportManager;
  client?: HookdeckClient | undefined;
}

export default definePluginEntry({
  id: PLUGIN_ID,
  name: "Hookdeck",
  description:
    "Reliable webhooks for OpenClaw. Verified, deduplicated and retryable event delivery via the Hookdeck Event Gateway.",

  register(api: OpenClawPluginApi) {
    const log: Logger = {
      debug: (m) => api.logger?.debug?.(m),
      info: (m) => api.logger?.info?.(m),
      warn: (m) => api.logger?.warn?.(m),
    };

    const parsed = parseHookdeckConfig(api.pluginConfig);

    if (!parsed.ok) {
      // Never throw: a bad config must not stop the Gateway booting. The route
      // is still registered so deliveries get a retryable 503 rather than a
      // 404, keeping them alive in Hookdeck until the config is fixed.
      for (const problem of parsed.problems) {
        api.logger?.error?.(`config error at ${problem.path}: ${problem.message}`);
      }
      api.registerHttpRoute({
        path: "/hookdeck",
        auth: "plugin",
        match: "prefix",
        replaceExisting: true,
        handler: (_req, res) => {
          res.statusCode = 503;
          res.setHeader("retry-after", "60");
          res.setHeader("content-type", "application/json; charset=utf-8");
          res.end(JSON.stringify({ ok: false, code: "config_error", problems: parsed.problems }));
          return true;
        },
      });
      return;
    }

    const config: HookdeckPluginConfig = parsed.config;
    for (const warning of parsed.warnings) {
      log.warn(`config: ${warning.path}: ${warning.message}`);
    }

    const instanceId = randomUUID();
    const retryCancels = new Map<string, number>();

    // Populated at service start, when stateDir and the live OpenClawConfig
    // become available.
    let runtime: Runtime | undefined;
    let hostConfig: OpenClawPluginServiceContext["config"] | undefined;
    const hostSecrets = createHostSecretResolver(() => hostConfig);

    const dispatchers = new Map<string, Dispatcher>();
    const dispatcherFor = (routeId: string, route: RouteConfig): Dispatcher => {
      const existing = dispatchers.get(routeId);
      if (existing !== undefined) return existing;

      const active = runtime;
      if (active === undefined) throw new Error("dispatcher requested before service start");

      let dispatcher: Dispatcher;
      switch (route.dispatch.mode) {
        case "wake":
          dispatcher = createWakeDispatcher(route.dispatch, api.runtime.system);
          break;

        case "taskflow": {
          const { sessionKey, controllerId, allowedActions } = route.dispatch;
          dispatcher = createTaskFlowDispatcher(
            {
              controllerId: controllerId ?? `hookdeck/${routeId}`,
              ...(allowedActions !== undefined ? { allowedActions } : {}),
              hostConfig,
            },
            // Bound per dispatch rather than captured: the host resolves flow
            // state against the live session each time.
            () => api.runtime.tasks.managedFlows.bindSession({ sessionKey }),
          );
          break;
        }

        case "agent": {
          const d = route.dispatch;
          dispatcher = createAgentDispatcher(
            {
              sessionKey: d.sessionKey,
              prompt: d.prompt,
              ackMode: d.ackMode ?? "async_retry",
              syncTimeoutSeconds: d.syncTimeoutSeconds ?? 45,
              maxAgentRetries: d.maxAgentRetries ?? 3,
              deliver: d.deliver ?? false,
              ...(d.lane !== undefined ? { lane: d.lane } : {}),
              maxConcurrentRuns: config.maxConcurrent,
              busyRetryAfterSeconds: config.busyRetryAfterSeconds,
            },
            {
              // TaskFlow run_task rather than subagent.run: a plugin-auth
              // route carries no operator scopes, so subagent.run is refused
              // with `missing scope: operator.write`. See dispatch/runners.ts.
              runner: createTaskFlowRunner({
                controllerId: `hookdeck/${routeId}`,
                bind: (sessionKey) => api.runtime.tasks.managedFlows.bindSession({ sessionKey }),
              }),
              ledger: active.ledger,
              deadLetter: active.deadLetter,
              logger: log,
              client: active.client,
            },
          );
          break;
        }
      }

      dispatchers.set(routeId, dispatcher);
      return dispatcher;
    };

    // Registered up front so the surface exists from the first turn; each tool
    // reports "not started yet" rather than throwing if it is called early.
    registerHookdeckTools(api, {
      allowMutations: config.tools.allowMutations,
      deps: (): ToolDeps | undefined => {
        const active = runtime;
        if (active === undefined) return undefined;
        return {
          config,
          ledger: active.ledger,
          deadLetter: active.deadLetter,
          cursors: active.cursors,
          inFlight: active.inFlight,
          logger: log,
          client: active.client,
          transportStatus: () => active.transport.status(),
          retryCancels: () => Object.fromEntries(retryCancels),
          configWarnings: () => parsed.warnings,
        };
      },
      schedule: (fn, ms) => {
        const timer = setTimeout(fn, ms);
        timer.unref?.();
        return () => clearTimeout(timer);
      },
    });

    const respondStarting = (res: Parameters<typeof writePlan>[0]) =>
      writePlan(
        res,
        { plan: deferFor(503, "starting", 30, "plugin is still starting"), extra: {} },
        { allowRetryCancel: config.safety.allowRetryCancel },
      );

    api.registerHttpRoute({
      path: config.ingress.basePath,
      auth: "plugin",
      match: "prefix",
      replaceExisting: true,
      handler: async (req, res) => {
        const active = runtime;
        if (active === undefined) {
          // Events arriving during boot are preserved rather than lost.
          respondStarting(res);
          return true;
        }

        try {
          const handled = await handleDelivery(
            {
              config,
              ledger: active.ledger,
              deadLetter: active.deadLetter,
              inFlight: active.inFlight,
              logger: log,
              dispatcherFor,
              onRetryCancel: (reason) =>
                retryCancels.set(reason, (retryCancels.get(reason) ?? 0) + 1),
              resolveSigningSecret: async (routeId, route) =>
                route.signingSecret !== undefined
                  ? resolveSecret(
                      route.signingSecret,
                      `routes.${routeId}.signingSecret`,
                      hostSecrets,
                    )
                  : resolveSecret(config.signingSecret, "signingSecret", hostSecrets),
            },
            { method: req.method, url: req.url, headers: req.headers, stream: req },
          );
          writePlan(res, handled, { allowRetryCancel: config.safety.allowRetryCancel });
        } catch (err) {
          if (err instanceof UnresolvedSecretError) {
            log.warn(err.message);
          } else {
            log.warn(`unhandled error: ${err instanceof Error ? err.stack : String(err)}`);
          }
          // Retryable on purpose: whatever went wrong, the event should survive
          // in Hookdeck rather than being acknowledged into the void.
          writePlan(
            res,
            { plan: retryable(503, "internal_error"), extra: {} },
            { allowRetryCancel: config.safety.allowRetryCancel },
          );
        }
        return true;
      },
    });

    api.registerService({
      id: `${PLUGIN_ID}-ingress`,

      async start(ctx) {
        hostConfig = ctx.config;

        const io = config.storage.enabled ? createFsStoreIo() : undefined;
        const stateDir = config.storage.enabled
          ? join(ctx.stateDir, "hookdeck")
          : undefined;

        const onDegrade = (error: unknown, path: string) => {
          // Logged once, by contract. Persistence stays off for the process
          // lifetime — handling must never wedge on a broken disk.
          ctx.logger.warn?.(
            `[hookdeck] persistence disabled after a write failure at ${path}: ${
              error instanceof Error ? error.message : String(error)
            }. Handling continues in memory; a restart may now re-run work.`,
          );
        };

        const ledger = await createLedger({
          ttlHours: config.dedupe.ttlHours,
          instanceId,
          ...(stateDir !== undefined ? { stateDir } : {}),
          ...(io !== undefined ? { io } : {}),
          onDegrade,
        });
        const deadLetter = await createDeadLetterLog({
          ttlHours: config.dedupe.ttlHours,
          maxEntries: config.storage.deadLetterMaxEntries,
          ...(stateDir !== undefined ? { stateDir } : {}),
          ...(io !== undefined ? { io } : {}),
          onDegrade,
        });

        const cursors = await createCursorStore({
          ...(stateDir !== undefined ? { stateDir } : {}),
          ...(io !== undefined ? { io } : {}),
          onDegrade,
        });

        const apiKey = await resolveSecret(config.apiKey, "apiKey", hostSecrets).catch((err) => {
          ctx.logger.warn?.(`[hookdeck] could not resolve apiKey: ${String(err)}`);
          return undefined;
        });
        const client = apiKey !== undefined ? createHookdeckClient({ apiKey }) : undefined;

        // Before serving anything: hand interrupted work back to Hookdeck.
        const summary = await reconcileOrphans({
          ledger,
          deadLetter,
          logger: log,
          client,
          maxEvents: config.recovery.maxEvents,
          enabled: config.recovery.enabled,
        });
        if (summary.found > 0) {
          ctx.logger.info?.(
            `[hookdeck] recovery: ${summary.found} interrupted, ${summary.retried} re-queued, ` +
              `${summary.failed} failed, ${summary.skipped} recorded only`,
          );
        }

        await ledger.prune();

        const transport = createTransportManager({
          config,
          cursors,
          logger: log,
          client,
          ...(apiKey !== undefined ? { apiKey } : {}),
          spawn: nodeSpawnChild,
          resolveBinary: async (name) => {
            const all = await findBinaries(name);
            return { path: all[0] ?? name, all };
          },
          readVersion: readCliVersion,
        });

        runtime = {
          ledger,
          deadLetter,
          cursors,
          transport,
          inFlight: createInFlightRegistry(config.maxConcurrent),
          client,
        };

        // After the ingress is live, so a catch-up replay lands on a route that
        // can serve it.
        await transport.start().catch((err) => {
          ctx.logger.warn?.(`[hookdeck] transport start failed: ${String(err)}`);
        });

        const routes = Object.entries(config.routes).filter(([, r]) => r.enabled);
        const stats = ledger.stats();
        ctx.logger.info?.(
          `[hookdeck] ingress ready on ${config.ingress.basePath} (${routes.length} route${
            routes.length === 1 ? "" : "s"
          }); ledger persistence=${stats.persistence}, ${stats.entries} entries, ` +
            `recovery=${client !== undefined && config.recovery.enabled ? "on" : "off"}`,
        );
        for (const [routeId, route] of routes) {
          ctx.logger.info?.(
            `[hookdeck]   ${config.ingress.basePath}${route.path} <- source '${route.source}' (${route.dispatch.mode})`,
          );
        }
      },

      async stop() {
        // All shutdown work belongs here, not in a `gateway_stop` hook: plugin
        // services are stopped BEFORE those hooks run, and `gateway_stop` is
        // capped at 5s. Connection pause and CLI teardown arrive with the
        // managed transport.
        const active = runtime;
        runtime = undefined;
        hostConfig = undefined;
        // Dispatchers capture the previous lifetime's ledger and client, so a
        // restart must not reuse them.
        dispatchers.clear();
        if (active === undefined) return;

        // Order matters: pause the connection before stopping the listener, or
        // a clean shutdown forfeits the CLI's grace window and events arriving
        // in between are discarded rather than held.
        await active.transport.stop().catch(() => {});

        // Compacts on the way out, so the next boot loads a clean file.
        await active.ledger.close().catch(() => {});
        await active.deadLetter.close().catch(() => {});
        await active.cursors.close().catch(() => {});
      },
    });
  },
});

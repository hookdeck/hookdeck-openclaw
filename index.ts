import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";

import { parseHookdeckConfig } from "./src/plugin/config-parse.js";
import type { HookdeckPluginConfig, RouteConfig } from "./src/plugin/config-types.js";
import type { OpenClawPluginApi, OpenClawPluginServiceContext } from "./src/plugin/host-api.js";
import { createHostSecretResolver } from "./src/plugin/host-secrets.js";
import { resolveSecret, UnresolvedSecretError } from "./src/plugin/secrets.js";
import { createWakeDispatcher, type Dispatcher } from "./src/dispatch/wake.js";
import { createHookdeckClient } from "./src/hookdeck/client.js";
import { handleDelivery, writePlan, type Logger } from "./src/ingress/handler.js";
import { retryAfter } from "./src/protocol/outcome.js";
import { reconcileOrphans } from "./src/recovery.js";
import { createDeadLetterLog, type DeadLetterLog } from "./src/store/deadletter.js";
import { createInFlightRegistry, type InFlightRegistry } from "./src/store/in-flight.js";
import { createLedger, type Ledger } from "./src/store/ledger.js";
import { createFsStoreIo } from "./src/store/store-io.js";

const PLUGIN_ID = "hookdeck";

interface Runtime {
  ledger: Ledger;
  deadLetter: DeadLetterLog;
  inFlight: InFlightRegistry;
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
      let dispatcher = dispatchers.get(routeId);
      if (dispatcher === undefined) {
        dispatcher = createWakeDispatcher(route.dispatch, api.runtime.system);
        dispatchers.set(routeId, dispatcher);
      }
      return dispatcher;
    };

    const respondStarting = (res: Parameters<typeof writePlan>[0]) =>
      writePlan(
        res,
        { plan: retryAfter(503, "starting", 30, "plugin is still starting"), extra: {} },
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
            { plan: retryAfter(503, "internal_error", 30), extra: {} },
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

        runtime = {
          ledger,
          deadLetter,
          inFlight: createInFlightRegistry(config.maxConcurrent),
        };

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
        if (active === undefined) return;

        // Compacts on the way out, so the next boot loads a clean file.
        await active.ledger.close().catch(() => {});
        await active.deadLetter.close().catch(() => {});
      },
    });
  },
});

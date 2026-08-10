import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";

import { parseHookdeckConfig } from "./src/plugin/config-parse.js";
import type { HookdeckPluginConfig, RouteConfig } from "./src/plugin/config-types.js";
import type { OpenClawPluginApi, OpenClawPluginServiceContext } from "./src/plugin/host-api.js";
import { createHostSecretResolver } from "./src/plugin/host-secrets.js";
import { resolveSecret, UnresolvedSecretError } from "./src/plugin/secrets.js";
import { createWakeDispatcher, type Dispatcher } from "./src/dispatch/wake.js";
import { handleDelivery, writePlan, type Logger } from "./src/ingress/handler.js";
import { retryAfter } from "./src/protocol/outcome.js";
import { createInFlightRegistry, createMemoryLedger } from "./src/store/memory-ledger.js";

const PLUGIN_ID = "hookdeck";

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

    const ledger = createMemoryLedger(config.dedupe.ttlHours);
    const inFlight = createInFlightRegistry(config.maxConcurrent);
    const retryCancels = new Map<string, number>();

    // The host secret resolver needs the live OpenClawConfig, which only
    // arrives with the service context.
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

    // Gates the route until the service starts, so events arriving during boot
    // get a retryable 503 instead of being lost.
    let ready = false;

    api.registerHttpRoute({
      path: config.ingress.basePath,
      auth: "plugin",
      match: "prefix",
      replaceExisting: true,
      handler: async (req, res) => {
        if (!ready) {
          writePlan(
            res,
            { plan: retryAfter(503, "starting", 30, "plugin is still starting"), extra: {} },
            { allowRetryCancel: config.safety.allowRetryCancel },
          );
          return true;
        }

        try {
          const handled = await handleDelivery(
            {
              config,
              ledger,
              inFlight,
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
      start(ctx) {
        hostConfig = ctx.config;
        ready = true;

        const routes = Object.entries(config.routes).filter(([, r]) => r.enabled);
        ctx.logger.info?.(
          `ingress ready on ${config.ingress.basePath} (${routes.length} route${
            routes.length === 1 ? "" : "s"
          }); ledger is in-memory, so a restart may re-run work once`,
        );
        for (const [routeId, route] of routes) {
          ctx.logger.info?.(
            `  ${config.ingress.basePath}${route.path} <- source '${route.source}' (${route.dispatch.mode})`,
          );
        }
      },
      stop() {
        // All shutdown work belongs here, not in a `gateway_stop` hook: plugin
        // services are stopped BEFORE those hooks run, and `gateway_stop` is
        // capped at 5s. Connection pause and CLI teardown arrive with the
        // managed transport.
        ready = false;
        hostConfig = undefined;
      },
    });
  },
});

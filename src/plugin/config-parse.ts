import { z } from "zod";
import { DEFAULT_HEADER_PREFIX } from "../protocol/delivery.js";
import { ALL_ACTIONS } from "../protocol/envelope.js";
import type {
  ConfigParseResult,
  ConfigProblem,
  HookdeckPluginConfig,
  RouteConfig,
} from "./config-types.js";

// Mirrors OpenClaw's own secret-input schema (`plugin-sdk/secret-input`), where
// `provider` is REQUIRED on all three sources and the object is strict. Being
// laxer here would accept configs the host then rejects.
const secretInputSchema = z.union([
  z.string().min(1),
  z.strictObject({
    source: z.enum(["env", "file", "exec"]),
    provider: z.string().min(1),
    id: z.string().min(1),
  }),
]);

const wakeDispatchSchema = z.object({
  mode: z.literal("wake"),
  sessionKey: z.string().min(1),
  text: z.string().min(1).optional(),
  wakeMode: z.enum(["now", "next-heartbeat"]).default("now"),
});

const filterSchema = z.object({
  path: z.string().min(1),
  equals: z.union([z.string(), z.number(), z.boolean()]).optional(),
  in: z.array(z.union([z.string(), z.number(), z.boolean()])).min(1).optional(),
  exists: z.boolean().optional(),
});

const taskflowDispatchSchema = z.object({
  mode: z.literal("taskflow"),
  sessionKey: z.string().min(1),
  controllerId: z.string().min(1).optional(),
  allowedActions: z.array(z.enum(ALL_ACTIONS)).min(1).optional(),
});

const agentDispatchSchema = z.object({
  mode: z.literal("agent"),
  sessionKey: z.string().min(1),
  prompt: z.string().min(1),
  ackMode: z.enum(["async_retry", "sync"]).default("async_retry"),
  syncTimeoutSeconds: z.number().int().positive().max(3600).default(45),
  maxAgentRetries: z.number().int().nonnegative().max(50).default(3),
  // Off by default: a webhook-triggered route must not send anything outbound,
  // or an injected payload gains an exfiltration path.
  deliver: z.boolean().default(false),
  lane: z.string().min(1).optional(),
});

const routeSchema = z.object({
  enabled: z.boolean().default(true),
  path: z.string().optional(),
  source: z.string().min(1),
  signingSecret: secretInputSchema.optional(),
  dispatch: z.discriminatedUnion("mode", [
    wakeDispatchSchema,
    taskflowDispatchSchema,
    agentDispatchSchema,
  ]),
  filters: z.array(filterSchema).optional(),
});

const configSchema = z.object({
  headerPrefix: z.string().min(1).default(DEFAULT_HEADER_PREFIX),
  signingSecret: secretInputSchema.optional(),
  apiKey: secretInputSchema.optional(),
  storage: z
    .object({
      enabled: z.boolean().default(true),
      deadLetterMaxEntries: z.number().int().positive().max(100_000).default(500),
    })
    .default({ enabled: true, deadLetterMaxEntries: 500 }),
  recovery: z
    .object({
      enabled: z.boolean().default(true),
      maxEvents: z.number().int().positive().max(10_000).default(50),
    })
    .default({ enabled: true, maxEvents: 50 }),
  ingress: z
    .object({ basePath: z.string().min(1).default("/hookdeck") })
    .default({ basePath: "/hookdeck" }),
  maxConcurrent: z.number().int().positive().max(1000).default(4),
  busyRetryAfterSeconds: z.number().int().positive().max(3600).default(10),
  dedupe: z.object({ ttlHours: z.number().positive().max(24 * 30).default(24 * 7) }).default({
    ttlHours: 24 * 7,
  }),
  safety: z
    .object({ allowRetryCancel: z.boolean().default(false) })
    .default({ allowRetryCancel: false }),
  routes: z.record(z.string().min(1), routeSchema).default({}),
});

/** Normalise to a leading slash and no trailing slash. `/` collapses to "". */
export function normalisePath(input: string): string {
  const withLeading = input.startsWith("/") ? input : `/${input}`;
  const trimmed = withLeading.replace(/\/+$/, "");
  return trimmed;
}

/**
 * Parses plugin config. Never throws: a bad config must not stop the Gateway
 * from booting, so problems are returned and the caller registers a degraded
 * surface that reports them.
 */
export function parseHookdeckConfig(raw: unknown): ConfigParseResult {
  const parsed = configSchema.safeParse(raw ?? {});
  if (!parsed.success) {
    return {
      ok: false,
      problems: parsed.error.issues.map((issue) => ({
        path: issue.path.join(".") || "(root)",
        message: issue.message,
      })),
    };
  }

  const value = parsed.data;
  const warnings: ConfigProblem[] = [];
  const problems: ConfigProblem[] = [];

  const basePath = normalisePath(value.ingress.basePath);
  if (basePath === "") {
    problems.push({
      path: "ingress.basePath",
      message: "basePath may not be '/' — it would capture every Gateway request.",
    });
  }

  const routes: Record<string, RouteConfig> = {};
  const seenPaths = new Map<string, string>();

  for (const [routeId, route] of Object.entries(value.routes)) {
    const routePath = normalisePath(route.path ?? `/${routeId}`);
    if (routePath === "") {
      problems.push({
        path: `routes.${routeId}.path`,
        message: "route path may not be empty or '/'",
      });
      continue;
    }

    const fullPath = `${basePath}${routePath}`;
    const collision = seenPaths.get(fullPath);
    if (collision !== undefined) {
      problems.push({
        path: `routes.${routeId}.path`,
        message: `resolves to '${fullPath}', which collides with route '${collision}'`,
      });
      continue;
    }
    seenPaths.set(fullPath, routeId);

    if (route.signingSecret === undefined && value.signingSecret === undefined) {
      // Not fatal at parse time — the operator may be running ingress-only
      // while provisioning. It becomes a 503 per request, which keeps the
      // event alive in Hookdeck until they fix it.
      warnings.push({
        path: `routes.${routeId}.signingSecret`,
        message:
          "no signing secret configured for this route or at the top level; deliveries will be rejected with 503 until one is set",
      });
    }

    if (!route.enabled) {
      warnings.push({ path: `routes.${routeId}`, message: "route is disabled" });
    }

    for (const [index, filter] of (route.filters ?? []).entries()) {
      if (filter.equals === undefined && filter.in === undefined && filter.exists === undefined) {
        problems.push({
          path: `routes.${routeId}.filters.${index}`,
          message:
            "filter needs one of 'equals', 'in' or 'exists'; a bare path would silently match everything",
        });
      }
    }

    if (route.dispatch.mode === "agent" && route.dispatch.deliver) {
      warnings.push({
        path: `routes.${routeId}.dispatch.deliver`,
        message:
          "deliver is enabled on a webhook-triggered route: an injected payload could cause an outbound message",
      });
    }

    routes[routeId] = {
      enabled: route.enabled,
      path: routePath,
      source: route.source,
      ...(route.signingSecret !== undefined ? { signingSecret: route.signingSecret } : {}),
      dispatch: route.dispatch,
      ...(route.filters !== undefined ? { filters: route.filters } : {}),
    };
  }

  if (Object.keys(routes).length === 0) {
    warnings.push({
      path: "routes",
      message: "no routes configured; the plugin will load but receive nothing",
    });
  }

  if (problems.length > 0) return { ok: false, problems };

  if (value.recovery.enabled && value.apiKey === undefined) {
    warnings.push({
      path: "apiKey",
      message:
        "recovery is enabled but no apiKey is configured; work interrupted by a crash will be recorded to the dead-letter log but not re-queued",
    });
  }

  if (!value.storage.enabled) {
    warnings.push({
      path: "storage.enabled",
      message:
        "persistence is disabled; the ledger is memory-only, so a restart may re-run work and crash recovery is unavailable",
    });
  }

  const config: HookdeckPluginConfig = {
    headerPrefix: value.headerPrefix.replace(/-+$/, "").toLowerCase(),
    ...(value.signingSecret !== undefined ? { signingSecret: value.signingSecret } : {}),
    ...(value.apiKey !== undefined ? { apiKey: value.apiKey } : {}),
    ingress: { basePath },
    maxConcurrent: value.maxConcurrent,
    busyRetryAfterSeconds: value.busyRetryAfterSeconds,
    dedupe: { ttlHours: value.dedupe.ttlHours },
    storage: {
      enabled: value.storage.enabled,
      deadLetterMaxEntries: value.storage.deadLetterMaxEntries,
    },
    recovery: { enabled: value.recovery.enabled, maxEvents: value.recovery.maxEvents },
    safety: { allowRetryCancel: value.safety.allowRetryCancel },
    routes,
  };

  return { ok: true, config, warnings };
}

/**
 * Resolves a request path to a route, matching the LONGEST configured route
 * path that the request starts with.
 *
 * Prefix rather than exact, because Hookdeck appends the source request's path
 * to the destination path unless `path_forwarding_disabled` is set — the
 * default. A provider posting to `<source-url>/events` is delivered to
 * `/hookdeck/stripe/events`, and exact matching would 404 perfectly good
 * traffic. Longest-match keeps `/hookdeck/stripe` and `/hookdeck/stripe/refunds`
 * unambiguous when both are configured.
 */
export function matchRoute(
  config: HookdeckPluginConfig,
  pathname: string,
): { routeId: string; route: RouteConfig } | undefined {
  const normalised = normalisePath(pathname);
  let best: { routeId: string; route: RouteConfig; length: number } | undefined;

  for (const [routeId, route] of Object.entries(config.routes)) {
    if (!route.enabled) continue;
    const full = `${config.ingress.basePath}${route.path}`;
    // Either the path itself, or the path followed by a further segment. A bare
    // string prefix would let `/hookdeck/stripe-test` match route `stripe`.
    if (normalised !== full && !normalised.startsWith(`${full}/`)) continue;
    if (best === undefined || full.length > best.length) {
      best = { routeId, route, length: full.length };
    }
  }

  return best === undefined ? undefined : { routeId: best.routeId, route: best.route };
}

import { createHash } from "node:crypto";
import type {
  HookdeckPluginConfig,
  RouteConfig,
} from "../plugin/config-types.js";
import { RETRYABLE_STATUS_CODES } from "../protocol/outcome.js";

/**
 * Builds the connection spec for a route.
 *
 * Three details here are load-bearing and none of them is guessable from the
 * OpenAPI schema alone:
 *
 *  1. **`auth` is required alongside `auth_type`, even when empty.** The schema
 *     does not mark it required; the API answers
 *     `422 destination.config.auth is required` without it. Confirmed live.
 *  2. **`path_forwarding_disabled` defaults to false**, so Hookdeck appends the
 *     source request's path to the destination path — a provider posting to
 *     `<source-url>/events` arrives at `<path>/events`. We pin it true, and the
 *     ingress also matches tolerantly, because the two failure modes are
 *     independent: an operator who provisions by hand still sends sub-path
 *     traffic.
 *  3. **The retry rule must cover every status we emit as retryable.** A rule
 *     narrower than `RETRYABLE_STATUS_CODES` is silent data loss — we answer
 *     expecting a redelivery that never comes, with nothing recording that a
 *     choice was made.
 */

export type DestinationKind = "CLI" | "HTTP";

export interface ProvisionRouteSpec {
  routeId: string;
  source: string;
  /** Full path on our side: `basePath + route.path`. */
  path: string;
  kind: DestinationKind;
  /** Required for `HTTP`; ignored for `CLI`. */
  url?: string;
  /** Provider verification at the source, e.g. `STRIPE`. */
  sourceAuthType?: string;
  sourceAuth?: Record<string, unknown>;
  retryStrategy?: "linear" | "exponential";
  retryCount?: number;
  retryIntervalMs?: number;
  /** Native dedupe window, so a double-firing provider costs one run. */
  dedupeWindowMs?: number;
  /** HTTP destinations only — CLI destinations carry no rate_limit field. */
  rateLimit?: number;
  rateLimitPeriod?: "second" | "minute" | "hour" | "concurrent";
}

export interface ConnectionSpec {
  name: string;
  source: Record<string, unknown>;
  destination: Record<string, unknown>;
  rules: Record<string, unknown>[];
}

export function buildConnectionSpec(spec: ProvisionRouteSpec): ConnectionSpec {
  const destinationConfig: Record<string, unknown> = {
    // Never let Hookdeck append the source path onto ours.
    path_forwarding_disabled: true,
    auth_type: "HOOKDECK_SIGNATURE",
    // Required even though the schema says otherwise. See the note above.
    auth: {},
  };

  if (spec.kind === "CLI") {
    destinationConfig.path = spec.path;
  } else {
    destinationConfig.url = spec.url;
    // rate_limit exists on HTTP and MOCK_API destinations only; a CLI
    // destination has no such field, which is why local admission control is
    // the only limit in CLI transport.
    if (spec.rateLimit !== undefined) {
      destinationConfig.rate_limit = spec.rateLimit;
      destinationConfig.rate_limit_period =
        spec.rateLimitPeriod ?? "concurrent";
    }
  }

  const rules: Record<string, unknown>[] = [
    {
      type: "retry",
      strategy: spec.retryStrategy ?? "exponential",
      count: spec.retryCount ?? 10,
      interval: spec.retryIntervalMs ?? 60_000,
      response_status_codes: [...RETRYABLE_STATUS_CODES],
    },
  ];

  if (spec.dedupeWindowMs !== undefined) {
    rules.push({ type: "deduplicate", window: spec.dedupeWindowMs });
  }

  const sourceConfig: Record<string, unknown> = {};
  if (spec.sourceAuthType !== undefined) {
    sourceConfig.auth_type = spec.sourceAuthType;
    // The stale `verification: {type, configs}` shape in the docs does not
    // exist in the 2025-07-01 spec.
    sourceConfig.auth = spec.sourceAuth ?? {};
  }

  return {
    name: `openclaw-${spec.routeId}`,
    source: {
      name: spec.source,
      ...(Object.keys(sourceConfig).length > 0 ? { config: sourceConfig } : {}),
    },
    destination: {
      name: `openclaw-${spec.routeId}`,
      type: spec.kind,
      config: destinationConfig,
    },
    rules,
  };
}

/**
 * The one place a route becomes a provisioning spec.
 *
 * Keep it that way. `PUT /connections` is an upsert, so a second builder that
 * omitted a field would not fail — it would quietly remove that field from a
 * live connection. Dropping the source verification block, for instance, turns
 * a verified source into an open endpoint. A single builder also keeps the
 * provisioning fingerprint meaningful, since a spec built two ways hashes two
 * ways and every diff looks like a change.
 */
export function routeProvisionSpec(options: {
  config: HookdeckPluginConfig;
  routeId: string;
  route: RouteConfig;
  /** Resolved provider credentials, when the route configures verification. */
  credentials?: Record<string, string> | undefined;
}): ProvisionRouteSpec {
  const { config, routeId, route, credentials } = options;
  const path = `${config.ingress.basePath}${route.path}`;
  const http = config.transport.mode === "http";

  return {
    routeId,
    source: route.source,
    path,
    kind: http ? "HTTP" : "CLI",
    ...(config.transport.publicUrl !== undefined
      ? { url: `${config.transport.publicUrl.replace(/\/+$/, "")}${path}` }
      : {}),
    // Hookdeck's own concurrency limit, which is strictly better than ours:
    // it paces delivery, where local admission control answers 503 and spends
    // one of the event's finite attempts to say "not now". Ours stays as the
    // backstop, and is the ONLY limit under CLI transport — CLI destinations
    // carry no `rate_limit` field at all.
    ...(http
      ? {
          rateLimit: config.maxConcurrent,
          rateLimitPeriod: "concurrent" as const,
        }
      : {}),
    ...(config.provisioning.dedupeWindowMs !== undefined
      ? { dedupeWindowMs: config.provisioning.dedupeWindowMs }
      : {}),
    ...(route.verification !== undefined && credentials !== undefined
      ? { sourceAuthType: route.verification.provider, sourceAuth: credentials }
      : {}),
  };
}

/**
 * Stable hash of the spec, so an unchanged config skips the upsert entirely.
 * Keys are sorted, so reordering config does not look like a change.
 */
export function fingerprint(spec: ConnectionSpec): string {
  return createHash("sha256")
    .update(stableStringify(spec))
    .digest("hex")
    .slice(0, 32);
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object")
    return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`).join(",")}}`;
}

/**
 * Checks a live connection's retry rule still covers everything we emit.
 *
 * Drift here is the quiet failure: nothing errors, events simply stop being
 * retried. `doctor` runs this rather than trusting that provisioning was the
 * last thing to touch the connection.
 */
export function uncoveredStatuses(
  ruleCodes: readonly string[] | undefined,
): string[] {
  const covered = new Set(ruleCodes ?? []);
  const hasServerRange = [...covered].some((c) => /^5\d\d-5\d\d$/.test(c));
  return RETRYABLE_STATUS_CODES.filter((needed) => {
    if (covered.has(needed)) return false;
    if (needed === "500-599" && hasServerRange) return false;
    return true;
  });
}

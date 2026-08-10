/**
 * The plugin's config contract. This file is the source of truth; the
 * `configSchema` in `openclaw.plugin.json` mirrors it, and the two must be kept
 * in step. Config lives at `plugins.entries.hookdeck.config`.
 */

/**
 * A value the operator may supply inline or via OpenClaw's secret-input
 * runtime. SecretRefs are re-resolved per use, never cached, so rotating a
 * secret takes effect without restarting the Gateway.
 */
export type SecretInput =
  | string
  | { source: "env" | "file" | "exec"; provider: string; id: string };

export interface WakeDispatchConfig {
  mode: "wake";
  /**
   * Session the system event is enqueued against. Required: the underlying
   * `enqueueSystemEvent` throws without one, and the Gateway's own session-key
   * fallback resolver is not exposed on a public plugin-sdk subpath.
   */
  sessionKey: string;
  /**
   * Text for the system event. Supports the placeholders `{source}`,
   * `{eventId}` and `{routeId}` — deliberately not a template engine.
   */
  text?: string;
  /**
   * `now` also requests an immediate heartbeat; `next-heartbeat` only enqueues.
   */
  wakeMode?: "now" | "next-heartbeat";
}

/** Additional modes (`taskflow`, `agent`) land in M3. */
export type DispatchConfig = WakeDispatchConfig;

export interface RouteConfig {
  enabled: boolean;
  /** Appended to `ingress.basePath`. Defaults to `/<routeId>`. */
  path: string;
  /** Hookdeck source name. Required — `hookdeck listen` takes it positionally. */
  source: string;
  /** Overrides the top-level signing secret for this route. */
  signingSecret?: SecretInput;
  dispatch: DispatchConfig;
}

export interface SafetyConfig {
  /**
   * Whether `Retry-After: -1` may be emitted to cancel Hookdeck's automatic
   * retries on permanently-invalid input. Defaults to FALSE: with it off, this
   * plugin's wire behaviour matches the sibling Hermes and n8n plugins exactly,
   * and enabling it only ever converts an already-failing response into one
   * that stops retrying.
   */
  allowRetryCancel: boolean;
}

export interface HookdeckPluginConfig {
  /** White-labelable per Hookdeck project. Read, never hardcoded. */
  headerPrefix: string;
  /** Default signing secret; routes may override. */
  signingSecret?: SecretInput;
  ingress: {
    /** Route prefix registered on the Gateway. */
    basePath: string;
  };
  /** Local admission control. In CLI transport this is the ONLY limit, since
   * CLI destinations have no `rate_limit` field. */
  maxConcurrent: number;
  busyRetryAfterSeconds: number;
  dedupe: {
    ttlHours: number;
  };
  safety: SafetyConfig;
  routes: Record<string, RouteConfig>;
}

export interface ConfigProblem {
  path: string;
  message: string;
}

export type ConfigParseResult =
  | { ok: true; config: HookdeckPluginConfig; warnings: ConfigProblem[] }
  | { ok: false; problems: ConfigProblem[] };

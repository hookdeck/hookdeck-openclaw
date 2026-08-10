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
import type { RouteFilter } from "../protocol/filters.js";

export type { RouteFilter };

export type SecretInput =
  string | { source: "env" | "file" | "exec"; provider: string; id: string };

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

export interface TaskFlowDispatchConfig {
  mode: "taskflow";
  /** Session the flows are bound to. Flow state is scoped to it. */
  sessionKey: string;
  /** Identifies flows this route manages. Defaults to `hookdeck/<routeId>`. */
  controllerId?: string;
  /** When set, only these actions are accepted on this route. */
  allowedActions?: string[];
}

export interface AgentDispatchConfig {
  mode: "agent";
  /** Supports `{routeId}`, `{eventId}`, `{source}`; sanitised to a safe alphabet. */
  sessionKey: string;
  /**
   * Prompt template. Placeholders (`{{payload.type}}`, `{{source}}`, …) are
   * substituted as JSON, never as bare prose — see the trust boundary note in
   * `protocol/template.ts`.
   */
  prompt: string;
  ackMode?: "async_retry" | "sync";
  syncTimeoutSeconds?: number;
  /** Redeliveries requested after a failed run before marking it exhausted. */
  maxAgentRetries?: number;
  /** Off by default: a webhook-triggered route must not send anything outbound. */
  deliver?: boolean;
  lane?: string;
}

export type DispatchConfig =
  WakeDispatchConfig | TaskFlowDispatchConfig | AgentDispatchConfig;

export interface RouteConfig {
  enabled: boolean;
  /** Appended to `ingress.basePath`. Defaults to `/<routeId>`. */
  path: string;
  /** Hookdeck source name. Required — `hookdeck listen` takes it positionally. */
  source: string;
  /** Overrides the top-level signing secret for this route. */
  signingSecret?: SecretInput;
  dispatch: DispatchConfig;
  /**
   * Provider signature verification, applied by Hookdeck at the Source.
   *
   * This is a THIRD-PARTY secret — Stripe's `whsec_…`, GitHub's webhook secret
   * — and it is not the same thing as `signingSecret`, which is Hookdeck's own
   * project-level secret for signing deliveries to us. The plugin never sees or
   * verifies this one: Hookdeck rejects an unverified request at the Request
   * layer, so no event is created and nothing reaches the agent. Not
   * reimplementing ~145 provider schemes is the point of the integration.
   */
  verification?: {
    /** Hookdeck source auth type, e.g. `STRIPE`, `GITHUB`, `SHOPIFY`. */
    provider: string;
    /** Provider-specific credential fields, each a secret input. */
    credentials: Record<string, SecretInput>;
  };
  /**
   * Hookdeck connection id. Only needed when `provisioning.enabled` is false:
   * pause-on-shutdown and catch-up both act on a connection, and without an id
   * they have nothing to act on. Provisioning discovers it automatically.
   */
  connectionId?: string;
  /**
   * Payload filters; all must pass. A non-match is answered 200, because the
   * drop is deliberate and a 2xx correctly retires the event.
   *
   * Prefer filtering at the Hookdeck connection where you can: an event
   * filtered there never reaches the agent and costs nothing.
   */
  filters?: RouteFilter[];
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

export interface RecoveryConfig {
  /**
   * Re-queue work interrupted by a crash or shutdown, by calling
   * `POST /events/{id}/retry` for every `running` ledger row owned by a dead
   * process instance. Requires `apiKey`; without one the rows are recorded to
   * the dead-letter log but not re-run.
   */
  enabled: boolean;
  /** Caps a crash loop from storming the Hookdeck API. */
  maxEvents: number;
}

export interface StorageConfig {
  /**
   * Persist the ledger and dead-letter log under the plugin's state directory.
   * With this off, both are memory-only: still exactly-once within a process,
   * but at-least-once across a restart, and no crash recovery.
   */
  enabled: boolean;
  /** Dead-letter entries retained before the oldest are dropped. */
  deadLetterMaxEntries: number;
}

export interface TransportConfig {
  /**
   * `cli` supervises a `hookdeck listen` child per route — zero ingress, but a
   * CLI destination is not durable while disconnected. `http` expects the
   * Gateway to be reachable and gives the full reliability stack. `none` leaves
   * the transport entirely to the operator.
   */
  mode: "cli" | "http" | "none";
  /** Gateway port the CLI forwards to. */
  port: number;
  /** Resolved explicitly, because a shadowed binary defeats the version gate. */
  binaryPath: string;
  /** Downgrade the >=2.4.0 gate to a warning. Sub-2.3.2 silently stops delivering. */
  allowUnsupportedVersion: boolean;
  /** Public base URL of the Gateway, for `http` mode provisioning. */
  publicUrl?: string;
}

export interface ProvisioningConfig {
  /** Upsert connections at startup. Off leaves provisioning to the operator. */
  enabled: boolean;
  /** Re-upsert even when the computed spec is unchanged. */
  force: boolean;
  /** Native dedupe window, so a double-firing provider costs one run. */
  dedupeWindowMs?: number;
}

export interface PauseConfig {
  /**
   * Pause the connection before stopping the listener on shutdown. Events are
   * then held at `HOLD` and delivered on the next start, instead of being
   * discarded — a clean shutdown otherwise forfeits the CLI's grace window.
   */
  onShutdown: boolean;
  /** Bound our own teardown; the host applies no per-service stop timeout. */
  shutdownTimeoutMs: number;
}

export interface CatchUpConfig {
  enabled: boolean;
  /** Below this, an outage is not worth a bulk replay. */
  minGapSeconds: number;
}

export interface HookdeckPluginConfig {
  /** White-labelable per Hookdeck project. Read, never hardcoded. */
  headerPrefix: string;
  /** Default signing secret; routes may override. */
  signingSecret?: SecretInput;
  /**
   * Hookdeck API key. Optional — without it the plugin runs ingress-only:
   * verification, deduplication and dispatch all work, but interrupted work
   * cannot be re-queued.
   */
  apiKey?: SecretInput;
  ingress: {
    /** Route prefix registered on the Gateway. */
    basePath: string;
  };
  /** Local admission control. In CLI transport this is the ONLY limit, since
   * CLI destinations have no `rate_limit` field. */
  maxConcurrent: number;
  busyRetryAfterSeconds: number;
  /**
   * Deferrals of the SAME event before we stop sending a short `Retry-After`
   * and let exponential backoff pace it. Capacity that has not recovered after
   * this many attempts is not the transient condition the short interval
   * assumes.
   */
  deferAttemptLimit: number;
  dedupe: {
    ttlHours: number;
  };
  tools: {
    /** With mutations off, the agent can diagnose but not act. */
    allowMutations: boolean;
  };
  storage: StorageConfig;
  recovery: RecoveryConfig;
  transport: TransportConfig;
  provisioning: ProvisioningConfig;
  pause: PauseConfig;
  catchUp: CatchUpConfig;
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

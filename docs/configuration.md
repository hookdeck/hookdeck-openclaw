# Configuration reference

Every setting, its default, and what it changes.

| Key | Default | Notes |
|---|---|---|
| `headerPrefix` | `x-hookdeck` | Hookdeck's header prefix is white-labelable per project. Set it if yours differs. |
| `signingSecret` | — | Inline string or a secretRef `{source, provider, id}`. Routes may override. Re-resolved on every request, so rotation needs no restart. |
| `apiKey` | — | Optional. Needed for provisioning, pause/resume, replay, issue management and re-queuing interrupted work. Without it the plugin runs ingress-only. |
| `storage.enabled` | `true` | Persist the ledger and dead-letter log. Off means memory-only — see [Durability](#durability-and-recovery). |
| `storage.deadLetterMaxEntries` | `500` | Dead-letter entries kept before the oldest are dropped. |
| `recovery.enabled` | `true` | Re-queue work interrupted by a crash on the next start. Needs `apiKey`. |
| `recovery.maxEvents` | `50` | Caps a crash loop from storming the API. Oldest events recovered first. |
| `ingress.basePath` | `/hookdeck` | Gateway route prefix. May not be `/`. |
| `maxConcurrent` | `4` | Local admission control. In CLI transport this is the **only** limit — CLI destinations carry no `rate_limit` field. |
| `busyRetryAfterSeconds` | `10` | `Retry-After` sent when deferring at capacity. |
| `deferAttemptLimit` | `5` | Deferrals of the same event before the short `Retry-After` is dropped and exponential backoff takes over. Capacity that has not recovered after this many attempts is not the transient condition a short interval assumes. |
| `pause.onShutdown` | `true` | Pause the connection before stopping the listener, so events are held rather than discarded. |
| `pause.shutdownTimeoutMs` | `5000` | Budget for pausing connections at shutdown. Stopping the CLI children is bounded separately, by a SIGTERM grace before SIGKILL. |
| `catchUp.enabled` | `true` | After a reconnect, replay requests that arrived while nothing was listening. |
| `catchUp.minGapSeconds` | `30` | Below this, an outage is not worth a bulk replay. |
| `dedupe.ttlHours` | `168` | Ledger retention, matching Hookdeck's one-week retry ceiling. Raise it if you extend retries beyond a week. |
| `safety.allowRetryCancel` | `false` | See [Retry cancellation](#retry-cancellation). |
| `routes.<id>.source` | — | **Required.** Hookdeck source name. |
| `routes.<id>.path` | `/<id>` | Appended to `ingress.basePath`. Matched as a prefix — see below. |
| `routes.<id>.verification` | — | Provider signature verification at the Hookdeck source: `{provider: "STRIPE", credentials: {webhook_secret_key: …}}`. See below. |
| `routes.<id>.connectionId` | — | Only needed when provisioning is off. Pause-on-shutdown and catch-up act on a connection id, so without one they are silently inert; the plugin warns at startup if that applies. |
| `routes.<id>.dispatch.sessionKey` | — | **Required.** Session the event is enqueued against. |
| `routes.<id>.dispatch.text` | `Webhook received from {source}` | Placeholders: `{source}`, `{eventId}`, `{routeId}`. |
| `routes.<id>.dispatch.wakeMode` | `now` | `now` also requests an immediate heartbeat; `next-heartbeat` only enqueues. |

`provider` is required on a secretRef — OpenClaw's own secret-input schema marks all three fields required and rejects unknown keys.

## Two different secrets

These are easy to conflate and they come from different parties:

- **`signingSecret`** is **Hookdeck's own**, project-level, from Settings → Project → Secrets. Hookdeck signs its deliveries *to you* with it, and this plugin verifies that signature. Without it, every delivery is rejected with a retryable `503`.
- **`routes.<id>.verification.credentials`** is the **provider's** — Stripe's `whsec_…`, GitHub's webhook secret. It goes on the Hookdeck *source*, and **Hookdeck** uses it to verify the provider's own signature at ingest. This plugin never sees it. Verification failure is rejected at Hookdeck's request layer, so no event is created and nothing reaches your agent.

Not reimplementing ~145 provider schemes is the point of the integration. Configure verification and Hookdeck does it; leave it out and Hookdeck accepts anything posted to the source URL, which the plugin warns about at startup.

**Route paths match as a prefix, longest first.** Hookdeck appends the source request's path to the destination path unless `path_forwarding_disabled` is set, which is not the default — so a provider posting to `<source-url>/events` arrives at `/hookdeck/stripe/events`. Exact matching would reject perfectly good traffic. A route named `stripe` will not swallow `/hookdeck/stripe-test`; only a further path segment counts.

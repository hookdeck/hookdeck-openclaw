# @hookdeck/openclaw

Reliable webhooks for OpenClaw. Puts the [Hookdeck](https://hookdeck.com) Event Gateway in front of your OpenClaw Gateway so inbound webhooks are verified, deduplicated and retryable.

> **Status: M3.** Signature verification, durable deduplication, crash recovery, dead-lettering, route filters and all three dispatch modes work end to end. Connection provisioning, CLI supervision and the operator tools are not here yet — see [Limitations](#limitations). Nothing below describes behaviour that isn't implemented.

## Why

OpenClaw ships a built-in Webhooks plugin that binds external automation to TaskFlows. It authenticates with a shared bearer secret, guards body size and timeouts, and rate-limits per client IP. What it does not do:

- **Verify provider signatures.** It compares a shared secret. It reads the request body as parsed JSON and discards the raw bytes, so HMAC-over-raw-body is not available to it — meaning it cannot verify a Stripe, GitHub or Shopify signature at all.
- **Deduplicate.** There is no event-id tracking and no replay window, so a redelivered webhook runs the work twice.
- **Survive being unavailable.** If the Gateway is down, restarting or saturated, the event is gone. Its in-flight limiter answers a bare `429` with no `Retry-After`, so a sender has no idea when to return.
- **Accept raw provider payloads.** Its routes expect a TaskFlow action envelope. A raw Stripe payload is not one.

Hookdeck closes all four: signature verification for ~145 providers at the source, a durable queue, automatic retries with backoff, and `HOLD`-based pausing that queues rather than drops.

## Install

```bash
openclaw plugins install clawhub:@hookdeck/openclaw
```

Local development, from a clone:

```bash
openclaw plugins install --link ./hookdeck-openclaw
```

## Quickstart

**1. Get your signing secret** from the Hookdeck dashboard: Settings → Project → Secrets. It is project-level, not per-connection.

**2. Configure the plugin** in `~/.openclaw/openclaw.json`:

```json
{
  "plugins": {
    "entries": {
      "hookdeck": {
        "enabled": true,
        "config": {
          "signingSecret": { "source": "env", "provider": "env", "id": "HOOKDECK_SIGNING_SECRET" },
          "routes": {
            "stripe": {
              "source": "stripe",
              "dispatch": {
                "mode": "wake",
                "sessionKey": "main",
                "text": "Stripe event received ({eventId})"
              }
            }
          }
        }
      }
    }
  }
}
```

That serves `POST /hookdeck/stripe` on the Gateway.

**3. Point Hookdeck at it.** For local development, tunnel with the Hookdeck CLI (**pin ≥ 2.4.0** — earlier versions silently stop delivering after a session expires):

```bash
npx hookdeck-cli@latest listen 18789 stripe --path /hookdeck/stripe
```

`hookdeck listen` takes the source as a required positional and forwards exactly one source per process, so run one per route. It auto-creates the source and a CLI destination for you.

**4. Fire a test event.** The agent wakes with the event text.

### No API key required to receive webhooks

Receiving needs **only the signing secret** — verification, deduplication and dispatch make no Hookdeck API calls at all. The Hookdeck CLI has its own separate credential (`hookdeck login`, or guest mode with no account at all).

An `apiKey` is optional and used for exactly one thing today: re-queuing work interrupted by a crash, via `POST /events/{id}/retry`. Without one the plugin runs ingress-only — interrupted work is still detected, settled and dead-lettered, just not re-run, and the startup log says so.

You do not need to configure destination auth either. CLI destinations default to `auth_type: HOOKDECK_SIGNATURE` — applied server-side, so deliveries forwarded by `hookdeck listen` carry `x-hookdeck-signature` and the full `x-hookdeck-*` header set, with the body passed through byte-for-byte. Verification therefore runs identically in local dev and production, which is the point.

> This is not stated in Hookdeck's docs, which is a documentation gap rather than a caveat. Note also that CLI destination auth is API-only — the dashboard's destination editor exposes an Authentication dropdown for HTTP and Mock API destinations but only "CLI Path" for CLI ones. The default still applies.

**If local deliveries are rejected with `401`, the likely cause is a project mismatch, not missing headers.** The signing secret is per-project, so a secret from one project will not verify traffic from another. Check the CLI is logged into the same project the secret came from.

## Configuration

| Key | Default | Notes |
|---|---|---|
| `headerPrefix` | `x-hookdeck` | Hookdeck's header prefix is white-labelable per project. Set it if yours differs. |
| `signingSecret` | — | Inline string or a secretRef `{source, provider, id}`. Routes may override. Re-resolved on every request, so rotation needs no restart. |
| `apiKey` | — | Optional. Only used to re-queue interrupted work. Without it the plugin runs ingress-only. |
| `storage.enabled` | `true` | Persist the ledger and dead-letter log. Off means memory-only — see [Durability](#durability-and-recovery). |
| `storage.deadLetterMaxEntries` | `500` | Dead-letter entries kept before the oldest are dropped. |
| `recovery.enabled` | `true` | Re-queue work interrupted by a crash on the next start. Needs `apiKey`. |
| `recovery.maxEvents` | `50` | Caps a crash loop from storming the API. Oldest events recovered first. |
| `ingress.basePath` | `/hookdeck` | Gateway route prefix. May not be `/`. |
| `maxConcurrent` | `4` | Local admission control. In CLI transport this is the **only** limit — CLI destinations carry no `rate_limit` field. |
| `busyRetryAfterSeconds` | `10` | `Retry-After` sent when deferring at capacity. |
| `deferAttemptLimit` | `5` | Deferrals of the same event before the short `Retry-After` is dropped and exponential backoff takes over. Capacity that has not recovered after this many attempts is not the transient condition a short interval assumes. |
| `dedupe.ttlHours` | `168` | Ledger retention. Must exceed Hookdeck's one-week retry ceiling. |
| `safety.allowRetryCancel` | `false` | See [Retry cancellation](#retry-cancellation). |
| `routes.<id>.source` | — | **Required.** Hookdeck source name. |
| `routes.<id>.path` | `/<id>` | Appended to `ingress.basePath`. Matched as a prefix — see below. |
| `routes.<id>.dispatch.sessionKey` | — | **Required.** Session the event is enqueued against. |
| `routes.<id>.dispatch.text` | `Webhook received from {source}` | Placeholders: `{source}`, `{eventId}`, `{routeId}`. |
| `routes.<id>.dispatch.wakeMode` | `now` | `now` also requests an immediate heartbeat; `next-heartbeat` only enqueues. |

`provider` is required on a secretRef — OpenClaw's own secret-input schema marks all three fields required and rejects unknown keys.

**Route paths match as a prefix, longest first.** Hookdeck appends the source request's path to the destination path unless `path_forwarding_disabled` is set, which is not the default — so a provider posting to `<source-url>/events` arrives at `/hookdeck/stripe/events`. Exact matching would reject perfectly good traffic. A route named `stripe` will not swallow `/hookdeck/stripe-test`; only a further path segment counts.

## Dispatch modes

Each route picks one.

| Mode | What it does | Use it for |
|---|---|---|
| `wake` | Enqueues a system event and, by default, requests an immediate heartbeat. | "Something happened, look at it." Cheapest option. |
| `taskflow` | Body is a TaskFlow action envelope (`create_flow`, `run_task`, `finish_flow`, …), applied against a bound session. | Automation sources that already speak OpenClaw's vocabulary — n8n, Zapier, CI. |
| `agent` | Renders the payload into a prompt and runs an isolated turn. | Raw provider webhooks. A Stripe body is not a TaskFlow envelope and never will be, so this is the mode that works with any of Hookdeck's ~145 verified providers on day one. |

### TaskFlow semantics

The status taxonomy mirrors the built-in Webhooks plugin, with two entries worth knowing:

- **`revision_conflict` cancels retries.** `expectedRevision` is baked into the stored request and TaskFlow revisions only ever increase, so a retry of that exact envelope can never succeed. The current revision comes back in the body so the caller can re-read and re-send.
- **`not_found` does not cancel.** The flow may simply not exist yet — an envelope can race ahead of the creation that produces it — and Hookdeck's backoff resolves that for free.

### Agent turns

The prompt template's own text is trusted; everything substituted into it is not. See [Trust boundary](#trust-boundary).

Turns are started through TaskFlow `run_task` rather than `subagent.run`, and that is not a preference. **A plugin-registered HTTP route with `auth: "plugin"` is given `scopes: []` unconditionally** — the Gateway's `createPluginRouteRuntimeScope` reads `route.auth !== "gateway" ? [] : …`, and `gatewayRuntimeScopeSurface` only applies on the `"gateway"` branch. Since this plugin authenticates with Hookdeck's signature rather than the Gateway's own credentials, the `operator.write` scope is structurally unreachable and `subagent.run` answers `missing scope: operator.write`.

`run_task` has no such requirement, and it is the better fit anyway: the run becomes durable flow state rather than a bare run id, so it survives a restart and stays inspectable.

The consequence is honest rather than hidden: **TaskFlow exposes flow state, not a completion promise**, so this transport cannot observe when a run finishes. The route acknowledges `202` once the task is created and settles the ledger there. `ackMode: "sync"` and `maxAgentRetries` need completion observability and therefore have no effect on this transport — they are wired and tested for hosts where the route does carry operator scopes.

### Route filters

Filters are matched against the parsed payload; all must pass. A non-match is answered `200` with `{"ignored": true}`, because the drop is deliberate and a `2xx` correctly retires the event. Nothing is written to the ledger for a filtered event.

```json
"filters": [{ "path": "type", "equals": "invoice.paid" }]
```

`equals`, `in` and `exists` are supported. Prefer filtering at the Hookdeck connection where you can — an event filtered there never reaches the agent and costs nothing.

## Response contract

Every status is chosen for what Hookdeck does next, not for HTTP tidiness. Any non-2xx is retried by default.

| Situation | Status | `Retry-After` |
|---|---|---|
| Dispatched | `200` | — |
| Duplicate attempt | `200` | — |
| Wrong method or content type | `405` / `415` | cancel¹ |
| Body too large | `413` | cancel¹ |
| Malformed JSON, or not UTF-8 | `400` | cancel¹ |
| No route matches the path | `404` | — |
| Not a Hookdeck delivery, or no event id | `400` | — |
| No signing secret configured | `503` | — |
| Signature mismatch | `401` | — |
| Dispatch failed | `503` / `500` | — |
| Same event already in flight | `503` | `5` |
| At `maxConcurrent` | `503` | `busyRetryAfterSeconds` |
| Still starting | `503` | `30` |

¹ Only when `safety.allowRetryCancel` is enabled. See below.

Two rules govern that table, and both are easy to get backwards.

**Retries are cancelled only when a retry of that exact event can never succeed.** Hookdeck replays the stored request byte-for-byte, so anything baked into it — method, content type, size, an unparseable body — fails identically every time. Everything else stays retryable, because an operator fix makes a later retry of the *same* event succeed: adding a missing route, setting the destination's auth to `HOOKDECK_SIGNATURE` (Hookdeck computes signatures at delivery time, so retries are then signed), correcting `headerPrefix`, or supplying the signing secret.

**`Retry-After` is only sent when the condition clears in seconds.** It overrides the connection's retry rule entirely, so a fixed short value is a budget hazard: at 30s a side, the 50-attempt ceiling is spent in 25 minutes and the event is gone. For anything needing a human — a missing secret, a repeated dispatch failure — the header is omitted so exponential backoff spreads the attempts across up to a week.

**Configure your connection's retry rule to cover `400`, `401`, `404`, `408`, `409`, `429` and `500-599`.** A narrower rule is silent data loss, and it is the quiet cousin of an over-broad retry cancellation: the plugin answers `404` expecting a redelivery, the rule does not cover `404`, the event is gone, and nothing records that a choice was made. At least a cancellation is auditable.

`413` is deliberately absent — the body limit is a plugin constant, not operator config, so no change makes that event succeed. `RETRYABLE_STATUS_CODES` is derived from the statuses the pipeline actually emits, and `retryable()`/`deferFor()` are typed to that union, so emitting an uncovered status is a compile error rather than a production surprise.

Two deliberate choices worth knowing:

- **A deferred event is not recorded.** Nothing is written to the ledger when we answer `503` at capacity. Recording it would make Hookdeck's redelivery look like a duplicate, and the event would vanish.
- **A failure on the last attempt stays a failure.** We do not convert it to `2xx` to keep the dashboard green — the failure is what opens a Hookdeck Issue, and the Issue is your alert.

### Deduplication

Keyed on `x-hookdeck-eventid`, but the rule is about the attempt number, not identity:

> Admit a delivery when its attempt number is greater than the highest attempt already recorded for that event id. Otherwise reject it as a duplicate. When the attempt header is absent, admit only if the previous run for that event is recorded as failed.

This matters because Hookdeck redelivers a *failed* event under the **same** event id. Deduplicating on identity alone would look idempotent while quietly never retrying anything.

## Durability and recovery

The ledger is an append-only JSONL file under the plugin's state directory, compacted atomically (write, fsync, rename) and on shutdown. It survives a restart, so a redelivery that arrives after the Gateway has bounced is still recognised as a duplicate rather than re-running the work.

**If a write fails, persistence disables itself permanently for that process, logs once, and handling continues in memory.** A broken disk degrades the guarantee from exactly-once to at-least-once; it must never wedge webhook handling. `storage.enabled: false` chooses the same trade deliberately.

### Crash recovery

A `running` row owned by a process instance that no longer exists is an orphan by definition — the process that owned it is gone, so its outcome is unknown. On startup each one is settled, dead-lettered, and handed back to Hookdeck with `POST /events/{id}/retry` so the normal pipeline re-runs it.

This is the payoff of putting an event gateway in front: **Hookdeck is the durable work queue, so the plugin never needs to build one.** That matters concretely, because OpenClaw's own durable queue (`openChannelIngressQueue`) is gated to bundled and trusted-official plugins and unavailable to community plugins like this one.

Manual retry works on events Hookdeck already considers `SUCCESSFUL` — confirmed against a live project — which is what makes the recovery call legitimate rather than a hack.

> **Recovery can re-run an event whose dispatch finished in the instant before the crash.** That is the at-least-once contract this design already assumes rather than a new hazard, but it is the kind of thing discovered via a duplicate side effect at 2am. Make webhook-triggered work idempotent. Set `recovery.enabled: false` to opt out; orphans are then recorded but never re-run.

Without `apiKey`, orphans are still detected, settled and dead-lettered — they just aren't re-queued, and the startup log says so.

### Retry cancellation

`safety.allowRetryCancel` lets the plugin answer `Retry-After: -1` on permanently-invalid input — malformed JSON, a body that will never fit — which tells Hookdeck to stop retrying instead of burning all 50 attempts on something that cannot succeed.

**It is off by default, and that default is deliberate.** A mistake here discards real traffic, and the events are gone once retention lapses (3 days on the free plan). Cancellation is only ever emitted from a closed allowlist of reasons, always dead-letters first, and never fires for anything a config change could fix — a missing secret, an unresolvable secretRef or a storage failure all stay retryable. Turn it on once you have watched the logs and seen what it *would* have cancelled.

## Trust boundary

**A valid signature authenticates the sender, not the content.** Webhook payload text is third-party input that ends up in a prompt reaching a model with tools.

- Treat payload text as data, never as instructions addressed to the agent.
- Prefer scoped tools and approval gates on webhook-triggered paths.
- Verify provider signatures at the Hookdeck source (`config.auth_type`), so a payload is attributable before it ever reaches OpenClaw. Verification failure rejects at the request layer — no event is created, so nothing reaches your agent.

Signature headers and resolved secrets are redacted from logs.

## Limitations

Not yet implemented:

- **No completion tracking for agent turns.** See [Agent turns](#agent-turns) — `sync` and `maxAgentRetries` need a completion hook the TaskFlow transport does not provide.
- **No connection provisioning.** Create the source, destination and connection in Hookdeck yourself, and set the retry rule as above.
- **No CLI supervision or catch-up.** Run `hookdeck listen` yourself. Note that a CLI destination is not durable when disconnected: events become `CLI_DISCONNECTED` ignored events and the request is discarded. A clean `Ctrl+C` is *worse* than a crash, because it forfeits the server's ~2-minute grace window.
- **No operator tools** (`setup`, `status`, `pause`/`resume`, `replay`, `doctor`).
- **No connection pause on shutdown**, which is what makes restarts lossless.

## Development

```bash
npm install
npm test
npm run typecheck
```

296 tests, no Gateway or Hookdeck account required. Signature vectors are computed independently with `openssl`, `test/http-integration.test.ts` exercises the pipeline over a real socket including multi-byte UTF-8 and multi-chunk bodies, and the store suites inject write failures at an exact call to prove the degradation rule.

## Shared reliability contract

This plugin conforms to a contract shared with the Hookdeck plugins for Hermes Agent and n8n, so that "what happens when the run fails" has the same answer in all three: the same verification rule, the same attempt-count deduplication, the same admission-control semantics, and the same operator verbs.

Where this plugin adds something the contract does not require — retry cancellation, last-attempt dead-lettering — it defaults to off, so out-of-the-box wire behaviour matches its siblings.

## License

MIT

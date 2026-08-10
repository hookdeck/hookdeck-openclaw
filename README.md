# @hookdeck/openclaw

Reliable webhooks for OpenClaw. Puts the [Hookdeck](https://hookdeck.com) Event Gateway in front of your OpenClaw Gateway so inbound webhooks are verified, deduplicated and retryable.

> **Status: M5.** Signature verification, durable deduplication, crash recovery, dead-lettering, route filters, all three dispatch modes, connection provisioning, CLI supervision, pause-on-shutdown, outage catch-up and the agent-facing tools all work — see [Limitations](#limitations) for what remains. Nothing below describes behaviour that isn't implemented.

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
| `routes.<id>.verification` | — | Provider signature verification at the Hookdeck source: `{provider: "STRIPE", credentials: {webhook_secret_key: …}}`. See below. |
| `routes.<id>.connectionId` | — | Only needed when provisioning is off. Pause-on-shutdown and catch-up act on a connection id, so without one they are silently inert; the plugin warns at startup if that applies. |
| `routes.<id>.dispatch.sessionKey` | — | **Required.** Session the event is enqueued against. |
| `routes.<id>.dispatch.text` | `Webhook received from {source}` | Placeholders: `{source}`, `{eventId}`, `{routeId}`. |
| `routes.<id>.dispatch.wakeMode` | `now` | `now` also requests an immediate heartbeat; `next-heartbeat` only enqueues. |

`provider` is required on a secretRef — OpenClaw's own secret-input schema marks all three fields required and rejects unknown keys.

### Two different secrets

These are easy to conflate and they come from different parties:

- **`signingSecret`** is **Hookdeck's own**, project-level, from Settings → Project → Secrets. Hookdeck signs its deliveries *to you* with it, and this plugin verifies that signature. Without it, every delivery is rejected with a retryable `503`.
- **`routes.<id>.verification.credentials`** is the **provider's** — Stripe's `whsec_…`, GitHub's webhook secret. It goes on the Hookdeck *source*, and **Hookdeck** uses it to verify the provider's own signature at ingest. This plugin never sees it. Verification failure is rejected at Hookdeck's request layer, so no event is created and nothing reaches your agent.

Not reimplementing ~145 provider schemes is the point of the integration. Configure verification and Hookdeck does it; leave it out and Hookdeck accepts anything posted to the source URL, which the plugin warns about at startup.

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

## Transport and provisioning

Set `transport.mode` to `cli` and the plugin supervises one `hookdeck listen` child per route; `http` expects a reachable Gateway and provisions HTTP destinations; `none` leaves it to you.

```json
"transport": { "mode": "cli", "port": 18789 },
"provisioning": { "enabled": true }
```

Provisioning upserts the source, destination and connection in one `PUT /connections`, skipping the call entirely when the computed spec is unchanged. Three details are pinned because they are wrong by default or undocumented:

- **`auth: {}` is sent alongside `auth_type`.** The OpenAPI schema does not mark `auth` required; the API answers `422 destination.config.auth is required` without it.
- **`path_forwarding_disabled: true`.** It defaults to false, so Hookdeck appends the source request's path onto the destination path.
- **The retry rule is derived from the statuses the pipeline emits**, so it cannot drift narrower than what we answer.

A failed provisioning call never blocks startup — you may have provisioned by hand, and a Gateway that will not boot is worse than one that is not provisioned.

### CLI supervision

The `hookdeck` binary is resolved explicitly on `PATH` and the plugin **warns when one shadows another**, because a version check against one binary means nothing if a different one is launched. Versions below 2.4.0 are refused outright: before 2.3.2 the CLI does not recover an expired session — it stays connected, reports itself healthy, and silently stops delivering. Set `transport.allowUnsupportedVersion` to downgrade that to a warning. When the transport won't start, ingress still serves.

`--output compact` is forced, since the interactive default exits immediately without a TTY, which a supervisor reads as flakiness rather than misconfiguration. The API key reaches the child through the environment, never argv.

**The plugin never runs `hookdeck ci --api-key`.** It looks like an idempotent login and is not: it rewrites the CLI's global config, swaps the stored key for a session key, and switches the active project. Authentication is your business, not a side effect of starting a gateway.

### Shutdown and catch-up

On shutdown the connection is **paused before** the listener is stopped. That order is the whole point: a clean CLI shutdown tombstones the session immediately and forfeits the server's ~2 minute grace window, so events arriving next become `CLI_DISCONNECTED` ignored events and their requests are discarded. Paused, they are held at `HOLD` and delivered on the next start with attempt trigger `UNPAUSE`.

The `pausedByUs` marker is written *before* the pause call, so a crash in between still leaves the breadcrumb that unpauses on the next start — a connection left paused forever is a silent outage.

`lastDisconnectAt` is written on **every** listener exit, clean or otherwise. It is the only durable evidence of an outage window, and the catch-up replay needs it to bound its query: `bulk/requests/replay` is the only path that can be time-scoped, since `bulk/ignored-events/retry` takes no date filter and there is no project-wide `GET /ignored-events` to enumerate with.

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

## Agent tools

Seven tools, matching the shared contract's five operator verbs plus two read tools an agent host benefits from more than a CLI does.

| Tool | Answers |
|---|---|
| `hookdeck_status` | "Are webhooks working?" — routes, capacity, ledger persistence, dead-letter count, open issues, transport state, config warnings |
| `hookdeck_recent_deliveries` | "Did anything break overnight?" — open Hookdeck Issues, plus failures Hookdeck cannot see |
| `hookdeck_inspect_event` | "Why did *this* one fail?" — our row and reason beside Hookdeck's status and full attempt history; payload on request |
| `hookdeck_doctor` | What's misconfigured, including whether each connection's retry rule still covers every status we emit |
| `hookdeck_setup` | Provisions connections. Dry run by default |
| `hookdeck_pause` | Pause/resume a connection. Auto-resumes within an hour |
| `hookdeck_replay` | Retry specific events, or a scoped bulk replay. Dry run unless `confirm: true`. Caps at 100 ids per call and says what it dropped |
| `hookdeck_issues` | The dead-letter queue's lifecycle: list, acknowledge, resolve, ignore, dismiss. Replays nothing, and says so |

`tools.allowMutations: false` reduces this to the four read tools, for an agent that can diagnose but not act.

Four safety rails are deliberate. **`hookdeck_setup` defaults to a dry run**, so an agent has to mean it. **`hookdeck_replay` refuses a filtered replay without `confirm: true`**, because an unscoped retry-everything costs real money. **`hookdeck_pause` always schedules an auto-resume**, clamped to an hour, because an agent that pauses and then loses the thread must not stop the pipeline indefinitely. And **every `hookdeck_issues` mutation states that it replayed nothing** — "resolved" reads like "fixed", and an agent that resolves without replaying has tidied the dashboard and left the work undone.

Deliberately absent: `disable`, any delete, raw source/destination CRUD, transformation overwrite. Their failure mode is irrecoverable event loss and an agent cannot judge the blast radius.

`hookdeck_setup`'s dry run returns a summary rather than the raw connection spec, because that spec carries `source.config.auth` and `destination.config.auth` — a provider webhook secret must not be echoed into a model's context just because someone asked what would change.

**The tools read the plugin's state files, not just the running service.** When a tool call lands in the Gateway process it uses the live service; otherwise it opens the same JSONL state read-only from the state directory. That matters because a tool call is not reliably in the Gateway process — OpenClaw loads the plugin in the CLI process too, and `register()` runs more than once per turn. Depending on the in-memory runtime meant every tool answered "the service is not running" however healthy the deployment was.

Each result carries `source: "live" | "disk"`. On a disk view, in-flight capacity and transport state are reported as `null` rather than zero, because they exist only in the service's memory and a zero would be a lie rather than a gap. Reads are strictly read-only — including suppressing the compaction that loading would otherwise perform — since the Gateway owns those files.

> Two host requirements will silently produce a plugin with no tool surface, and neither throws:
>
> 1. **`contracts.tools` in the manifest**, listing every tool name. Without it the host logs `plugin must declare contracts.tools` and registers nothing.
> 2. **The `AgentTool` contract**: a required `label`, an `execute(toolCallId, params, …)` signature, and an `AgentToolResult` return (use `jsonResult` from `openclaw/plugin-sdk/core`). Get any of these wrong and the host accepts the registration while the agent never sees the tool.
>
> Both shipped broken here first, with a clean typecheck and a passing suite. Tests now assert the manifest matches the code, every tool has a label, the execute arity is right, and the return is an `AgentToolResult`.

### Hookdeck Issues are the dead-letter queue

This plugin does not reimplement one. A delivery Issue with `strategy: "final_attempt"` means exactly "this event is not coming back", and it carries notifications, an acknowledge/resolve lifecycle and a dashboard that a local file never will. `hookdeck_recent_deliveries` therefore leads with open Issues.

The local log holds only the residue Hookdeck is structurally blind to, created by our own choice to acknowledge early:

- an agent run that failed **after** we returned `202`, once its retry budget is spent;
- work interrupted by a crash between the acknowledgement and completion.

In both cases Hookdeck recorded a *successful* delivery, so no Issue will ever open and nothing else knows they happened. Those come back as `unreportedFailures`.

Pre-acknowledgement rejections — a cancelled retry, a final failed attempt — are mirrored locally only as a convenience where Issues are unreachable, and are returned separately as `locallyRecorded` so a reader knows to prefer the Issue. Two cases make that mirror worth keeping: deployments with no API key, and **CLI destinations, which support no issue triggers at all** — so in local development the local log is the only record there is.

### What else we let Hookdeck do

Deliberately not reimplemented, listed because the temptation is real:

- **Provider signature verification** (Stripe, GitHub, Shopify, ~145 others) happens at the Hookdeck Source via `verification.provider` + `credentials`. An unverified request is rejected at the Request layer, so no event is created and nothing reaches the agent. `signingSecret` is a different thing entirely — Hookdeck's own secret for signing deliveries *to us*.
- **Retries and backoff** are the connection's retry rule. We only choose the status code that decides what it does next.
- **Concurrency limiting** is pushed into the destination as `rate_limit_period: "concurrent"` in HTTP mode, because Hookdeck paces delivery where our local admission control has to answer `503` — spending one of the event's finite attempts to say "not now". The local limit stays as a backstop, and is the *only* control under CLI transport, where destinations carry no `rate_limit` field.
- **Payload deduplication** of a double-firing provider is the connection's `deduplicate` rule. Our ledger solves a different problem — deciding whether an incoming *attempt* is a legitimate redelivery or a duplicate — which no server-side rule can answer for us.
- **Holding events during a restart** is `PUT /connections/{id}/pause`; **catch-up** is bulk replay. Both are API calls, not local queues.

Route `filters` are the one deliberate overlap. Hookdeck can filter server-side and doing it there is better — a filtered event never reaches the agent and costs nothing — so the local ones exist only for decisions a connection cannot express.

### What reaches the model

Payload text from a webhook is third-party input, and the tools treat it that way:

- Signature, `Authorization`, cookie and token headers are redacted before an inspected event's headers are returned.
- The delivered body is **opt-in** (`includeBody`), truncated at 4,000 characters, and labelled as data rather than presented as something addressed to the reader.
- The `hookdeck listen` child's output is scrubbed of the API key as it is captured, not as it is read — that output is surfaced by `hookdeck_status` and we do not write it, so a future CLI version echoing a key into a banner would otherwise land it in a model's context with nothing here having changed.
- A test asserts that no configured secret appears in *any* tool's result, so the next tool added inherits the check.

## Trust boundary

**A valid signature authenticates the sender, not the content.** Webhook payload text is third-party input that ends up in a prompt reaching a model with tools.

- Treat payload text as data, never as instructions addressed to the agent.
- Prefer scoped tools and approval gates on webhook-triggered paths.
- Verify provider signatures at the Hookdeck source (`config.auth_type`), so a payload is attributable before it ever reaches OpenClaw. Verification failure rejects at the request layer — no event is created, so nothing reaches your agent.

Signature headers and resolved secrets are redacted from logs.

## Limitations

Not yet implemented:

- **No completion tracking for agent turns.** See [Agent turns](#agent-turns) — `sync` and `maxAgentRetries` need a completion hook the TaskFlow transport does not provide.

## Development

```bash
npm install
npm test
npm run typecheck
```

487 tests, no Gateway or Hookdeck account required. Signature vectors are computed independently with `openssl`, `test/http-integration.test.ts` exercises the pipeline over a real socket including multi-byte UTF-8 and multi-chunk bodies, and the store suites inject write failures at an exact call to prove the degradation rule.

## Shared reliability contract

This plugin conforms to a contract shared with the Hookdeck plugins for Hermes Agent and n8n, so that "what happens when the run fails" has the same answer in all three: the same verification rule, the same attempt-count deduplication, the same admission-control semantics, and the same operator verbs.

Where this plugin adds something the contract does not require — retry cancellation, last-attempt dead-lettering — it defaults to off, so out-of-the-box wire behaviour matches its siblings.

## License

MIT

# @hookdeck/openclaw

Reliable webhooks for OpenClaw. Puts the [Hookdeck](https://hookdeck.com) Event Gateway in front of your OpenClaw Gateway so inbound webhooks are verified, deduplicated and retryable.

> **Status: M1.** Signature verification, deduplication and wake dispatch work end to end. Connection provisioning, CLI supervision, TaskFlow and agent dispatch, durable storage and the operator tools are not here yet — see [Limitations](#limitations). Nothing below describes behaviour that isn't implemented.

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

### No API key required

The plugin needs **only the signing secret**. It makes no Hookdeck API calls, so there is nothing to authenticate. The Hookdeck CLI has its own separate credential (`hookdeck login`, or guest mode with no account at all).

You do not need to configure destination auth either. CLI destinations default to `auth_type: HOOKDECK_SIGNATURE` — applied server-side, so deliveries forwarded by `hookdeck listen` carry `x-hookdeck-signature` and the full `x-hookdeck-*` header set, with the body passed through byte-for-byte. Verification therefore runs identically in local dev and production, which is the point.

> This is not stated in Hookdeck's docs, which is a documentation gap rather than a caveat. Note also that CLI destination auth is API-only — the dashboard's destination editor exposes an Authentication dropdown for HTTP and Mock API destinations but only "CLI Path" for CLI ones. The default still applies.

**If local deliveries are rejected with `401`, the likely cause is a project mismatch, not missing headers.** The signing secret is per-project, so a secret from one project will not verify traffic from another. Check the CLI is logged into the same project the secret came from.

## Configuration

| Key | Default | Notes |
|---|---|---|
| `headerPrefix` | `x-hookdeck` | Hookdeck's header prefix is white-labelable per project. Set it if yours differs. |
| `signingSecret` | — | Inline string or a secretRef `{source, provider, id}`. Routes may override. Re-resolved on every request, so rotation needs no restart. |
| `ingress.basePath` | `/hookdeck` | Gateway route prefix. May not be `/`. |
| `maxConcurrent` | `4` | Local admission control. In CLI transport this is the **only** limit — CLI destinations carry no `rate_limit` field. |
| `busyRetryAfterSeconds` | `10` | `Retry-After` sent when deferring at capacity. |
| `dedupe.ttlHours` | `168` | Ledger retention. Must exceed Hookdeck's one-week retry ceiling. |
| `safety.allowRetryCancel` | `false` | See [Retry cancellation](#retry-cancellation). |
| `routes.<id>.source` | — | **Required.** Hookdeck source name. |
| `routes.<id>.path` | `/<id>` | Appended to `ingress.basePath`. |
| `routes.<id>.dispatch.sessionKey` | — | **Required.** Session the event is enqueued against. |
| `routes.<id>.dispatch.text` | `Webhook received from {source}` | Placeholders: `{source}`, `{eventId}`, `{routeId}`. |
| `routes.<id>.dispatch.wakeMode` | `now` | `now` also requests an immediate heartbeat; `next-heartbeat` only enqueues. |

`provider` is required on a secretRef — OpenClaw's own secret-input schema marks all three fields required and rejects unknown keys.

## Response contract

Every status is chosen for what Hookdeck does next, not for HTTP tidiness. Any non-2xx is retried by default.

| Situation | Status | `Retry-After` |
|---|---|---|
| Dispatched | `200` | — |
| Duplicate attempt | `200` | — |
| Wrong method / path / content type | `405` / `404` / `415` | cancel¹ |
| Body too large | `413` | cancel¹ |
| Not a Hookdeck delivery, or no event id | `400` | cancel¹ |
| Malformed JSON | `400` | cancel¹ |
| No signing secret configured | `503` | `30` |
| Signature mismatch | `401` | — |
| Same event already in flight | `503` | `5` |
| At `maxConcurrent` | `503` | `busyRetryAfterSeconds` |
| Dispatch failed, transient | `503` | `15` |
| Still starting | `503` | `30` |

¹ Only when `safety.allowRetryCancel` is enabled. See below.

**Configure your connection's retry rule to cover `500-599`, `429` and `408`.** A narrower rule turns admission control into silent data loss: the plugin defers with `503` expecting redelivery, and it never comes.

Two deliberate choices worth knowing:

- **A deferred event is not recorded.** Nothing is written to the ledger when we answer `503` at capacity. Recording it would make Hookdeck's redelivery look like a duplicate, and the event would vanish.
- **A failure on the last attempt stays a failure.** We do not convert it to `2xx` to keep the dashboard green — the failure is what opens a Hookdeck Issue, and the Issue is your alert.

### Deduplication

Keyed on `x-hookdeck-eventid`, but the rule is about the attempt number, not identity:

> Admit a delivery when its attempt number is greater than the highest attempt already recorded for that event id. Otherwise reject it as a duplicate. When the attempt header is absent, admit only if the previous run for that event is recorded as failed.

This matters because Hookdeck redelivers a *failed* event under the **same** event id. Deduplicating on identity alone would look idempotent while quietly never retrying anything.

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

M1 is the ingress core. Not yet implemented:

- **The ledger is in-memory.** A Gateway restart loses it, so work can re-run once. Durable JSONL storage with atomic compaction is next.
- **Only `wake` dispatch.** TaskFlow actions and agent turns come later.
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

156 tests, no Gateway or Hookdeck account required. Signature vectors are computed independently with `openssl`, and `test/http-integration.test.ts` exercises the pipeline over a real socket including multi-byte UTF-8 and multi-chunk bodies.

## Shared reliability contract

This plugin conforms to a contract shared with the Hookdeck plugins for Hermes Agent and n8n, so that "what happens when the run fails" has the same answer in all three: the same verification rule, the same attempt-count deduplication, the same admission-control semantics, and the same operator verbs.

Where this plugin adds something the contract does not require — retry cancellation, last-attempt dead-lettering — it defaults to off, so out-of-the-box wire behaviour matches its siblings.

## License

MIT

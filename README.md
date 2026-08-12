# @hookdeck/openclaw

**Reliable webhooks for OpenClaw.** Put the [Hookdeck Event Gateway](https://hookdeck.com) in front of your agent's inbound webhooks: signature verification for 145+ providers, event deduplication, a durable queue that survives restarts, and agent tools for inspecting and replaying deliveries.

```bash
openclaw plugins install clawhub:@hookdeck/openclaw
```

## Why

OpenClaw's built-in webhook support keeps core minimal: one shared token for every webhook, no provider signature verification, no deduplication, and no queue: if the gateway is down when an event arrives, the event is gone. Requests for per-provider auth ([#4977](https://github.com/openclaw/openclaw/issues/4977)) and for targeting an agent by id ([#5868](https://github.com/openclaw/openclaw/issues/5868)) were closed as not planned, with plugins named as the intended extension point. Per-agent routing did land separately, via webhook mappings ([#9130](https://github.com/openclaw/openclaw/issues/9130)).

This plugin fills those gaps by making Hookdeck the ingress layer for your agent:

| OpenClaw core | With @hookdeck/openclaw |
|---|---|
| Single shared `hooks.token` for all webhooks | Provider signature verification (Stripe, GitHub, Shopify, and 145+ more) at the Hookdeck source, plus Hookdeck signature verification on delivery |
| Providers must reach your machine directly | `hookdeck listen` holds an outbound connection; no inbound port to expose |
| Provider retries reprocessed as new events | Deduplication by event ID and attempt number; duplicates rejected cleanly |
| Events lost while the gateway is down or restarting | Durable ledger + Hookdeck retries; in-flight events are requeued on restart, connections pause on shutdown so events queue upstream |
| Webhook debugging via log spelunking | `hookdeck_status`, `hookdeck_inspect_event`, dead-letter management, and the Hookdeck dashboard |

## Features

- **Verification:** Hookdeck verifies provider signatures at the source; the plugin verifies Hookdeck's signature on every delivery. Unverified requests are rejected before dispatch.
- **Deduplication:** deliveries are tracked by event ID and attempt number in an append-only JSONL ledger. A delivery is admitted only when its attempt number exceeds the highest recorded for that event ID. Retries of handled events return `200` so Hookdeck stops resending.
- **Durability:** the ledger survives crashes. On restart, orphaned in-flight entries are settled and handed back to Hookdeck via `POST /events/{id}/retry`. Hookdeck is the authoritative work queue; the plugin never loses events it has acknowledged.
- **Three dispatch modes:** `wake` (enqueue a system event, optionally request an immediate heartbeat), `taskflow` (accept TaskFlow action envelopes from automation platforms), and `agent` (render the raw provider payload into a prompt for an isolated agent turn, no envelope required).
- **Routing and filtering:** per-route source mapping, session keys, and payload filters (`equals`, `in`, `exists`). Non-matching events return `200` with `{"ignored": true}`.
- **CLI supervision:** manages a `hookdeck listen` child process per route (requires Hookdeck CLI 2.4.0 or later), with binary shadowing detection. `http` and `none` transport modes are available for reachable gateways and manual provisioning.
- **Catch-up:** if requests arrived during an outage longer than a configurable threshold, they're replayed after restart.

## Quickstart

1. Create a [Hookdeck account](https://dashboard.hookdeck.com/signup) (free tier works) and install the [Hookdeck CLI](https://hookdeck.com/cli) version 2.4.0 or later.
1. Install the plugin:

   ```bash
   openclaw plugins install clawhub:@hookdeck/openclaw
   ```

1. Add your Hookdeck project signing secret (from the dashboard Settings page) and a route to `~/.openclaw/openclaw.json`:

   ```json
   {
     "plugins": {
       "entries": {
         "hookdeck": {
           "enabled": true,
           "config": {
             "signingSecret": "<your Hookdeck signing secret>",
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

   `signingSecret` also accepts a secret reference, so the value need not sit in
   the config file: `{ "source": "env", "provider": "env", "id": "HOOKDECK_SIGNING_SECRET" }`.

1. Restart the OpenClaw gateway. The plugin verifies, deduplicates, and dispatches events from your `stripe` source.

Receiving requires only the signing secret. Adding an `apiKey` unlocks provisioning (`hookdeck_setup`), pause/resume, replay, and issue management.

## Agent tools

Your agent can operate its own webhook infrastructure. Read-only diagnostics:

| Tool | What it does |
|---|---|
| `hookdeck_status` | Routes, capacity, ledger state, dead-letter count, transport health |
| `hookdeck_recent_deliveries` | Open Hookdeck Issues plus locally recorded failures |
| `hookdeck_inspect_event` | Full event detail including attempts and payload |
| `hookdeck_doctor` | Config validation and retry rule coverage checks |

Action tools, each with a rail on the destructive path:

| Tool | What it does |
|---|---|
| `hookdeck_setup` | Provisions sources, destinations, and connections. Dry run unless `dryRun: false` |
| `hookdeck_pause` | Pauses/resumes connections. Always schedules an auto-resume, clamped to an hour |
| `hookdeck_replay` | Retries specific event IDs or bulk-replays scoped requests (`confirm: true` required) |
| `hookdeck_issues` | Lists, acknowledges, resolves, ignores or dismisses Issues. Dismissing needs `confirm: true` |

Set `tools.allowMutations: false` to restrict agents to read-only access.

## Configuration reference

| Setting | Default | Purpose |
|---|---|---|
| `signingSecret` | none (required) | Hookdeck project signing secret |
| `apiKey` | none (optional) | Enables provisioning, pause/resume, replay, recovery |
| `storage.enabled` | `true` | Persist the ledger to survive restarts |
| `ingress.basePath` | `/hookdeck` | Gateway route prefix |
| `maxConcurrent` | `4` | Local admission control |
| `dedupe.ttlHours` | `168` | Ledger retention, matched to Hookdeck's retry ceiling |
| `routes.<id>.source` | none (required) | Hookdeck source name, one per route |
| `routes.<id>.dispatch` | none (required) | Dispatch mode, session key, wake behavior |
| `tools.allowMutations` | `true` | Set `false` for read-only agent tools |

## Security model

Webhook payloads are third-party input, and this plugin treats them that way:

- Provider verification happens at the Hookdeck source; failures reject at the request layer before OpenClaw is involved.
- Two distinct secrets: `signingSecret` authenticates Hookdeck's deliveries to OpenClaw; provider credentials (e.g. Stripe's `whsec_...`) are configured at the Hookdeck source and never touch your machine.
- Signatures and tokens are redacted from logs and tool output; API keys are scrubbed from CLI output; payload bodies are truncated and labelled as opt-in data.
- Payload text is data, never instructions.
- In CLI transport mode, no inbound port is exposed on the machine running OpenClaw.

## Limitations

- Agent turns are fire-and-forget: acknowledged when the run starts, not when it completes.
- Signatures authenticate the body only, not headers.
- JSON and form-encoded bodies only.
- List endpoints return the first page only.

## Documentation

The README covers the common path. Everything else lives in [`docs/`](docs/):

| Guide | What's in it |
|---|---|
| [Getting started](docs/getting-started.md) | Install, the full config shape, pointing Hookdeck at your Gateway, and what an API key does and does not unlock |
| [Configuration reference](docs/configuration.md) | Every setting, its default, and what it changes |
| [Dispatch modes](docs/dispatch-modes.md) | `wake`, `taskflow` and `agent` in detail, with route filters |
| [Transport and provisioning](docs/transport.md) | The supervised CLI tunnel, `http` and `none` modes, and what gets provisioned |
| [Response contract](docs/response-contract.md) | Every status returned and what Hookdeck does next with it |
| [Durability and recovery](docs/durability.md) | The ledger, crash recovery, dead-lettering, and retry vs replay |
| [Agent tools](docs/agent-tools.md) | All eight tools, their arguments, and the rails on each |
| [Security](docs/security.md) | The trust boundary, secret handling, and what reaches the model |
| [Limitations](docs/limitations.md) | Known boundaries, in full |

## Development

```bash
openclaw plugins install --link ./hookdeck-openclaw
npm test           # no Gateway or Hookdeck account required
npm run test:package   # loads the packed tarball in a real Gateway
npm run test:e2e       # real project, real tunnel, real events (needs HOOKDECK_TEST_API_KEY)
```

## Learn more

- [Using Hookdeck with OpenClaw](https://hookdeck.com/webhooks/platforms/using-hookdeck-with-openclaw-reliable-webhooks-for-your-ai-agent): full architecture walkthrough
- [Hookdeck docs](https://hookdeck.com/docs)
- [Hookdeck Console](https://console.hookdeck.com): inspect webhooks without an account

Issues and PRs welcome.

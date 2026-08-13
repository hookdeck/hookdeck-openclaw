# Getting started

The long version: installing, the exact configuration shape, pointing Hookdeck at your Gateway, and what you do and do not need an API key for.

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
          "signingSecret": {
            "source": "env",
            "provider": "env",
            "id": "HOOKDECK_SIGNING_SECRET"
          },
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

## No API key required to receive webhooks

Receiving needs **only the signing secret** — verification, deduplication and dispatch make no Hookdeck API calls at all. The Hookdeck CLI has its own separate credential (`hookdeck login`, or guest mode with no account at all).

An `apiKey` is optional. Without one the plugin runs ingress-only: verification, deduplication and dispatch all work, and interrupted work is still detected, settled and dead-lettered — just not re-run. Provisioning, pause/resume, replay, issue management and crash recovery all need it, and the startup log says which are unavailable.

You do not need to configure destination auth either. CLI destinations default to `auth_type: HOOKDECK_SIGNATURE` — applied server-side, so deliveries forwarded by `hookdeck listen` carry `x-hookdeck-signature` and the full `x-hookdeck-*` header set, with the body passed through byte-for-byte. Verification therefore runs identically in local dev and production, which is the point.

> CLI destination auth is API-only: the dashboard's destination editor exposes an Authentication dropdown for HTTP and Mock API destinations, but only "CLI Path" for CLI ones. The default still applies.

**If local deliveries are rejected with `401`, the likely cause is a project mismatch, not missing headers.** The signing secret is per-project, so a secret from one project will not verify traffic from another. Check the CLI is logged into the same project the secret came from.

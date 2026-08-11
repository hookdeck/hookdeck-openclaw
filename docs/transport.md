# Transport and provisioning

How events reach the Gateway — a supervised CLI tunnel, a public HTTPS destination, or a transport you manage — and what the plugin provisions in your Hookdeck project.

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

## CLI supervision

The `hookdeck` binary is resolved explicitly on `PATH` and the plugin **warns when one shadows another**, because a version check against one binary means nothing if a different one is launched. Versions below 2.4.0 are refused outright: before 2.3.2 the CLI does not recover an expired session — it stays connected, reports itself healthy, and silently stops delivering. Set `transport.allowUnsupportedVersion` to downgrade that to a warning. When the transport won't start, ingress still serves.

`--output compact` is forced, since the interactive default exits immediately without a TTY, which a supervisor reads as flakiness rather than misconfiguration. The API key reaches the child through the environment, never argv.

**The plugin never runs `hookdeck ci --api-key`.** It looks like an idempotent login and is not: it rewrites the CLI's global config, swaps the stored key for a session key, and switches the active project. Authentication is your business, not a side effect of starting a gateway.

## Shutdown and catch-up

On shutdown the connection is **paused before** the listener is stopped. That order is the whole point: a clean CLI shutdown tombstones the session immediately and forfeits the server's ~2 minute grace window, so events arriving next become `CLI_DISCONNECTED` ignored events and their requests are discarded. Paused, they are held at `HOLD` and delivered on the next start with attempt trigger `UNPAUSE`.

The `pausedByUs` marker is written *before* the pause call, so a crash in between still leaves the breadcrumb that unpauses on the next start — a connection left paused forever is a silent outage.

`lastDisconnectAt` is written on **every** listener exit, clean or otherwise. It is the only durable evidence of an outage window, and the catch-up replay needs it to bound its query: `bulk/requests/replay` is the only path that can be time-scoped, since `bulk/ignored-events/retry` takes no date filter and there is no project-wide `GET /ignored-events` to enumerate with.

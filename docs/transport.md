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

## The two projects problem

In `cli` transport, "which Hookdeck project" has two independent answers:

- `hookdeck_setup` and every API call act on the project the **API key** belongs to.
- `hookdeck listen` looks for that connection in the project the **CLI session** is logged into.

Nothing reconciles them, and the plugin deliberately does not try: forcing them together means `hookdeck ci`, which rewrites the CLI's global config and switches the active project for every other use on the machine.

When they differ, the failure is quiet in the worst way. The Gateway starts, logs that the transport is up, and receives nothing — the tunnel restart-loops on `no connection found matching filter` while every event becomes an ignored `CLI_DISCONNECTED`.

Two things make it visible rather than silent:

- **`hookdeck_doctor` compares them.** It reads the CLI's project from its config file and the API key's from `team_id` on any connection the key can reach, and fails with both ids and the fix. A CLI with no session, or a key that reaches no connections, is reported as unverified rather than as a mismatch — a project can legitimately be empty, and a missing session is its own separate failure.
- **The supervisor escalates a standing failure.** After three consecutive runs that fail to stay up, it logs once — not once per restart — with the CLI's own last lines and, where the output is recognisable, the likely cause. A healthy run re-arms it, so a second outage is not silent.

If your API key is organisation-scoped rather than project-scoped, set `projectId` as well: without it a call can act on whichever project happens to hold a resource of the same name.

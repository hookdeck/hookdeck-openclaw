# Dispatch modes

What a verified event actually does when it arrives: wake a session, apply a TaskFlow action, or start an agent turn.

Each route picks one.

| Mode | What it does | Use it for |
|---|---|---|
| `wake` | Enqueues a system event and, by default, requests an immediate heartbeat. | "Something happened, look at it." Cheapest option. |
| `taskflow` | Body is a TaskFlow action envelope (`create_flow`, `run_task`, `finish_flow`, …), applied against a bound session. | Automation sources that already speak OpenClaw's vocabulary — n8n, Zapier, CI. |
| `agent` | Renders the payload into a prompt and runs an isolated turn. | Raw provider webhooks. A Stripe body is not a TaskFlow envelope and never will be, so this is the mode that works with any of Hookdeck's ~145 verified providers on day one. |

## TaskFlow semantics

The status taxonomy mirrors the built-in Webhooks plugin, with two entries worth knowing:

- **`revision_conflict` cancels retries.** `expectedRevision` is baked into the stored request and TaskFlow revisions only ever increase, so a retry of that exact envelope can never succeed. The current revision comes back in the body so the caller can re-read and re-send.
- **`not_found` does not cancel.** The flow may simply not exist yet — an envelope can race ahead of the creation that produces it — and Hookdeck's backoff resolves that for free.

## Agent turns

The prompt template's own text is trusted; everything substituted into it is not. See [Trust boundary](#trust-boundary).

Turns are started through TaskFlow `run_task` rather than `subagent.run`, and that is not a preference. **A plugin-registered HTTP route with `auth: "plugin"` is given `scopes: []` unconditionally** — the Gateway's `createPluginRouteRuntimeScope` reads `route.auth !== "gateway" ? [] : …`, and `gatewayRuntimeScopeSurface` only applies on the `"gateway"` branch. Since this plugin authenticates with Hookdeck's signature rather than the Gateway's own credentials, the `operator.write` scope is structurally unreachable and `subagent.run` answers `missing scope: operator.write`.

`run_task` has no such requirement, and it is the better fit anyway: the run becomes durable flow state rather than a bare run id, so it survives a restart and stays inspectable.

The consequence is honest rather than hidden: **TaskFlow exposes flow state, not a completion promise**, so this transport cannot observe when a run finishes. The route acknowledges `202` once the task is created and settles the ledger there. `ackMode: "sync"` and `maxAgentRetries` need completion observability and therefore have no effect on this transport — they are wired and tested for hosts where the route does carry operator scopes.

## Route filters

Filters are matched against the parsed payload; all must pass. A non-match is answered `200` with `{"ignored": true}`, because the drop is deliberate and a `2xx` correctly retires the event. Nothing is written to the ledger for a filtered event.

```json
"filters": [{ "path": "type", "equals": "invoice.paid" }]
```

`equals`, `in` and `exists` are supported. Prefer filtering at the Hookdeck connection where you can — an event filtered there never reaches the agent and costs nothing.

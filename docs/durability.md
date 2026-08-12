# Durability and recovery

What survives a crash, what is re-queued, where an event that has been given up on ends up, and why retry and replay are not the same operation.

The ledger is an append-only JSONL file under the plugin's state directory, compacted atomically (write, fsync, rename) and on shutdown. It survives a restart, so a redelivery that arrives after the Gateway has bounced is still recognised as a duplicate rather than re-running the work.

**If a write fails, persistence disables itself permanently for that process, logs once, and handling continues in memory.** A broken disk degrades the guarantee from exactly-once to at-least-once; it must never wedge webhook handling. `storage.enabled: false` chooses the same trade deliberately.

## Crash recovery

A `running` row owned by a process instance that no longer exists is an orphan by definition — the process that owned it is gone, so its outcome is unknown. On startup each one is settled, dead-lettered, and handed back to Hookdeck with `POST /events/{id}/retry` so the normal pipeline re-runs it.

This is the payoff of putting an event gateway in front: **Hookdeck is the durable work queue, so the plugin never needs to build one.** That matters concretely, because OpenClaw's own durable queue (`openChannelIngressQueue`) is gated to bundled and trusted-official plugins and unavailable to community plugins like this one.

Manual retry works on events Hookdeck already considers `SUCCESSFUL` — confirmed against a live project — which is what makes the recovery call legitimate rather than a hack.

> **Recovery can re-run an event whose dispatch finished in the instant before the crash.** That is the at-least-once contract this design already assumes rather than a new hazard, but it is the kind of thing discovered via a duplicate side effect at 2am. Make webhook-triggered work idempotent. Set `recovery.enabled: false` to opt out; orphans are then recorded but never re-run.

Without `apiKey`, orphans are still detected, settled and dead-lettered — they just aren't re-queued, and the startup log says so.

## Retry cancellation

`safety.allowRetryCancel` lets the plugin answer `Retry-After: -1` on permanently-invalid input — malformed JSON, a body that will never fit — which tells Hookdeck to stop retrying instead of burning all 50 attempts on something that cannot succeed.

**It is off by default, and that default is deliberate.** A mistake here discards real traffic, and the events are gone once retention lapses (3 days on the free plan). Cancellation is only ever emitted from a closed allowlist of reasons, always dead-letters first, and never fires for anything a config change could fix — a missing secret, an unresolvable secretRef or a storage failure all stay retryable. Turn it on once you have watched the logs and seen what it *would* have cancelled.

## A crash that never ran its shutdown

`lastDisconnectAt` is written when the tunnel's child process exits, which requires this process to be alive to notice. A `kill -9`, an OOM kill or a power cut takes that handler with it, so the outage most in need of catch-up would leave no record of itself at all — and catch-up, finding no disconnect, would skip it.

So while the transport is running the plugin records a liveness marker every `catchUp.heartbeatSeconds` (30 by default), and clears it on a clean shutdown. Finding one at startup means the previous process died without stopping, and its timestamp becomes the start of the outage window.

Over-shooting that window by up to one heartbeat is harmless: the catch-up query matches only requests that produced no event at all, so anything that did deliver is excluded by construction.

## What catch-up guarantees

Within Hookdeck's retention, catch-up recovers every request that arrived during an outage and produced no delivery. Three things make that a guarantee rather than a hope, and each was wrong at some point:

**The filter matches every way a request can be stranded.** Measured against a live project, the two disconnect regimes look different:

| | `events_count` | `ignored_count` |
|---|---|---|
| The tunnel never existed | 0 | 1 |
| The tunnel connected, then the process was killed | 0 | **0** |

The second is the hard-crash case. It matches neither `ignored_count >= 1` nor `cli_events_count: 0` — that field is not populated when no CLI event was ever created — so a filter using either excludes precisely the case catch-up exists for. The query keys on `events_count: 0` alone.

**The outage window survives a crash.** See [above](#a-crash-that-never-ran-its-shutdown).

**The result is confirmed, not assumed.** The replay call returns as soon as the batch is accepted, so its `estimated_count` is a plan. The plugin polls the batch until Hookdeck reports it finished and then logs `N of M request(s) replayed`. A shortfall is a warning naming it; a batch that does not finish within the wait is reported as unknown rather than as success.

What it cannot do is recover anything Hookdeck has already aged out — 3 days on free, 7 on Team, 30 on Growth. Beyond that the request is gone at the source, and no filter or replay reaches it.

> Do not try to verify recovery by re-reading the original requests. A replay re-ingests each one as a **new** request with new events, so the original stays at `events_count: 0` for ever. Checking it will always report a stranded request that was in fact recovered.

## Malformed bodies never reach the plugin

Verified end to end: Hookdeck rejects an unparseable JSON body **at the edge**, answering the sender `400` with `rejection_cause: UNPARSABLE_JSON` and creating no event. The plugin's own `malformed_json` handling is therefore defence in depth rather than a path real traffic takes — it covers a body that survives the edge and fails here, such as one that is valid JSON but not valid UTF-8.

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

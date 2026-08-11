# Limitations

Known boundaries, stated so nobody discovers them at 2am.

Not yet implemented:

- **Agent turns are fire-and-forget.** They run through TaskFlow `run_task`, which exposes flow state rather than a completion signal, so the delivery is acknowledged as soon as the run *starts*. Concretely: `ackMode: "sync"` does not wait, `maxAgentRetries` never fires, and a crash mid-run is **not** re-queued by boot recovery — the ledger row is already `succeeded`. Run durability belongs to the flow record from that point, and Hookdeck's guarantee covers delivery rather than completion. `deliver` and `lane` are likewise recorded but not passed to the turn. Every one of these warns at startup rather than failing quietly. `taskflow` and `wake` dispatch are unaffected.
- **A signature authenticates the body, not the headers.** Hookdeck's HMAC covers the raw body only, with a project-level secret and no signed timestamp. So the event id and attempt count arrive unauthenticated, and a captured `(body, signature)` pair stays valid. Deduplication is what provides replay protection, an implausible attempt count is discarded rather than recorded, and provider verification at the Source is the layer that keeps unsigned traffic out in the first place.
- **Form-encoded and JSON bodies only.** `application/x-www-form-urlencoded` (Twilio, Slack) and `application/json` are parsed; anything else is rejected permanently.
- **List endpoints read the first page only.** `hookdeck_issues` and `hookdeck_recent_deliveries` report a real total from the count endpoint, but return one page of results.

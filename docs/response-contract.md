# Response contract

Every status this plugin returns and what Hookdeck does next with it. A status chosen wrongly either loses an event or retries one forever, so each is picked for its consequence rather than for HTTP tidiness.

Any non-2xx is retried by default.

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

## Deduplication

Keyed on `x-hookdeck-eventid`, but the rule is about the attempt number, not identity:

> Admit a delivery when its attempt number is greater than the highest attempt already recorded for that event id. Otherwise reject it as a duplicate. When the attempt header is absent, admit only if the previous run for that event is recorded as failed.

This matters because Hookdeck redelivers a *failed* event under the **same** event id. Deduplicating on identity alone would look idempotent while quietly never retrying anything.

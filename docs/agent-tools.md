# Agent tools

The eight tools an agent can call, what each returns, and the rails on the ones that change something.

Eight tools. Five are the operator verbs — `setup`, `status`, `pause`/`resume`, `replay`, `doctor` — plus three an agent host benefits from more than a CLI does. Two of those correlate what Hookdeck saw with what we did (`hookdeck_recent_deliveries`, `hookdeck_inspect_event`); the third, `hookdeck_issues`, is the dead-letter queue's own lifecycle.

| Tool | Answers |
|---|---|
| `hookdeck_status` | "Are webhooks working?" — routes, capacity, ledger persistence, dead-letter count, open issues, transport state, config warnings |
| `hookdeck_recent_deliveries` | "Did anything break overnight?" — open Hookdeck Issues, plus failures Hookdeck cannot see |
| `hookdeck_inspect_event` | "Why did *this* one fail?" — our row and reason beside Hookdeck's status and full attempt history; payload on request |
| `hookdeck_doctor` | What's misconfigured, including whether each connection's retry rule still covers every status we emit |
| `hookdeck_setup` | Provisions connections. Dry run by default |
| `hookdeck_pause` | Pause/resume a connection. Auto-resumes within an hour |
| `hookdeck_replay` | **Retries** specific events (`eventIds`), or runs a scoped bulk **replay** of requests (`routeId` + `sinceMinutes`). Dry run unless `confirm: true`. Caps at 100 ids per call and says what it dropped |
| `hookdeck_issues` | The dead-letter queue's lifecycle: list, acknowledge, resolve, ignore, dismiss. Replays nothing, and says so |

`tools.allowMutations: false` reduces this to the five read tools — `hookdeck_issues` stays, able to list and inspect but not acknowledge, resolve or dismiss — for an agent that can diagnose but not act.

Four safety rails are deliberate. **`hookdeck_setup` defaults to a dry run**, so an agent has to mean it. **`hookdeck_replay` refuses a bulk replay without `confirm: true`**, because replaying an unscoped window costs real money. **`hookdeck_pause` always schedules an auto-resume**, clamped to an hour, because an agent that pauses and then loses the thread must not stop the pipeline indefinitely. And **every `hookdeck_issues` mutation states that it replayed nothing** — "resolved" reads like "fixed", and an agent that resolves without replaying has tidied the dashboard and left the work undone.

Deliberately absent: `disable`, any delete, raw source/destination CRUD, transformation overwrite. Their failure mode is irrecoverable event loss and an agent cannot judge the blast radius.

`hookdeck_setup`'s dry run returns a summary rather than the raw connection spec, because that spec carries `source.config.auth` and `destination.config.auth` — a provider webhook secret must not be echoed into a model's context just because someone asked what would change.

**The tools read the plugin's state files, not just the running service.** When a tool call lands in the Gateway process it uses the live service; otherwise it opens the same JSONL state read-only from the state directory. That matters because a tool call is not reliably in the Gateway process — OpenClaw loads the plugin in the CLI process too, and `register()` runs more than once per turn. Depending on the in-memory runtime meant every tool answered "the service is not running" however healthy the deployment was.

Each result carries `source: "live" | "disk"`. On a disk view, in-flight capacity and transport state are reported as `null` rather than zero, because they exist only in the service's memory and a zero would be a lie rather than a gap. Reads are strictly read-only — including suppressing the compaction that loading would otherwise perform — since the Gateway owns those files.

> Two host requirements will silently produce a plugin with no tool surface, and neither throws:
>
> 1. **`contracts.tools` in the manifest**, listing every tool name. Without it the host logs `plugin must declare contracts.tools` and registers nothing.
> 2. **The `AgentTool` contract**: a required `label`, an `execute(toolCallId, params, …)` signature, and an `AgentToolResult` return (use `jsonResult` from `openclaw/plugin-sdk/core`). Get any of these wrong and the host accepts the registration while the agent never sees the tool.
>
> Neither failure is visible to a typecheck or to handler-level tests, so `test/tool-wiring.test.ts` asserts the manifest matches the code, every tool has a label, the execute arity is right, and the return is an `AgentToolResult`.

## Retry and replay are different operations

Hookdeck distinguishes them, so this plugin does too:

- **Retry** (`POST /events/{id}/retry`) makes a new delivery attempt for an existing event. The event id is unchanged and the attempt count goes up.
- **Replay** (`POST /bulk/requests/replay`) re-ingests the original *requests* through the pipeline, producing **new events with new ids**. The originals are untouched.

Almost everything here is a retry: crash recovery re-queuing interrupted work, an agent run asking for another delivery, and `hookdeck_replay` when given explicit `eventIds`. Only catch-up after an outage is a true replay, because the events it needs never existed — the requests arrived while no CLI session was attached, so Hookdeck discarded them rather than creating events to retry.

That distinction decides whether deduplication can protect you:

| | Ledger sees | Suppressed? |
|---|---|---|
| Retry | Same event id, higher attempt | Admitted by the attempt rule, and a duplicate of an already-handled attempt is rejected |
| Replay | A brand-new event id | Admitted as a first delivery — **the ledger has no way to know it is related to anything** |

So a replay of requests that already ran successfully **will run the work again**. That is why every replay path here is scoped to requests that produced no event at all (`cli_events_count: 0`, `ignored_count >= 1`) rather than to a bare time window, and why the tool insists on `confirm: true`. If you need protection against a broader replay, `route.dedupe.idPath` keys deduplication on a provider-native id in the payload, which survives re-ingestion.

## Hookdeck Issues are the dead-letter queue

This plugin does not reimplement one. A delivery Issue with `strategy: "final_attempt"` means exactly "this event is not coming back", and it carries notifications, an acknowledge/resolve lifecycle and a dashboard that a local file never will. `hookdeck_recent_deliveries` therefore leads with open Issues.

The local log holds only the residue Hookdeck is structurally blind to, created by our own choice to acknowledge early:

- an agent run that failed **after** we returned `202`, once its retry budget is spent;
- work interrupted by a crash between the acknowledgement and completion.

In both cases Hookdeck recorded a *successful* delivery, so no Issue will ever open and nothing else knows they happened. Those come back as `unreportedFailures`.

Pre-acknowledgement rejections — a cancelled retry, a final failed attempt — are mirrored locally only as a convenience where Issues are unreachable, and are returned separately as `locallyRecorded` so a reader knows to prefer the Issue. Two cases make that mirror worth keeping: deployments with no API key, and **CLI destinations, which support no issue triggers at all** — so in local development the local log is the only record there is.

## What else we let Hookdeck do

Deliberately not reimplemented, listed because the temptation is real:

- **Provider signature verification** (Stripe, GitHub, Shopify, ~145 others) happens at the Hookdeck Source via `verification.provider` + `credentials`. An unverified request is rejected at the Request layer, so no event is created and nothing reaches the agent. `signingSecret` is a different thing entirely — Hookdeck's own secret for signing deliveries *to us*.
- **Retries and backoff** are the connection's retry rule. We only choose the status code that decides what it does next.
- **Concurrency limiting** is pushed into the destination as `rate_limit_period: "concurrent"` in HTTP mode, because Hookdeck paces delivery where our local admission control has to answer `503` — spending one of the event's finite attempts to say "not now". The local limit stays as a backstop, and is the *only* control under CLI transport, where destinations carry no `rate_limit` field.
- **Payload deduplication** of a double-firing provider is the connection's `deduplicate` rule. Our ledger solves a different problem — deciding whether an incoming *attempt* is a legitimate redelivery or a duplicate — which no server-side rule can answer for us.
- **Holding events during a restart** is `PUT /connections/{id}/pause`; **catch-up** is bulk replay. Both are API calls, not local queues.

Route `filters` are the one deliberate overlap. Hookdeck can filter server-side and doing it there is better — a filtered event never reaches the agent and costs nothing — so the local ones exist only for decisions a connection cannot express.

## What reaches the model

Payload text from a webhook is third-party input, and the tools treat it that way:

- Signature, `Authorization`, cookie and token headers are redacted before an inspected event's headers are returned.
- The delivered body is **opt-in** (`includeBody`), truncated at 4,000 characters, and labelled as data rather than presented as something addressed to the reader.
- The `hookdeck listen` child's output is scrubbed of the API key as it is captured, not as it is read — that output is surfaced by `hookdeck_status` and we do not write it, so a future CLI version echoing a key into a banner would otherwise land it in a model's context with nothing here having changed.
- A test asserts that no configured secret appears in *any* tool's result, so the next tool added inherits the check.

## Counts are counted

A status tool that returns a page and lets the reader infer a total is worse than one that says nothing: a model asked "what needs attention?" will report what it can see as though it were everything.

- `hookdeck_status.openIssues` and `hookdeck_issues`' `total` come from Hookdeck's count endpoint, not from the length of a page.
- `hookdeck_recent_deliveries` returns `openIssuesTotal` beside the page it shows, and an `openIssuesTruncated` note whenever the two differ. The local records get the same treatment via `localTruncated`.
- `hookdeck_status.deadLetters` is the local log's true size, but the log evicts oldest-first at its cap — so once it is full, `deadLettersIsAtLeast: true` says the number is a floor. A floor reported as a floor beats a ceiling reported as a total.

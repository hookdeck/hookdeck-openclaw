# Security and the trust boundary

A valid signature authenticates the sender, not the content. That matters more here than in most webhook receivers, because a payload can reach a model that has tools.

**A valid signature authenticates the sender, not the content.** Webhook payload text is third-party input that ends up in a prompt reaching a model with tools.

- Treat payload text as data, never as instructions addressed to the agent.
- Prefer scoped tools and approval gates on webhook-triggered paths.
- Verify provider signatures at the Hookdeck source (`config.auth_type`), so a payload is attributable before it ever reaches OpenClaw. Verification failure rejects at the request layer — no event is created, so nothing reaches your agent.

Signature headers and resolved secrets are redacted from logs.

## Provider verification, proven against a real provider

Two suites cover this, because neither is sufficient alone.

`npm run test:e2e:verification` is fully automated. It provisions a source **through the plugin's own config**, so it tests the shape this codebase sends, then posts a correctly signed payload and a forged one. The forged case is the assertion that matters: a source holding a provider secret is byte-identical over the API to one without it, since the secret is never returned, so the only proof verification is switched on is that an invalid signature is refused — `verified: false`, `rejection_cause: VERIFICATION_FAILED`, and no event created.

`scripts/e2e-live-stripe.mjs` closes what synthesis cannot reach: a real webhook from Stripe. It found that a real `Stripe-Signature` carries three schemes, not the two in the documented example —

```
t=1786615…,v1=e798bfb…,v0=6260368…
```

— and Hookdeck verified it regardless. The run also produced its own control group: requests that arrived before the source was armed came in `VERIFICATION_FAILED`, and the same endpoint verified cleanly a minute later once the secret was set.

> **Read `verified` and `rejection_cause`, never the status code.** Hookdeck answers **200 at the edge** while refusing a request. A test that checks the status will report verification as working when it is switched off.

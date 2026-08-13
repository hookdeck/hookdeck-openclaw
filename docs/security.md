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

`hookdeck_doctor` reads that field, and reports **unknown** when no request carries a result — neither "verified" nor "unverified" is inferred from the API's silence. Both errors are the same mistake in opposite directions: one tells an operator their source is protected when nothing was observed, the other that it accepts forgeries when the API simply did not say.

Note also that only a **generic** `WEBHOOK` source reports `config.auth_type` back. A platform-typed source with a provider secret and one without return byte-identical config, so for those there is no signal at all short of an inbound request.

`scripts/e2e-live-stripe.mjs` closes what synthesis cannot reach: a real webhook from Stripe. It found that a real `Stripe-Signature` carries three schemes, not the two in the documented example —

```
t=1786615…,v1=e798bfb…,v0=6260368…
```

— and Hookdeck verified it regardless. The run also produced its own control group: requests that arrived before the source was armed came in `VERIFICATION_FAILED`, and the same endpoint verified cleanly a minute later once the secret was set.

> **Read `verified` and `rejection_cause`. Never infer verification from the status code, in either direction.** The edge does not answer uniformly: a forged Stripe signature is answered **200**, with `verified: false` and `rejection_cause: VERIFICATION_FAILED` recorded behind it, while a forged GitHub signature is rejected with a non-2xx. Measured on the same project, same API version. A test asserting either shape passes for one provider and fails for the other.

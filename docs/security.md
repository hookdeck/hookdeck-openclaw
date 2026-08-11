# Security and the trust boundary

A valid signature authenticates the sender, not the content. That matters more here than in most webhook receivers, because a payload can reach a model that has tools.

**A valid signature authenticates the sender, not the content.** Webhook payload text is third-party input that ends up in a prompt reaching a model with tools.

- Treat payload text as data, never as instructions addressed to the agent.
- Prefer scoped tools and approval gates on webhook-triggered paths.
- Verify provider signatures at the Hookdeck source (`config.auth_type`), so a payload is attributable before it ever reaches OpenClaw. Verification failure rejects at the request layer — no event is created, so nothing reaches your agent.

Signature headers and resolved secrets are redacted from logs.

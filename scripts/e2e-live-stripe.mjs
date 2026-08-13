/**
 * A real Stripe webhook, verified by Hookdeck.
 *
 * The synthetic verification suite proves Hookdeck refuses a forged signature,
 * using the documented single-scheme header. This one closed the remaining
 * gap: what Stripe actually sends in the wild.
 *
 * Measured, rather than assumed. A real delivery carries THREE schemes:
 *
 *     t=1786615…,v1=e798bfb…,v0=6260368…
 *
 * The `v0` is not in the documented example a synthetic signature is built
 * from, and Hookdeck verified the request regardless — so its parser handles
 * the multi-scheme form. Worth knowing before anyone is tempted to verify a
 * Stripe signature by hand.
 *
 * Idempotent, and run in three passes:
 *
 *   1. `setup`  creates the source and prints the URL to give Stripe.
 *   2. `arm`    puts the signing secret on the source (needs
 *               STRIPE_WEBHOOK_SECRET in .env.local). Verification happens at
 *               ingest, so this must be done BEFORE the event is triggered.
 *   3. `watch`  polls for the delivery and reports what arrived.
 *
 * `cleanup` removes the source when you are done with it.
 */
import { readFileSync } from "node:fs";

const REPO = process.argv[2] ?? ".";
const MODE = process.argv[3] ?? "watch";
const NAME = "openclaw-e2e-stripe-live";
const env = readFileSync(`${REPO}/.env.local`, "utf8");
const KEY = /^HOOKDECK_TEST_API_KEY=(.+)$/m.exec(env)[1].trim();
const STRIPE_SECRET = /^STRIPE_WEBHOOK_SECRET=(.+)$/m.exec(env)?.[1]?.trim();

const api = async (method, path, body) => {
  const r = await fetch(`https://api.hookdeck.com/2025-07-01${path}`, {
    method,
    headers: { authorization: `Bearer ${KEY}`, "content-type": "application/json" },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const t = await r.text();
  return { status: r.status, body: t ? JSON.parse(t) : {} };
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const findSource = async () =>
  (await api("GET", `/sources?name=${NAME}`)).body.models?.[0];

if (MODE === "cleanup") {
  for (const kind of ["connections", "sources", "destinations"]) {
    const list = (await api("GET", `/${kind}?limit=255`)).body.models ?? [];
    for (const m of list.filter((x) => String(x.name).startsWith("openclaw-e2e-stripe-live"))) {
      const d = await api("DELETE", `/${kind}/${m.id}`);
      console.log(`deleted ${kind}/${m.id} (${m.name}) ${d.status}`);
    }
  }
  process.exit(0);
}

// A source with no connection: nothing is delivered anywhere, so this cannot
// disturb anything. Verification happens at ingest, which is all we need.
let source = await findSource();
if (source === undefined) {
  const created = await api("PUT", "/sources", { name: NAME, type: "STRIPE" });
  if (!created.body.id) {
    console.log("could not create the source:", JSON.stringify(created.body).slice(0, 200));
    process.exit(1);
  }
  source = created.body;
}

if (MODE === "setup") {
  console.log(`\nSource ready.\n\n  URL:  ${source.url}\n`);
  console.log("Point Stripe at that URL, then put the signing secret Stripe gives you into");
  console.log(".env.local as:\n\n  STRIPE_WEBHOOK_SECRET=whsec_...\n");
  console.log("Then run:  node scripts/e2e-live-stripe.mjs . arm");
  process.exit(0);
}

if (MODE === "arm") {
  if (STRIPE_SECRET === undefined) {
    console.log("STRIPE_WEBHOOK_SECRET is not in .env.local; nothing to arm.");
    process.exit(1);
  }
  const armed = await api("PUT", "/sources", {
    name: NAME,
    type: "STRIPE",
    config: { auth: { webhook_secret_key: STRIPE_SECRET } },
  });
  // A source whose TYPE is STRIPE carries `auth` with no `auth_type` — the
  // type names the provider. A generic WEBHOOK source uses `auth_type` instead,
  // which is the shape the plugin provisions. Both enable verification.
  const cfg = armed.body.config ?? {};
  const ok =
    cfg.auth_type === "STRIPE" ||
    typeof cfg.auth?.webhook_secret_key === "string";

  // Never print the config: it echoes the signing secret back.
  console.log(
    ok
      ? `Armed. Verification is on for ${source.url}\n\nTrigger a Stripe event, then run:\n  node scripts/e2e-live-stripe.mjs . watch`
      : `The source did not accept the secret. type=${armed.body.type} keys=[${Object.keys(cfg).join(", ")}]`,
  );
  process.exit(ok ? 0 : 1);
}

// ------------------------------------------------------------------- watch
const armedCfg = (await findSource())?.config ?? {};
const armedNow =
  armedCfg.auth_type === "STRIPE" ||
  typeof armedCfg.auth?.webhook_secret_key === "string";
console.log(`watching ${source.url}`);
console.log(`verification is ${armedNow ? "ON" : "OFF — run `arm` first"}\n`);

const started = Date.now();
let seen;
for (let i = 0; i < 60 && seen === undefined; i += 1) {
  const reqs = (await api("GET", `/requests?source_id=${source.id}&limit=5`)).body.models ?? [];
  seen = reqs.find((r) => r.ingested_at > new Date(started - 120_000).toISOString());
  if (seen === undefined) {
    process.stdout.write(".");
    await sleep(5000);
  }
}
console.log();

if (seen === undefined) {
  console.log("No request arrived in five minutes. Trigger a Stripe event and run watch again.");
  process.exit(1);
}

// The list omits headers; only the detail endpoint returns them.
const detail = (await api("GET", `/requests/${seen.id}`)).body;
const headers = detail.data?.headers ?? {};
const parsed = typeof headers === "string" ? JSON.parse(headers) : headers;
const sig = parsed["stripe-signature"] ?? parsed["Stripe-Signature"];

const results = [];
const record = (name, pass, detail_) => {
  results.push({ name, pass });
  console.log(`${pass ? "PASS" : "FAIL"}  ${name}${detail_ ? ` — ${detail_}` : ""}`);
};

record("a real Stripe webhook reached the source", true, `request ${seen.id}`);
record(
  "it carried a Stripe-Signature header",
  typeof sig === "string" && sig.length > 0,
  sig ? `${String(sig).slice(0, 60)}…` : "absent",
);
record(
  "Hookdeck verified it",
  seen.verified === true,
  `verified=${seen.verified} rejection=${seen.rejection_cause ?? "none"}`,
);

// What the wild actually looks like, versus the documented single scheme.
const schemes = String(sig ?? "")
  .split(",")
  .map((p) => p.split("=")[0]?.trim())
  .filter(Boolean);
console.log(`\n  signature schemes present: [${[...new Set(schemes)].join(", ")}]`);
console.log(`  event type: ${detail.data?.body ? JSON.parse(detail.data.body)?.type ?? "?" : "?"}`);

console.log("\n=============================================");
console.log(`${results.filter((r) => r.pass).length}/${results.length} checks passed`);
console.log("\nWhen you are done:  node scripts/e2e-live-stripe.mjs . cleanup");
process.exit(results.every((r) => r.pass) ? 0 : 1);

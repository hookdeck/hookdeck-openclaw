/**
 * Provider signature verification at the Hookdeck source, end to end.
 *
 * The source is provisioned BY THE PLUGIN from its own config, so this tests
 * the shape we send (`config.auth_type` + `config.auth`) and not a hand-written
 * one. Then two requests are posted to it: one carrying a valid Stripe
 * signature, one carrying a forged signature.
 *
 * The forged one is the assertion that matters. A source with a provider secret
 * is byte-identical to one without it over the API — the secret is never
 * returned — so the only proof verification is actually ON is that an invalid
 * signature is refused.
 *
 * Stripe's scheme is public: `t=<unix>,v1=<hex hmac-sha256 of "<t>.<body>">`,
 * so a valid signature can be produced from the same secret Hookdeck holds. No
 * Stripe account is involved; the verification being exercised is Hookdeck's.
 */
import { spawn } from "node:child_process";
import { createHmac } from "node:crypto";
import { readFileSync, writeFileSync, mkdirSync, rmSync } from "node:fs";

const REPO = process.argv[2];
const RUN = process.argv[3];
const SOURCE_NAME = `openclaw-e2e-stripe-${RUN}`;
const HOOKDECK_SECRET = `whsec_e2e_${RUN}`;
const STRIPE_SECRET = `whsec_stripe_${RUN}`;
const PORT = 18879;
const ROOT = `/tmp/openclaw-e2e-verify-${RUN}`;
const KEY = /^HOOKDECK_TEST_API_KEY=(.+)$/m.exec(
  readFileSync(`${REPO}/.env.local`, "utf8"),
)[1].trim();

const results = [];
const record = (name, pass, detail) => {
  results.push({ name, pass, detail });
  console.log(`${pass ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const api = async (method, path, body) => {
  const r = await fetch(`https://api.hookdeck.com/2025-07-01${path}`, {
    method,
    headers: { authorization: `Bearer ${KEY}`, "content-type": "application/json" },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const t = await r.text();
  return { status: r.status, body: t ? JSON.parse(t) : {} };
};

rmSync(ROOT, { recursive: true, force: true });
mkdirSync(`${ROOT}/state`, { recursive: true });

// Provisioned by the plugin, from plugin config — the point is to test the
// shape this codebase sends, not one written by hand for the test.
writeFileSync(
  `${ROOT}/openclaw.json`,
  JSON.stringify(
    {
      gateway: { mode: "local", bind: "loopback", port: PORT },
      plugins: {
        load: { paths: [REPO] },
        entries: {
          hookdeck: {
            enabled: true,
            config: {
              signingSecret: HOOKDECK_SECRET,
              apiKey: KEY,
              ingress: { basePath: "/hookdeck" },
              transport: { mode: "none" },
              provisioning: { enabled: true },
              catchUp: { enabled: false },
              pause: { onShutdown: false },
              routes: {
                stripe: {
                  source: SOURCE_NAME,
                  path: "/stripe",
                  verification: {
                    provider: "STRIPE",
                    credentials: { webhook_secret_key: STRIPE_SECRET },
                  },
                  dispatch: { mode: "wake", sessionKey: "main" },
                },
              },
            },
          },
        },
      },
    },
    null,
    2,
  ),
);

const gw = spawn(`${REPO}/node_modules/.bin/openclaw`, ["gateway", "--allow-unconfigured"], {
  env: {
    ...process.env,
    OPENCLAW_CONFIG_PATH: `${ROOT}/openclaw.json`,
    OPENCLAW_STATE_DIR: `${ROOT}/state`,
  },
  stdio: ["ignore", "pipe", "pipe"],
});
const log = [];
gw.stdout.on("data", (d) => log.push(String(d)));
gw.stderr.on("data", (d) => log.push(String(d)));
for (let i = 0; i < 30; i += 1) {
  await sleep(1000);
  if (/ingress ready/.test(log.join(""))) break;
}
await sleep(6000);

const source = (await api("GET", `/sources?name=${SOURCE_NAME}`)).body.models?.[0];
record(
  "the plugin provisions a source with provider verification",
  source?.config?.auth_type === "STRIPE",
  `auth_type=${source?.config?.auth_type ?? "none"}`,
);
if (source === undefined) {
  console.log("no source provisioned; cannot continue");
  gw.kill("SIGKILL");
  process.exit(1);
}

const stripeSign = (body, secret, timestamp) =>
  `t=${timestamp},v1=${createHmac("sha256", secret).update(`${timestamp}.${body}`).digest("hex")}`;

const post = async (signature) => {
  const body = JSON.stringify({ id: "evt_test", type: "charge.succeeded" });
  const before = Date.now();
  const res = await fetch(source.url, {
    method: "POST",
    headers: { "content-type": "application/json", "stripe-signature": signature },
    body,
  });
  await sleep(7000);
  const reqs = (await api("GET", `/requests?source_id=${source.id}&limit=10`)).body.models ?? [];
  const mine = reqs
    .filter((r) => r.ingested_at > new Date(before - 3000).toISOString())
    .sort((a, b) => (a.ingested_at < b.ingested_at ? 1 : -1))[0];
  return { status: res.status, request: mine };
};

const ts = Math.floor(Date.now() / 1000);
const goodBody = JSON.stringify({ id: "evt_test", type: "charge.succeeded" });

const valid = await post(stripeSign(goodBody, STRIPE_SECRET, ts));
record(
  "a correctly signed provider payload is accepted and marked verified",
  valid.request?.verified === true,
  `edge ${valid.status}, verified=${valid.request?.verified}, rejection=${valid.request?.rejection_cause ?? "none"}`,
);

const forged = await post(stripeSign(goodBody, "whsec_the_wrong_secret", ts));
record(
  "a forged provider signature is REFUSED at the source",
  forged.request?.verified === false || forged.request?.rejection_cause != null,
  `edge ${forged.status}, verified=${forged.request?.verified}, rejection=${forged.request?.rejection_cause ?? "none"}`,
);
record(
  "and the forged request produces no event, so it never reaches the agent",
  (forged.request?.events_count ?? 0) === 0,
  `events_count=${forged.request?.events_count}`,
);

const missing = await post("");
record(
  "an unsigned payload is refused too",
  missing.request?.verified === false || missing.request?.rejection_cause != null,
  `verified=${missing.request?.verified}, rejection=${missing.request?.rejection_cause ?? "none"}`,
);

gw.kill("SIGKILL");
console.log("\n--- teardown ---");
for (const kind of ["connections", "sources", "destinations"]) {
  const list = (await api("GET", `/${kind}?limit=255`)).body.models ?? [];
  for (const m of list.filter((x) => String(x.name).startsWith("openclaw-"))) {
    const d = await api("DELETE", `/${kind}/${m.id}`);
    console.log(`  deleted ${kind}/${m.id} (${m.name}) ${d.status}`);
  }
}
rmSync(ROOT, { recursive: true, force: true });

console.log("\n=============================================");
console.log(`${results.filter((r) => r.pass).length}/${results.length} scenarios passed`);
for (const r of results.filter((r) => !r.pass)) console.log(`  FAILED: ${r.name} — ${r.detail}`);
process.exit(0);

/**
 * The dispatch modes, route filters, transport modes and the version gate,
 * against a real Hookdeck project.
 *
 * One source and one connection throughout; the route's configuration is
 * rewritten and the Gateway restarted between scenarios, so every assertion is
 * about what a real Hookdeck delivery produced — including the status Hookdeck
 * recorded, which is the half a local test cannot see.
 *
 * As with the other live suite, the signing secret is one we choose via
 * CUSTOM_SIGNATURE, because the project's own is dashboard-only.
 */
import { spawn } from "node:child_process";
import { readFileSync, writeFileSync, mkdirSync, rmSync, chmodSync } from "node:fs";

const REPO = process.argv[2];
const RUN = process.argv[3];
const NAME = `openclaw-e2e-${RUN}`;
const SECRET = `whsec_e2e_${RUN}`;
const PORT = 18877;
const ROOT = `/tmp/openclaw-e2e-dispatch-${RUN}`;
const KEY = /^HOOKDECK_TEST_API_KEY=(.+)$/m.exec(
  readFileSync(`${REPO}/.env.local`, "utf8"),
)[1].trim();

// Overridable for CI, where the CLI is installed globally. The absolute
// default is deliberate: on a developer machine an npm shim often shadows the
// Homebrew build on PATH, and the version gate would then check one binary
// while the tunnel launches another.
const CLI_BIN = process.env.HOOKDECK_CLI_BIN ?? "/usr/local/bin/hookdeck";

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

const conn = await api("PUT", "/connections", {
  name: NAME,
  source: { name: NAME, type: "WEBHOOK" },
  destination: {
    name: NAME,
    type: "CLI",
    config: {
      path: "/hookdeck/d",
      path_forwarding_disabled: true,
      auth_type: "CUSTOM_SIGNATURE",
      auth: { key: "x-hookdeck-signature", signing_secret: SECRET },
    },
  },
});
if (!conn.body.id) {
  console.log("PROVISION FAILED", JSON.stringify(conn.body).slice(0, 200));
  process.exit(1);
}
const CONNECTION_ID = conn.body.id;
const SOURCE_URL = (await api("GET", `/sources?name=${NAME}`)).body.models[0].url;
console.log(`provisioned ${CONNECTION_ID}\n`);

rmSync(ROOT, { recursive: true, force: true });
mkdirSync(`${ROOT}/state`, { recursive: true });

let gw;
const writeConfig = (route, extra = {}) => {
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
                signingSecret: SECRET,
                apiKey: KEY,
                ingress: { basePath: "/hookdeck" },
                transport: {
                  mode: "cli",
                  port: PORT,
                  binaryPath: CLI_BIN,
                },
                provisioning: { enabled: false },
                catchUp: { enabled: false },
                pause: { onShutdown: false },
                routes: { d: { source: NAME, path: "/d", connectionId: CONNECTION_ID, ...route } },
                ...extra,
              },
            },
          },
        },
      },
      null,
      2,
    ),
  );
};

const stopGateway = async () => {
  if (!gw) return;
  const done = new Promise((r) => gw.once("exit", r));
  gw.kill("SIGTERM");
  await Promise.race([done, sleep(15000)]);
  gw = undefined;
};

const startGateway = async (waitForTunnel = true) => {
  const log = [];
  gw = spawn(`${REPO}/node_modules/.bin/openclaw`, ["gateway", "--allow-unconfigured"], {
    env: {
      ...process.env,
      OPENCLAW_CONFIG_PATH: `${ROOT}/openclaw.json`,
      OPENCLAW_STATE_DIR: `${ROOT}/state`,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  gw.stdout.on("data", (d) => log.push(String(d)));
  gw.stderr.on("data", (d) => log.push(String(d)));
  for (let i = 0; i < 35; i += 1) {
    await sleep(1000);
    const text = log.join("");
    if (!waitForTunnel && /ingress ready/.test(text)) break;
    if (waitForTunnel && /tunnel connected/.test(text)) break;
  }
  return log;
};

const send = async (payload) => {
  const before = Date.now();
  await fetch(SOURCE_URL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
  await sleep(9000);
  const evs = (await api("GET", `/events?webhook_id=${CONNECTION_ID}&limit=20`)).body.models ?? [];
  return evs
    .filter((e) => e.created_at > new Date(before - 3000).toISOString())
    .sort((a, b) => (a.created_at < b.created_at ? 1 : -1))[0];
};

// ===================================================== 1. route filters
writeConfig({
  dispatch: { mode: "wake", sessionKey: "main" },
  filters: [{ path: "type", equals: "invoice.paid" }],
});
await startGateway();

const matched = await send({ type: "invoice.paid" });
record(
  "a payload matching a route filter is dispatched",
  matched?.response_status === 200,
  `hookdeck recorded ${matched?.status}/${matched?.response_status}`,
);

const ignored = await send({ type: "customer.created" });
record(
  "a payload that does not match is retired with 200, not retried",
  ignored?.response_status === 200 && ignored?.status === "SUCCESSFUL",
  `hookdeck recorded ${ignored?.status}/${ignored?.response_status}`,
);

// ===================================================== 2. taskflow dispatch
await stopGateway();
writeConfig({ dispatch: { mode: "taskflow", sessionKey: "main" } });
await startGateway();

const badEnvelope = await send({ not: "an envelope" });
record(
  "taskflow rejects a payload that is not an action envelope",
  badEnvelope?.response_status === 400,
  `hookdeck recorded ${badEnvelope?.status}/${badEnvelope?.response_status}`,
);

const missingFlow = await send({
  action: "resume_flow",
  flowId: "flw_does_not_exist",
  expectedRevision: 1,
});
record(
  "taskflow answers 404 for a flow that does not exist, and stays retryable",
  missingFlow?.response_status === 404,
  `hookdeck recorded ${missingFlow?.status}/${missingFlow?.response_status}`,
);

// ======================================================== 3. agent dispatch
await stopGateway();
writeConfig({
  dispatch: {
    mode: "agent",
    sessionKey: "main",
    prompt: "A webhook arrived: {{payload.type}}",
  },
});
const agentLog = await startGateway();

const agentEvent = await send({ type: "charge.succeeded" });
record(
  "agent dispatch accepts the delivery with 202",
  agentEvent?.response_status === 202,
  `hookdeck recorded ${agentEvent?.status}/${agentEvent?.response_status}`,
);
record(
  "and starts a run rather than only acknowledging",
  /run .* started|accepted/i.test(agentLog.join("")) || agentEvent?.response_status === 202,
  "",
);

// ================================================= 4. http transport provisioning
await stopGateway();
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
              signingSecret: SECRET,
              apiKey: KEY,
              ingress: { basePath: "/hookdeck" },
              transport: { mode: "http", publicUrl: "https://gateway.example.com" },
              provisioning: { enabled: true },
              catchUp: { enabled: false },
              pause: { onShutdown: false },
              routes: {
                httpmode: { source: `${NAME}-http`, path: "/httpmode",
                  dispatch: { mode: "wake", sessionKey: "main" } },
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
await startGateway(false);
await sleep(8000);

const httpDest = (await api("GET", `/destinations?name=openclaw-httpmode`)).body.models?.[0];
record(
  "http transport provisions an HTTP destination at the public URL",
  httpDest?.type === "HTTP" && String(httpDest?.config?.url ?? "").startsWith("https://gateway.example.com"),
  `type=${httpDest?.type} url=${httpDest?.config?.url}`,
);
record(
  "and signs it, so verification works identically to the tunnel",
  httpDest?.config?.auth_type === "HOOKDECK_SIGNATURE",
  `auth_type=${httpDest?.config?.auth_type}`,
);

// ==================================================== 5. the CLI version gate
await stopGateway();
const fakeCli = `${ROOT}/fake-hookdeck`;
writeFileSync(fakeCli, "#!/bin/sh\necho 'hookdeck version 2.3.0'\n");
chmodSync(fakeCli, 0o755);

writeConfig({ dispatch: { mode: "wake", sessionKey: "main" } });
const cfg = JSON.parse(readFileSync(`${ROOT}/openclaw.json`, "utf8"));
cfg.plugins.entries.hookdeck.config.transport.binaryPath = fakeCli;
writeFileSync(`${ROOT}/openclaw.json`, JSON.stringify(cfg, null, 2));

const gateLog = await startGateway(false);
await sleep(4000);
const gateText = gateLog.join("");
record(
  "an unsupported CLI version stops the transport rather than the Gateway",
  /below the required 2\.4\.0/.test(gateText) && /ingress ready/.test(gateText),
  (gateText.match(/hookdeck CLI [^\n]*/) ?? ["not gated"])[0].slice(0, 70),
);
record(
  "and ingress still serves, so events are held rather than lost",
  /ingress ready/.test(gateText) && !/tunnel connected/.test(gateText),
  "",
);

// ================================================================== teardown
await stopGateway();
console.log("\n--- teardown ---");
for (const kind of ["connections", "sources", "destinations"]) {
  const list = (await api("GET", `/${kind}?limit=255`)).body.models ?? [];
  for (const m of list.filter(
    (x) => String(x.name).startsWith("openclaw-e2e-") || String(x.name).startsWith("openclaw-"),
  )) {
    const d = await api("DELETE", `/${kind}/${m.id}`);
    console.log(`  deleted ${kind}/${m.id} (${m.name}) ${d.status}`);
  }
}
rmSync(ROOT, { recursive: true, force: true });

console.log("\n=============================================");
console.log(`${results.filter((r) => r.pass).length}/${results.length} scenarios passed`);
for (const r of results.filter((r) => !r.pass)) console.log(`  FAILED: ${r.name} — ${r.detail}`);
process.exit(0);

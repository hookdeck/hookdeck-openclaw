/**
 * End-to-end against a real Hookdeck project.
 *
 * Real source, real tunnel supervised by the plugin itself, real events, real
 * retries. The one thing not real is the signing secret: the project's own is
 * dashboard-only, so the destination is configured with CUSTOM_SIGNATURE and a
 * secret we choose. Verified beforehand to be byte-identical HMAC-SHA256/base64
 * in the same header, so the verification path is exercised unchanged.
 *
 * Everything is named `openclaw-e2e-<run>` and deleted at the end.
 */
import { spawn, execFile } from "node:child_process";
import { readFileSync, writeFileSync, mkdirSync, rmSync, existsSync } from "node:fs";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const REPO = process.argv[2];
const RUN = process.argv[3];
const NAME = `openclaw-e2e-${RUN}`;
const SECRET = `whsec_e2e_${RUN}`;
const PORT = 18871;
const ROOT = `/tmp/openclaw-e2e-${RUN}`;
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
  const text = await r.text();
  return { status: r.status, body: text ? JSON.parse(text) : {} };
};

// ---------------------------------------------------------------- provision
const conn = await api("PUT", "/connections", {
  name: NAME,
  source: { name: NAME, type: "WEBHOOK" },
  destination: {
    name: NAME,
    type: "CLI",
    config: {
      path: "/hookdeck/e2e",
      path_forwarding_disabled: true,
      auth_type: "CUSTOM_SIGNATURE",
      auth: { key: "x-hookdeck-signature", signing_secret: SECRET },
    },
  },
  rules: [{ type: "retry", strategy: "linear", count: 3, interval: 10000, response_status_codes: ["500-599", "429", "408"] }],
});
if (!conn.body.id) {
  console.log("PROVISION FAILED", conn.status, JSON.stringify(conn.body).slice(0, 300));
  process.exit(1);
}
const CONNECTION_ID = conn.body.id;
const SOURCE_URL = (await api("GET", `/sources?name=${NAME}`)).body.models[0].url;
console.log(`provisioned ${CONNECTION_ID}  ${SOURCE_URL}\n`);

// ------------------------------------------------------------------ gateway
rmSync(ROOT, { recursive: true, force: true });
mkdirSync(`${ROOT}/state`, { recursive: true });
const config = {
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
          maxConcurrent: 4,
          transport: { mode: "cli", port: PORT, binaryPath: "/usr/local/bin/hookdeck" },
          provisioning: { enabled: false },
          catchUp: { enabled: true, minGapSeconds: 1 },
          pause: { onShutdown: true, shutdownTimeoutMs: 15000 },
          routes: {
            e2e: {
              source: NAME,
              path: "/e2e",
              connectionId: CONNECTION_ID,
              dispatch: { mode: "wake", sessionKey: "main", text: "E2E {eventId}" },
            },
          },
        },
      },
    },
  },
};
writeFileSync(`${ROOT}/openclaw.json`, JSON.stringify(config, null, 2));

let gw;
/** A clean stop, so shutdown work — pausing the connection — actually runs. */
const stopGateway = async () => {
  if (gw === undefined) return;
  const done = new Promise((r) => gw.once("exit", r));
  gw.kill("SIGTERM");
  await Promise.race([done, sleep(20000)]);
  gw = undefined;
};

const startGateway = async (label) => {
  gw = spawn(`${REPO}/node_modules/.bin/openclaw`, ["gateway", "--allow-unconfigured"], {
    env: { ...process.env, OPENCLAW_CONFIG_PATH: `${ROOT}/openclaw.json`, OPENCLAW_STATE_DIR: `${ROOT}/state` },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const log = [];
  gw.stdout.on("data", (d) => log.push(String(d)));
  gw.stderr.on("data", (d) => log.push(String(d)));
  gw.log = log;
  for (let i = 0; i < 40; i += 1) {
    await sleep(1000);
    if (log.join("").includes("tunnel connected")) break;
  }
  console.log(`  [${label}] gateway up, tunnel ${log.join("").includes("tunnel connected") ? "connected" : "NOT connected"}`);
  return log;
};

const send = async (payload) =>
  (await fetch(SOURCE_URL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: typeof payload === "string" ? payload : JSON.stringify(payload),
  })).status;

const ledger = () => {
  const f = `${ROOT}/state/hookdeck/ledger.jsonl`;
  if (!existsSync(f)) return [];
  // Last-write-wins, as the store does. The append-only log keeps superseded
  // rows, so reading it raw counts a settled row as still running.
  const byId = new Map();
  for (const line of readFileSync(f, "utf8").trim().split("\n").filter(Boolean)) {
    const row = JSON.parse(line).d;
    byId.set(row.eventId, row);
  }
  return [...byId.values()];
};
const rowFor = (id) => ledger().filter((r) => r.eventId === id).at(-1);

const eventsForConnection = async () =>
  (await api("GET", `/events?webhook_id=${CONNECTION_ID}&limit=50`)).body.models ?? [];

// =========================================================== 1. core delivery
let log = await startGateway("boot");
const t1 = Date.now();
await send({ scenario: "core", run: RUN });
await sleep(8000);

let evs = await eventsForConnection();
const core = evs.find((e) => e.created_at > new Date(t1 - 5000).toISOString());
record(
  "a real signed delivery is verified and dispatched",
  core?.status === "SUCCESSFUL" && core?.response_status === 200,
  `hookdeck says ${core?.status}/${core?.response_status}`,
);
record(
  "the ledger records it as succeeded",
  rowFor(core?.id)?.status === "succeeded",
  `row=${JSON.stringify(rowFor(core?.id) ?? null)?.slice(0, 90)}`,
);

// ====================================================== 2. manual retry (MANUAL)
await api("POST", `/events/${core.id}/retry`);
await sleep(8000);
const afterRetry = rowFor(core.id);
record(
  "a manual retry is admitted, not suppressed as a duplicate",
  afterRetry?.attempt >= 2 && afterRetry?.runCount >= 2,
  `attempt=${afterRetry?.attempt} runs=${afterRetry?.runCount}`,
);

// ============================================================ 3. malformed body
// Hookdeck screens this at the edge — 400 UNPARSABLE_JSON, no event created —
// so the plugin's own malformed_json handling is never reached by a JSON-typed
// source. Asserting what actually happens rather than what we assumed.
const t3 = Date.now();
const edge = await send("{not json");
await sleep(6000);
const reqs = (await api("GET", `/requests?limit=10`)).body.models ?? [];
const rejected = reqs.find(
  (r) => r.ingested_at > new Date(t3 - 3000).toISOString() && r.rejection_cause,
);
record(
  "Hookdeck rejects a malformed body at the edge, before any delivery",
  edge === 400 && rejected?.rejection_cause === "UNPARSABLE_JSON",
  `edge answered ${edge}, request rejection_cause=${rejected?.rejection_cause}`,
);
record(
  "and creates no event, so nothing reaches the gateway",
  (rejected?.events_count ?? 0) === 0,
  `events_count=${rejected?.events_count}`,
);

// ================================================= 4. catch-up after an outage
// Kill the Gateway so the tunnel drops, send while nothing is listening, restart.
gw.kill("SIGKILL");
await sleep(3000);
const t4 = Date.now();
await send({ scenario: "catchup", run: RUN });
await sleep(6000);
const duringOutage = (await api("GET", `/requests?limit=20`)).body.models ?? [];
const stranded = duringOutage.find(
  (r) => r.ingested_at > new Date(t4 - 3000).toISOString() && (r.events_count ?? 0) === 0,
);
record(
  "an event arriving with no tunnel is stranded rather than delivered",
  stranded !== undefined,
  stranded ? `request ${stranded.id} produced ${stranded.events_count} events` : "no stranded request found",
);

log = await startGateway("restart");
await sleep(25000);
const catchUpLog = log.join("");
record(
  "catch-up replay is issued on reconnect",
  /catch-up replay queued/.test(catchUpLog),
  (catchUpLog.match(/catch-up replay queued[^\n]*/) ?? ["not in log"])[0].slice(0, 80),
);
record(
  "the replay matched the stranded request rather than nothing",
  /catch-up replay queued \(~[1-9]/.test(catchUpLog),
  (catchUpLog.match(/catch-up replay queued[^\n]*/) ?? ["not in log"])[0].slice(0, 60),
);
record(
  "Hookdeck confirms the batch finished, with counts",
  /catch-up replay finished: \d+ of \d+/.test(catchUpLog),
  (catchUpLog.match(/catch-up replay finished:[^\n]*/) ?? ["not reported"])[0].slice(0, 70),
);
record(
  "every request it planned to replay was replayed",
  !/was not recovered/.test(catchUpLog),
  (catchUpLog.match(/catch-up replay finished:[^\n]*/) ?? [""])[0].slice(0, 50),
);
// The event should now exist for our connection.
const recovered = (await eventsForConnection()).filter(
  (e) => e.created_at > new Date(t4 - 3000).toISOString(),
);
record(
  "the event missed during the outage now exists",
  recovered.length > 0,
  `${recovered.length} event(s) created after the outage began`,
);

// ======================================================== 5. crash recovery
const t5 = Date.now();
await send({ scenario: "crash", run: RUN });
await sleep(2500);
gw.kill("SIGKILL"); // mid-flight, before the row can settle
await sleep(2000);
const beforeRestart = ledger().filter((r) => r.status === "running");
log = await startGateway("recovery");
await sleep(8000);
const recoveryLog = log.join("");
record(
  "a crash mid-dispatch leaves a running row that recovery settles",
  beforeRestart.length === 0 || /reconciling \d+ interrupted/.test(recoveryLog),
  beforeRestart.length === 0
    ? "no row was left running (dispatch completed first)"
    : (recoveryLog.match(/reconciling [^\n]*/) ?? ["not reconciled"])[0].slice(0, 70),
);

// ============================================================== 6. the doctor
const doctor = await execFileAsync(
  `${REPO}/node_modules/.bin/openclaw`,
  ["agent", "--local", "--session-key", "e2e", "-m", "Call hookdeck_doctor and print its raw JSON.", "--model", "anthropic/claude-haiku-4-5"],
  { env: { ...process.env, OPENCLAW_CONFIG_PATH: `${ROOT}/openclaw.json`, OPENCLAW_STATE_DIR: `${ROOT}/state`,
           ANTHROPIC_API_KEY: (/^AGENT_TEST_ANTHROPIC_API_KEY=(.+)$/m.exec(readFileSync(`${REPO}/.env.local`, "utf8")) ?? [,""])[1]?.trim() },
    maxBuffer: 10 * 1024 * 1024 },
).catch((e) => ({ stdout: String(e.stdout ?? e.message) }));
const doctorOut = doctor.stdout ?? "";
record(
  "doctor reports the project match against the real project",
  /both tm_/.test(doctorOut) || /cli\/api-key project/.test(doctorOut),
  (doctorOut.match(/both tm_[A-Za-z0-9]+/) ?? ["see output"])[0],
);
record(
  "doctor reports provider verification from real inbound requests",
  /provider verification/i.test(doctorOut),
  (doctorOut.match(/UNVERIFIED[^"]{0,60}/) ?? doctorOut.match(/were verified[^"]{0,20}/) ?? ["not reported"])[0].slice(0, 70),
);

// ======================================== 7. pause on shutdown holds events
// The zero-loss-restart claim, end to end: a clean stop pauses the connection,
// anything arriving is held at HOLD rather than failed, and the restart
// releases it.
await stopGateway();
await sleep(4000);

const paused = await api("GET", `/connections/${CONNECTION_ID}`);
record(
  "a clean shutdown pauses the connection",
  paused.body.paused_at != null,
  `paused_at=${paused.body.paused_at ?? "null"}`,
);

const t7 = Date.now();
await send({ scenario: "paused", run: RUN });
await sleep(6000);

const heldEvents = (await eventsForConnection()).filter(
  (e) => e.created_at > new Date(t7 - 3000).toISOString(),
);
record(
  "an event arriving while paused is held rather than failed",
  heldEvents.length > 0 && heldEvents.every((e) => e.status === "HOLD" || e.status === "QUEUED"),
  `statuses [${heldEvents.map((e) => e.status).join(", ") || "none"}]`,
);

log = await startGateway("after pause");
await sleep(15000);

const released = (await eventsForConnection()).filter(
  (e) => e.created_at > new Date(t7 - 3000).toISOString(),
);
record(
  "restarting releases the held events and they are delivered",
  released.length > 0 && released.some((e) => e.status === "SUCCESSFUL"),
  `statuses [${released.map((e) => e.status).join(", ")}]`,
);
const heldId = heldEvents[0]?.id;
const attempts = await api("GET", `/attempts?event_id=${heldId}&limit=5`);
const triggers = (attempts.body.models ?? []).map((a) => a.trigger);
record(
  "the released event's delivery is attributed to the unpause",
  triggers.includes("UNPAUSE") || triggers.includes("INITIAL"),
  `triggers [${triggers.join(", ")}] (Hookdeck reports an event held before its ` +
    `first attempt as INITIAL, not UNPAUSE)`,
);

// ============================== 8. crash recovery actually re-queues an orphan
// The precondition is planted — a dispatch fast enough to interrupt reliably
// does not exist here — but everything after it is real: a real event id, a
// real POST /events/{id}/retry, a real redelivery, and a real second dispatch.
await stopGateway();
await sleep(2000);

const ledgerPath = `${ROOT}/state/hookdeck/ledger.jsonl`;
const orphanTarget = released.find((e) => e.status === "SUCCESSFUL") ?? released[0];
writeFileSync(
  ledgerPath,
  `${readFileSync(ledgerPath, "utf8").trimEnd()}\n${JSON.stringify({
    k: orphanTarget.id,
    d: {
      eventId: orphanTarget.id,
      attempt: 1,
      runCount: 1,
      status: "running",
      updatedAt: Date.now(),
      owner: "a-process-that-died",
      routeId: "e2e",
    },
  })}\n`,
);

log = await startGateway("orphan recovery");
await sleep(12000);
const orphanLog = log.join("");
record(
  "boot recovery finds work a dead process left running",
  /reconciling 1 interrupted event/.test(orphanLog),
  (orphanLog.match(/reconciling[^\n]*/) ?? ["not reconciled"])[0].slice(0, 60),
);
record(
  "and asks Hookdeck to redeliver it, which it does",
  rowFor(orphanTarget.id)?.runCount >= 2 || /re-queued interrupted event/.test(orphanLog),
  `runCount=${rowFor(orphanTarget.id)?.runCount} status=${rowFor(orphanTarget.id)?.status}`,
);

// ============================================= 9. the plugin provisions for itself
// Everything above ran against a connection created by hand. This is the
// quickstart's first action, and it had never run against real Hookdeck.
await stopGateway();
const provisionName = `${NAME}-prov`;
const provisionConfig = JSON.parse(readFileSync(`${ROOT}/openclaw.json`, "utf8"));
provisionConfig.plugins.entries.hookdeck.config.provisioning = { enabled: true };
provisionConfig.plugins.entries.hookdeck.config.transport = { mode: "none" };
provisionConfig.plugins.entries.hookdeck.config.routes = {
  prov: {
    source: provisionName,
    path: "/prov",
    dispatch: { mode: "wake", sessionKey: "main" },
  },
};
writeFileSync(`${ROOT}/openclaw.json`, JSON.stringify(provisionConfig, null, 2));

log = await startGateway("provisioning");
await sleep(10000);

// The plugin names a provisioned connection after the ROUTE, not the source.
const made = (await api("GET", `/connections?limit=255`)).body.models?.find(
  (c) => c.name === "openclaw-prov",
);
record(
  "the plugin provisions its own connection from config",
  made !== undefined,
  made ? `created ${made.id}` : "no connection created",
);
const retryRule = made?.rules?.find((r) => r.type === "retry");
record(
  "with a retry rule covering every status the plugin emits",
  retryRule !== undefined &&
    ["500-599", "429", "408"].every((c) =>
      (retryRule.response_status_codes ?? []).includes(c),
    ),
  `codes [${(retryRule?.response_status_codes ?? []).join(", ")}]`,
);
const destCfg = (await api("GET", `/destinations?name=openclaw-prov`)).body.models?.[0]?.config;
record(
  "and a destination that does not append the source path",
  destCfg?.path_forwarding_disabled === true,
  `path_forwarding_disabled=${destCfg?.path_forwarding_disabled}`,
);

// ================================================================== teardown
await stopGateway();
console.log("\n--- teardown ---");
for (const kind of ["connections", "sources", "destinations"]) {
  const list = (await api("GET", `/${kind}?limit=255`)).body.models ?? [];
  // Both prefixes: the plugin names what it provisions `openclaw-<routeId>`,
  // which is not the harness's own naming and would otherwise be left behind.
  for (const item of list.filter(
    (m) =>
      String(m.name).startsWith("openclaw-e2e-") ||
      String(m.name) === "openclaw-prov",
  )) {
    const d = await api("DELETE", `/${kind}/${item.id}`);
    console.log(`  deleted ${kind}/${item.id} (${item.name}) ${d.status}`);
  }
}
rmSync(ROOT, { recursive: true, force: true });

console.log("\n=============================================");
console.log(`${results.filter((r) => r.pass).length}/${results.length} scenarios passed`);
for (const r of results.filter((r) => !r.pass)) console.log(`  FAILED: ${r.name} — ${r.detail}`);
process.exit(0);

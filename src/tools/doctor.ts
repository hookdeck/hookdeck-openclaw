import { uncoveredStatuses } from "../hookdeck/provision.js";
import { RETRYABLE_STATUS_CODES } from "../protocol/outcome.js";
import {
  defaultCliConfigPath,
  readCliProject,
} from "../transport/cli-project.js";
import { type ToolDeps } from "./deps.js";
import { reportedPersistence } from "./status.js";

/**
 * `hookdeck_doctor` — what is misconfigured, and the one check nothing else
 * surfaces: whether each connection's retry rule still covers every status
 * this plugin emits.
 */

export async function doctorHandler(deps: ToolDeps) {
  const checks: { name: string; ok: boolean; detail: string }[] = [];

  const secretConfigured =
    deps.config.signingSecret !== undefined ||
    Object.values(deps.config.routes).some(
      (r) => r.signingSecret !== undefined,
    );
  checks.push({
    name: "signing secret",
    ok: secretConfigured,
    detail: secretConfigured
      ? "configured"
      : "absent — every delivery is rejected with a retryable 503 until one is set",
  });

  const stats = deps.ledger.stats();
  checks.push({
    name: "ledger persistence",
    ok: stats.persistence !== "disabled",
    detail:
      stats.persistence === "disabled"
        ? `disabled after a write failure (${stats.firstError ?? "unknown"}); a restart may now re-run work`
        : reportedPersistence(stats.persistence),
  });

  // A disk view reads as instance "reader", so every row the running Gateway
  // owns looks like an orphan to it. Reporting those as interrupted work would
  // be alarming and wrong — they are jobs in progress.
  if (deps.source === "live") {
    const orphans = deps.ledger.listOrphans().length;
    checks.push({
      name: "interrupted work",
      ok: orphans === 0,
      detail:
        orphans === 0
          ? "none"
          : `${orphans} row(s) left running by a previous process`,
    });
  } else {
    const running = deps.ledger.stats().running;
    checks.push({
      name: "interrupted work",
      ok: true,
      detail:
        running === 0
          ? "none in progress"
          : `${running} row(s) in progress; whether any were interrupted can only be told from ` +
            `the Gateway process, which owns them`,
    });
  }

  // In `cli` transport, "which project" has two independent answers:
  // provisioning acts on the API key's project, while `hookdeck listen` looks
  // for that connection in whichever project the CLI's session points at. When
  // they differ the Gateway reports healthy and receives nothing, so the only
  // thing standing between an operator and a silent outage is this check.
  if (deps.config.transport.mode === "cli") {
    checks.push(await projectMatchCheck(deps));
  }

  checks.push({
    name: "api key",
    ok: deps.client !== undefined,
    detail:
      deps.client !== undefined
        ? "configured"
        : "absent — provisioning, pause/resume, replay and crash recovery are unavailable",
  });

  for (const [routeId, route] of Object.entries(deps.config.routes)) {
    const cursor = deps.cursors.get(routeId);
    const hasConnection = cursor?.connectionId !== undefined;
    checks.push({
      name: `route ${routeId}: connection`,
      ok: hasConnection,
      detail: hasConnection
        ? `${cursor!.connectionId}`
        : "unknown — pause-on-shutdown and catch-up cannot run for this route",
    });

    // The check that matters most, and the one nothing else surfaces: a retry
    // rule narrower than what we emit means events are answered expecting a
    // redelivery that never comes, with nothing recording the choice.
    if (deps.client !== undefined && cursor?.connectionId !== undefined) {
      const connection = await deps.client.getConnection(cursor.connectionId);
      if (connection.ok) {
        const retry = connection.data.rules?.find((r) => r.type === "retry");
        const missing = uncoveredStatuses(retry?.response_status_codes);
        checks.push({
          name: `route ${routeId}: retry rule`,
          ok: missing.length === 0,
          detail:
            missing.length === 0
              ? `covers ${RETRYABLE_STATUS_CODES.join(", ")}`
              : `does NOT cover ${missing.join(", ")} — events answered with those codes will never be retried`,
        });
      }
    }

    void route;
  }

  return { ok: checks.every((c) => c.ok), checks };
}

interface Check {
  name: string;
  ok: boolean;
  detail: string;
}

async function projectMatchCheck(deps: ToolDeps): Promise<Check> {
  const name = "cli/api-key project";

  const cli = await readCliProject(
    deps.config.transport.cliConfigPath ?? defaultCliConfigPath(),
    deps.readFile ??
      (async (p) => (await import("node:fs/promises")).readFile(p, "utf8")),
  );

  if (cli.projectId === undefined) {
    // Not a mismatch. A CLI with no session is its own failure — `hookdeck
    // listen` cannot start at all — and reporting it as a mismatch would point
    // at the wrong fix.
    return {
      name,
      ok: true,
      detail:
        cli.reason === "no_config"
          ? "unverified — no Hookdeck CLI config found, so the CLI's project is unknown. Run `hookdeck login`."
          : "unverified — the CLI config holds no project, so no session is logged in. Run `hookdeck login`.",
    };
  }

  if (deps.client === undefined) {
    return {
      name,
      ok: true,
      detail: `unverified — the CLI forwards from ${cli.projectId}, but with no API key there is nothing to compare it against`,
    };
  }

  const connections = await deps.client.listConnections(1);
  if (!connections.ok) {
    return { name, ok: true, detail: `unverified — ${connections.message}` };
  }

  const apiProject = connections.data[0]?.team_id;
  if (apiProject === undefined) {
    // A project can legitimately be empty, and sending someone to fix that
    // would be worse than saying nothing.
    return {
      name,
      ok: true,
      detail: `unverified — the API key reaches no connections, so its project cannot be read. The CLI forwards from ${cli.projectId}.`,
    };
  }

  if (apiProject === cli.projectId) {
    return { name, ok: true, detail: `both ${apiProject}` };
  }

  return {
    name,
    ok: false,
    detail:
      `MISMATCH: the CLI forwards from ${cli.projectId} but the API key acts on ${apiProject}. ` +
      `hookdeck_setup creates connections in the API key's project while \`hookdeck listen\` looks ` +
      `for them in the CLI's, so the Gateway will report healthy and receive nothing. Point the CLI ` +
      `at the same project with \`hookdeck login\`, or configure an API key belonging to ${cli.projectId}.`,
  };
}

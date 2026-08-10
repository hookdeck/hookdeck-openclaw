import { uncoveredStatuses } from "../hookdeck/provision.js";
import { RETRYABLE_STATUS_CODES } from "../protocol/outcome.js";
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

  const orphans = deps.ledger.listOrphans().length;
  checks.push({
    name: "interrupted work",
    ok: orphans === 0,
    detail:
      orphans === 0
        ? "none"
        : `${orphans} row(s) left running by a previous process`,
  });

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

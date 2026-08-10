import {
  buildConnectionSpec,
  fingerprint,
  routeProvisionSpec,
} from "../hookdeck/provision.js";
import { RETRYABLE_STATUS_CODES } from "../protocol/outcome.js";
import { requireClient, isError, type ToolDeps } from "./deps.js";

/**
 * `hookdeck_setup` — provisions the connections a route needs. Dry run by
 * default, so an agent has to mean it.
 */

export async function setupHandler(
  deps: ToolDeps,
  params: { routeId?: string; dryRun?: boolean },
) {
  const client = requireClient(deps);
  if (isError(client)) return { applied: false, note: client.error };

  const dryRun = params.dryRun ?? true;
  const results: Record<string, unknown>[] = [];

  for (const [routeId, route] of Object.entries(deps.config.routes)) {
    if (params.routeId !== undefined && routeId !== params.routeId) continue;
    if (!route.enabled) continue;

    const credentials =
      route.verification !== undefined
        ? await deps.resolveVerification?.(routeId)
        : undefined;

    // Refuse rather than provision around it. The spec is an upsert: applying
    // one without the source auth block turns a verified source into an open
    // endpoint, and "setup succeeded" is the last message anyone would read as
    // a warning.
    if (route.verification !== undefined && credentials === undefined) {
      results.push({
        routeId,
        applied: false,
        error:
          `Route '${routeId}' configures ${route.verification.provider} verification, but its ` +
          `credentials could not be resolved here. Applying would upsert a source with no ` +
          `verification at all. Restart the Gateway so the service provisions it, or fix the ` +
          `secret inputs under routes.${routeId}.verification.credentials.`,
      });
      continue;
    }

    const spec = buildConnectionSpec(
      routeProvisionSpec({ config: deps.config, routeId, route, credentials }),
    );
    const print = fingerprint(spec);
    const unchanged =
      deps.cursors.get(routeId)?.provisioningFingerprint === print;

    if (dryRun) {
      // Summarised rather than dumped: the spec carries `source.config.auth`
      // and `destination.config.auth`, and a provider webhook secret must not
      // be echoed into a model's context because someone asked what would
      // change.
      results.push({
        routeId,
        wouldApply: !unchanged,
        unchanged,
        summary: {
          connectionName: spec.name,
          source: (spec.source as { name: string }).name,
          destination: {
            name: (spec.destination as { name: string }).name,
            type: (spec.destination as { type: string }).type,
          },
          rules: spec.rules.map((r) => r.type),
          retryStatuses: RETRYABLE_STATUS_CODES,
        },
      });
      continue;
    }

    const result = await client.upsertConnection(spec);
    if (!result.ok) {
      results.push({ routeId, applied: false, error: result.message });
      continue;
    }
    await deps.cursors.patch(routeId, {
      provisioningFingerprint: print,
      connectionId: result.data.id,
    });
    results.push({ routeId, applied: true, connectionId: result.data.id });
  }

  return { dryRun, results };
}

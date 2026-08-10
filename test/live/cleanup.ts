/**
 * Deletes the live suite's own leftovers.
 *
 * Deliberately NOT part of `src/hookdeck/client.ts`. That client has no delete
 * method at all, and that is a property worth keeping: nothing the plugin ships
 * can remove a connection, a source or a destination, however it is called.
 * Deleting one cancels its pending events irrecoverably. Test cleanup is the
 * one place that genuinely needs the verb, so it lives here and talks to the
 * API directly.
 *
 * It sweeps by PREFIX rather than by the ids created in this run. Runs that
 * crash, time out, or are killed with Ctrl-C never reach their teardown, and
 * an id-scoped sweep leaves those behind forever — which is exactly how 37
 * connections accumulated in a real project before anyone noticed.
 */

const BASE = "https://api.hookdeck.com/2025-07-01";
export const CI_PREFIX = "openclaw-ci-";

interface Named {
  id: string;
  name?: string;
}

async function api(
  apiKey: string,
  method: string,
  path: string,
): Promise<unknown> {
  const response = await fetch(`${BASE}${path}`, {
    method,
    headers: { authorization: `Bearer ${apiKey}` },
  });
  if (!response.ok) throw new Error(`${method} ${path}: ${response.status}`);
  return response.json().catch(() => ({}));
}

async function listPrefixed(apiKey: string, kind: string): Promise<Named[]> {
  const body = (await api(apiKey, "GET", `/${kind}?limit=255`)) as {
    models?: Named[];
  };
  return (body.models ?? []).filter((m) => m.name?.startsWith(CI_PREFIX));
}

export interface SweepResult {
  connections: number;
  sources: number;
  destinations: number;
  failures: string[];
}

/**
 * Removes every `openclaw-ci-*` object in the project.
 *
 * Connections first: a source or destination still bound to one cannot be
 * deleted, so the reverse order fails on everything.
 */
export async function sweepCiResources(apiKey: string): Promise<SweepResult> {
  const result: SweepResult = {
    connections: 0,
    sources: 0,
    destinations: 0,
    failures: [],
  };

  for (const kind of ["connections", "sources", "destinations"] as const) {
    for (const item of await listPrefixed(apiKey, kind)) {
      try {
        await api(apiKey, "DELETE", `/${kind}/${item.id}`);
        result[kind] += 1;
      } catch (err) {
        result.failures.push(
          `${kind}/${item.id} (${item.name}): ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
  }

  return result;
}

import { resolvePath } from "./template.js";

/**
 * Per-route payload filters.
 *
 * Deliberately narrow. Hookdeck can filter server-side, and doing it there is
 * better — a filtered event never reaches the agent at all and costs nothing.
 * These exist for the cases where the decision depends on something the
 * connection cannot express, and for operators who would rather keep routing in
 * one place.
 *
 * A non-matching delivery is answered `200`, not a failure: the drop is
 * deliberate, and a `2xx` correctly retires the event rather than leaving
 * Hookdeck retrying something we will never accept.
 */

export interface RouteFilter {
  /** Dotted path into the payload, e.g. `type` or `data.object.status`. */
  path: string;
  equals?: string | number | boolean;
  in?: (string | number | boolean)[];
  exists?: boolean;
}

export interface FilterResult {
  matched: boolean;
  /** Which filter rejected, for the log line and the response body. */
  reason?: string;
}

export function evaluateFilters(
  filters: readonly RouteFilter[] | undefined,
  payload: unknown,
): FilterResult {
  if (filters === undefined || filters.length === 0) return { matched: true };

  // All filters must pass. An OR would need grouping syntax, and a route per
  // condition is clearer than a query language nobody asked for.
  for (const filter of filters) {
    const value = resolvePath(payload, filter.path);

    if (filter.exists !== undefined) {
      const present = value !== undefined && value !== null;
      if (present !== filter.exists) {
        return {
          matched: false,
          reason: `${filter.path} ${present ? "is present" : "is absent"}, expected ${
            filter.exists ? "present" : "absent"
          }`,
        };
      }
      continue;
    }

    if (filter.equals !== undefined) {
      if (value !== filter.equals) {
        return { matched: false, reason: `${filter.path} !== ${JSON.stringify(filter.equals)}` };
      }
      continue;
    }

    if (filter.in !== undefined) {
      if (!filter.in.includes(value as string | number | boolean)) {
        return { matched: false, reason: `${filter.path} not in ${JSON.stringify(filter.in)}` };
      }
      continue;
    }
  }

  return { matched: true };
}

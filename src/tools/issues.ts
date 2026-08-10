import type {
  HookdeckClient,
  HookdeckIssue,
  IssueStatus,
} from "../hookdeck/client.js";
import { requireClient, isError, type ToolDeps } from "./deps.js";

/**
 * `hookdeck_issues` — the dead-letter queue and its lifecycle.
 *
 * Hookdeck Issues ARE the dead-letter queue; this plugin keeps no parallel one
 * and no parallel lifecycle. Acknowledging here is what the dashboard, the
 * notifications and everyone else looking at the project will see.
 *
 * Clearing an issue changes the report, never the events, so every mutating
 * response says what it did and did not do.
 */

/**
 * Hookdeck Issues, with their lifecycle.
 *
 * This is the dead-letter queue. The plugin keeps no parallel one and no
 * parallel lifecycle: acknowledging here is what the dashboard, the
 * notifications and anyone else looking at the project will see.
 *
 * Clearing an issue changes the report, never the events. An agent that
 * resolves an issue without replaying has tidied the dashboard and fixed
 * nothing, so every mutating response says what it did and did not do.
 */
export interface IssuesResult {
  ok: boolean;
  note?: string;
  summary?: string;
  dryRun?: boolean;
  /** list */
  status?: string;
  total?: number | null;
  shown?: number;
  issues?: ReturnType<typeof summariseIssue>[];
  totalNote?: string;
  /** get */
  issue?: ReturnType<typeof summariseIssue>;
  reference?: Record<string, unknown> | null;
  /** mutations */
  issueId?: string;
  dismissed?: boolean;
  replayed?: boolean;
}

export async function issuesHandler(
  deps: ToolDeps,
  params: {
    action?: "list" | "get" | "acknowledge" | "resolve" | "ignore" | "dismiss";
    issueId?: string;
    status?: string;
    type?: string;
    limit?: number;
    confirm?: boolean;
  },
  /**
   * With mutations off, `list` and `get` still work and the rest are refused.
   * "Diagnose but not act" has to include seeing what has been given up on, so
   * this tool stays registered either way.
   */
  allowMutations = true,
): Promise<IssuesResult> {
  const client = requireClient(deps);
  if (isError(client)) return { ok: false, note: client.error };

  const action = params.action ?? "list";

  if (!allowMutations && action !== "list" && action !== "get") {
    return {
      ok: false,
      note:
        `This deployment sets tools.allowMutations: false, so '${action}' is unavailable. ` +
        `Listing and inspecting issues still work; changing one needs an operator.`,
    };
  }

  if (action === "list") {
    const status = params.status ?? "OPENED";
    const result = await client.listIssues({
      status,
      limit: Math.min(Math.max(params.limit ?? 20, 1), 100),
      ...(params.type !== undefined ? { type: params.type } : {}),
    });
    if (!result.ok)
      return { ok: false, note: `Issue lookup failed: ${result.message}` };

    const names = await resolveConnectionNames(client, result.data);

    // Counted separately: a list is capped, so its length answers "how many did
    // you show me", not "how many are there".
    //
    // The count endpoint takes no type filter, so with one applied it counts
    // MORE than the list describes. Reporting that as `total` beside three
    // delivery issues would read as "3 of 12 shown" when the twelve include
    // types the caller filtered out. Omitted rather than approximated.
    const total =
      params.type === undefined
        ? await client.countIssues({ status })
        : undefined;

    return {
      ok: true,
      status,
      ...(total !== undefined ? { total: total.ok ? total.data : null } : {}),
      ...(params.type !== undefined
        ? {
            totalNote:
              `Filtered to type '${params.type}'. Hookdeck's count endpoint takes no type ` +
              `filter, so no project-wide total is reported here.`,
          }
        : {}),
      shown: result.data.length,
      issues: result.data.map((i) => summariseIssue(i, names)),
      ...(result.data.length === 0
        ? {
            summary:
              status === "OPENED"
                ? "No open issues: Hookdeck has not given up on anything."
                : `No issues with status ${status}.`,
          }
        : {}),
    };
  }

  const issueId = params.issueId;
  if (issueId === undefined) {
    return {
      ok: false,
      note: `Action '${action}' needs an issueId. Run action 'list' first.`,
    };
  }

  if (action === "get") {
    const result = await client.getIssue(issueId);
    if (!result.ok)
      return { ok: false, note: `Issue lookup failed: ${result.message}` };
    const names = await resolveConnectionNames(client, [result.data]);
    return {
      ok: true,
      issue: summariseIssue(result.data, names),
      reference: result.data.reference ?? null,
    };
  }

  if (action === "dismiss") {
    // Dismissal removes the operator's record that anything went wrong. The
    // events are untouched, but nobody will be told about them again.
    if (params.confirm !== true) {
      return {
        ok: false,
        dryRun: true,
        note:
          `Dismissing issue ${issueId} removes it from the project's record of what has failed. ` +
          `The events themselves are unaffected and are NOT replayed. Pass confirm: true to ` +
          `proceed, or use action 'resolve' if the underlying problem is actually fixed.`,
      };
    }
    const result = await client.dismissIssue(issueId);
    return result.ok
      ? { ok: true, issueId, dismissed: true, replayed: false }
      : { ok: false, note: `Dismiss failed: ${result.message}` };
  }

  const status = ISSUE_ACTION_STATUS[action];
  const result = await client.updateIssue(issueId, status);
  if (!result.ok)
    return { ok: false, note: `Issue update failed: ${result.message}` };

  return {
    ok: true,
    issueId,
    status,
    // Said every time, because "resolved" reads like "fixed" and it is not.
    note:
      status === "RESOLVED"
        ? "Marked resolved. This changes the issue's status only — no events were replayed. " +
          "Use hookdeck_replay if the failed events still need to run."
        : `Marked ${status.toLowerCase()}. No events were replayed.`,
  };
}

const ISSUE_ACTION_STATUS = {
  acknowledge: "ACKNOWLEDGED",
  resolve: "RESOLVED",
  ignore: "IGNORED",
} as const satisfies Record<string, IssueStatus>;

export function summariseIssue(
  issue: HookdeckIssue,
  connectionNames?: ReadonlyMap<string, string>,
) {
  const keys = issue.aggregation_keys ?? null;
  const ids = webhookIdsOf(issue);

  return {
    id: issue.id,
    type: issue.type ?? issue.issue_type ?? null,
    status: issue.status ?? null,
    firstSeen: issue.first_seen_at ?? null,
    lastSeen: issue.last_seen_at ?? null,
    /**
     * Named, not just identified.
     *
     * Issues carry `webhook_id` alone, while people refer to connections by
     * name. Without the name a model cannot match an issue to the connection
     * it was asked about, and will fall back to whichever key it can evaluate.
     */
    connections:
      ids.length === 0
        ? null
        : ids.map((id) => ({ id, name: connectionNames?.get(id) ?? null })),
    // Delivery issues also aggregate on response_status and error_code — with
    // the connection, that is "which one, failing how".
    keys,
  };
}

function webhookIdsOf(issue: HookdeckIssue): string[] {
  const raw = (issue.aggregation_keys ?? {})["webhook_id"];
  const list = Array.isArray(raw) ? raw : raw === undefined ? [] : [raw];
  return list.filter((v): v is string => typeof v === "string");
}

/**
 * Looks up the connection names an issue list refers to.
 *
 * One request per distinct id, capped: a page of issues spanning many
 * connections should not turn one tool call into fifty. Failures degrade to a
 * null name rather than failing the listing — an issue with an unresolved name
 * is still worth showing.
 */
const MAX_NAME_LOOKUPS = 25;

export async function resolveConnectionNames(
  client: HookdeckClient,
  issues: readonly HookdeckIssue[],
): Promise<Map<string, string>> {
  const names = new Map<string, string>();
  const ids = [...new Set(issues.flatMap(webhookIdsOf))].slice(
    0,
    MAX_NAME_LOOKUPS,
  );

  await Promise.all(
    ids.map(async (id) => {
      const result = await client.getConnection(id).catch(() => undefined);
      if (result?.ok === true && result.data.name !== undefined) {
        names.set(id, result.data.name);
      }
    }),
  );

  return names;
}

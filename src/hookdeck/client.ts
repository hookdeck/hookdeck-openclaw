/**
 * Minimal Hookdeck REST client.
 *
 * Hand-rolled rather than using `@hookdeck/sdk`: that package is pinned at
 * 0.4.0, its repository is archived, and it already lags the API (no
 * `event.replay`, no bulk cancel, no archive/unarchive). For a plugin whose
 * entire value proposition is reliability, an unmaintained client in the
 * recovery path is the wrong dependency.
 *
 * `fetch` is injected so the whole surface is testable without a socket.
 */

export const HOOKDECK_API_BASE = "https://api.hookdeck.com/2025-07-01";

export type FetchLike = (
  input: string,
  init?: RequestInit,
) => Promise<Response>;

export interface HookdeckClientOptions {
  apiKey: string;
  baseUrl?: string;
  fetch?: FetchLike;
  timeoutMs?: number;
}

export type ApiResult<T> =
  | { ok: true; data: T }
  | { ok: false; status?: number; code: string; message: string };

export interface HookdeckConnection {
  id: string;
  paused_at?: string | null;
  rules?: { type: string; response_status_codes?: string[] }[];
}

export interface HookdeckEvent {
  id: string;
  status?: string;
  response_status?: number | null;
  attempts?: number;
  created_at?: string;
  successful_at?: string | null;
  event_data_id?: string;
  /** Request headers as Hookdeck received them; redacted before they escape. */
  headers?: Record<string, unknown>;
}

export interface HookdeckIssue {
  id: string;
  status?: string;
  /**
   * `delivery` | `transformation` | `backpressure` | `request`. The API field
   * is `type`; `issue_type` is accepted too because older responses used it and
   * a mislabelled issue is worse than a slightly wider type.
   */
  type?: string;
  issue_type?: string;
  first_seen_at?: string;
  last_seen_at?: string;
  opened_at?: string;
  /** Delivery issues key on `webhook_id`, `response_status`, `error_code`. */
  aggregation_keys?: Record<string, unknown>;
  reference?: Record<string, unknown>;
}

/** Statuses `PUT /issues/{id}` accepts. */
export const ISSUE_STATUSES = [
  "OPENED",
  "ACKNOWLEDGED",
  "RESOLVED",
  "IGNORED",
] as const;
export type IssueStatus = (typeof ISSUE_STATUSES)[number];

export interface HookdeckAttempt {
  id: string;
  attempt_number?: number;
  status?: string;
  response_status?: number | null;
  error_code?: string | null;
  trigger?: string;
  created_at?: string;
  delivered_at?: string | null;
  response_latency?: number | null;
}

export interface HookdeckClient {
  /**
   * Manually retry an event.
   *
   * Works on events Hookdeck already considers SUCCESSFUL — confirmed against a
   * live project, where an event with three `202` attempts still accepted two
   * subsequent `MANUAL` retries. That is what makes Hookdeck the durable work
   * queue for interrupted runs, and why this plugin needs no local one.
   */
  retryEvent(eventId: string): Promise<ApiResult<{ eventId: string }>>;

  /** Collection-level PUT is the upsert; one call provisions all three objects. */
  upsertConnection(spec: unknown): Promise<ApiResult<HookdeckConnection>>;

  getConnection(id: string): Promise<ApiResult<HookdeckConnection>>;

  /**
   * Holds inbound events at status `HOLD` until unpaused, delivered then with
   * attempt trigger `UNPAUSE`. Nothing is dropped.
   *
   * Never `disable` instead: that cancels pending events irrecoverably, as does
   * deleting a connection.
   */
  pauseConnection(id: string): Promise<ApiResult<HookdeckConnection>>;
  unpauseConnection(id: string): Promise<ApiResult<HookdeckConnection>>;

  /**
   * Time-boundable catch-up. `bulk/ignored-events/retry` accepts only
   * `{cause, webhook_id, transformation_id}` with no date filter, and there is
   * no project-wide `GET /ignored-events`, so replay is the only path that can
   * be scoped to an outage window.
   */
  listEvents(params?: {
    limit?: number;
    status?: string;
    webhookId?: string;
  }): Promise<ApiResult<HookdeckEvent[]>>;

  getEvent(id: string): Promise<ApiResult<HookdeckEvent>>;

  /** Raw delivered body, fetched separately from the event record. */
  getEventBody(id: string): Promise<ApiResult<unknown>>;

  listIssues(params?: {
    status?: string;
    limit?: number;
    type?: string;
  }): Promise<ApiResult<HookdeckIssue[]>>;

  getIssue(id: string): Promise<ApiResult<HookdeckIssue>>;

  /**
   * Moves an issue through its lifecycle. This is the dead-letter queue's
   * lifecycle — the plugin keeps no parallel one.
   *
   * `RESOLVED` says the underlying problem is fixed; `ACKNOWLEDGED` says a human
   * or agent has seen it and is working on it. Neither replays anything: an
   * issue is a report about events, so clearing it without retrying the events
   * changes what the dashboard says and nothing else.
   */
  updateIssue(
    id: string,
    status: IssueStatus,
  ): Promise<ApiResult<HookdeckIssue>>;

  /**
   * `DELETE /issues/{id}`. Dismissal is not deletion of the events, but it does
   * remove the operator's record that anything went wrong, so the tool asks
   * before doing it.
   */
  dismissIssue(id: string): Promise<ApiResult<{ id: string }>>;

  /**
   * Full attempt history for an event. `GET /events/{id}` carries only a count,
   * which cannot answer "what did it fail with, and how many times".
   */
  listAttempts(
    eventId: string,
    limit?: number,
  ): Promise<ApiResult<HookdeckAttempt[]>>;

  /** A real count. Counting a capped list reports the cap, not the truth. */
  countIssues(params?: { status?: string }): Promise<ApiResult<number>>;

  bulkReplayRequests(params: {
    query: Record<string, unknown>;
    target: { webhook_ids?: string[]; source_id?: string };
  }): Promise<ApiResult<{ id?: string; estimated_count?: number }>>;
}

/** The slice the dispatch and recovery paths depend on. */
export type EventRetrier = Pick<HookdeckClient, "retryEvent">;

const DEFAULT_TIMEOUT_MS = 10_000;

export function createHookdeckClient(
  options: HookdeckClientOptions,
): HookdeckClient {
  const baseUrl = (options.baseUrl ?? HOOKDECK_API_BASE).replace(/\/+$/, "");
  const doFetch = options.fetch ?? (globalThis.fetch as FetchLike);
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  async function request<T>(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<ApiResult<T>> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await doFetch(`${baseUrl}${path}`, {
        method,
        headers: {
          authorization: `Bearer ${options.apiKey}`,
          "content-type": "application/json",
        },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
        signal: controller.signal,
      });

      if (!response.ok) {
        let message = `${response.status} ${response.statusText}`;
        try {
          const body = (await response.json()) as { message?: string };
          if (body?.message) message = body.message;
        } catch {
          // Non-JSON error body; the status line is enough.
        }
        return {
          ok: false,
          status: response.status,
          code: response.status === 404 ? "not_found" : "api_error",
          message,
        };
      }

      const data = (await response.json().catch(() => ({}))) as T;
      return { ok: true, data };
    } catch (err) {
      const aborted = err instanceof Error && err.name === "AbortError";
      return {
        ok: false,
        code: aborted ? "timeout" : "network_error",
        message: err instanceof Error ? err.message : String(err),
      };
    } finally {
      clearTimeout(timer);
    }
  }

  return {
    async retryEvent(eventId) {
      const result = await request<unknown>(
        "POST",
        `/events/${encodeURIComponent(eventId)}/retry`,
      );
      return result.ok ? { ok: true, data: { eventId } } : result;
    },

    async upsertConnection(spec) {
      return request<HookdeckConnection>("PUT", "/connections", spec);
    },

    async getConnection(id) {
      return request<HookdeckConnection>(
        "GET",
        `/connections/${encodeURIComponent(id)}`,
      );
    },

    async pauseConnection(id) {
      return request<HookdeckConnection>(
        "PUT",
        `/connections/${encodeURIComponent(id)}/pause`,
      );
    },

    async unpauseConnection(id) {
      return request<HookdeckConnection>(
        "PUT",
        `/connections/${encodeURIComponent(id)}/unpause`,
      );
    },

    async listEvents(params = {}) {
      const query = new URLSearchParams();
      query.set("limit", String(params.limit ?? 20));
      if (params.status !== undefined) query.set("status", params.status);
      if (params.webhookId !== undefined)
        query.set("webhook_id", params.webhookId);
      const result = await request<{ models?: HookdeckEvent[] }>(
        "GET",
        `/events?${query}`,
      );
      return result.ok ? { ok: true, data: result.data.models ?? [] } : result;
    },

    async getEvent(id) {
      return request<HookdeckEvent>("GET", `/events/${encodeURIComponent(id)}`);
    },

    async getEventBody(id) {
      return request<unknown>(
        "GET",
        `/events/${encodeURIComponent(id)}/raw_body`,
      );
    },

    async listIssues(params = {}) {
      const query = new URLSearchParams();
      query.set("limit", String(params.limit ?? 20));
      if (params.status !== undefined) query.set("status", params.status);
      if (params.type !== undefined) query.set("type", params.type);
      const result = await request<{ models?: HookdeckIssue[] }>(
        "GET",
        `/issues?${query}`,
      );
      return result.ok ? { ok: true, data: result.data.models ?? [] } : result;
    },

    async getIssue(id) {
      return request<HookdeckIssue>("GET", `/issues/${encodeURIComponent(id)}`);
    },

    async updateIssue(id, status) {
      return request<HookdeckIssue>(
        "PUT",
        `/issues/${encodeURIComponent(id)}`,
        { status },
      );
    },

    async dismissIssue(id) {
      const result = await request<unknown>(
        "DELETE",
        `/issues/${encodeURIComponent(id)}`,
      );
      return result.ok ? { ok: true, data: { id } } : result;
    },

    async listAttempts(eventId, limit = 20) {
      const query = new URLSearchParams({
        event_id: eventId,
        limit: String(limit),
      });
      const result = await request<{ models?: HookdeckAttempt[] }>(
        "GET",
        `/attempts?${query}`,
      );
      return result.ok ? { ok: true, data: result.data.models ?? [] } : result;
    },

    async countIssues(params = {}) {
      const query = new URLSearchParams();
      if (params.status !== undefined) query.set("status", params.status);
      const result = await request<{ count?: number }>(
        "GET",
        `/issues/count?${query}`,
      );
      return result.ok ? { ok: true, data: result.data.count ?? 0 } : result;
    },

    async bulkReplayRequests(params) {
      return request<{ id?: string; estimated_count?: number }>(
        "POST",
        "/bulk/requests/replay",
        params,
      );
    },
  };
}

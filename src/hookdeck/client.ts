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

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export interface HookdeckClientOptions {
  apiKey: string;
  baseUrl?: string;
  fetch?: FetchLike;
  timeoutMs?: number;
}

export type ApiResult<T> =
  | { ok: true; data: T }
  | { ok: false; status?: number; code: string; message: string };

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
}

const DEFAULT_TIMEOUT_MS = 10_000;

export function createHookdeckClient(options: HookdeckClientOptions): HookdeckClient {
  const baseUrl = (options.baseUrl ?? HOOKDECK_API_BASE).replace(/\/+$/, "");
  const doFetch = options.fetch ?? (globalThis.fetch as FetchLike);
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  async function request<T>(method: string, path: string): Promise<ApiResult<T>> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await doFetch(`${baseUrl}${path}`, {
        method,
        headers: {
          authorization: `Bearer ${options.apiKey}`,
          "content-type": "application/json",
        },
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
      const result = await request<unknown>("POST", `/events/${encodeURIComponent(eventId)}/retry`);
      return result.ok ? { ok: true, data: { eventId } } : result;
    },
  };
}

import { describe, expect, it, vi } from "vitest";
import {
  createHookdeckClient,
  HOOKDECK_API_BASE,
  type FetchLike,
} from "../src/hookdeck/client.js";

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("hookdeck client — retryEvent", () => {
  it("POSTs to the pinned API version with bearer auth", async () => {
    const fetchMock = vi.fn<FetchLike>(async () => jsonResponse(200, {}));
    const client = createHookdeckClient({
      apiKey: "key_123",
      fetch: fetchMock,
    });

    const result = await client.retryEvent("evt_1");

    expect(result).toEqual({ ok: true, data: { eventId: "evt_1" } });
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe(`${HOOKDECK_API_BASE}/events/evt_1/retry`);
    expect(init?.method).toBe("POST");
    expect((init?.headers as Record<string, string>).authorization).toBe(
      "Bearer key_123",
    );
  });

  it("pins the dated API version so a breaking change cannot land silently", () => {
    expect(HOOKDECK_API_BASE).toBe("https://api.hookdeck.com/2025-07-01");
  });

  it("url-encodes the event id", async () => {
    const fetchMock = vi.fn<FetchLike>(async () => jsonResponse(200, {}));
    await createHookdeckClient({ apiKey: "k", fetch: fetchMock }).retryEvent(
      "evt/../danger",
    );
    expect(fetchMock.mock.calls[0]![0]).toContain("evt%2F..%2Fdanger");
  });

  it("maps 404 to not_found", async () => {
    const fetchMock = vi.fn<FetchLike>(async () =>
      jsonResponse(404, { message: "no such event" }),
    );
    const result = await createHookdeckClient({
      apiKey: "k",
      fetch: fetchMock,
    }).retryEvent("evt_1");
    expect(result).toMatchObject({
      ok: false,
      status: 404,
      code: "not_found",
      message: "no such event",
    });
  });

  it("surfaces the API message on other errors", async () => {
    const fetchMock = vi.fn<FetchLike>(async () =>
      jsonResponse(422, { message: "destination.config.auth is required" }),
    );
    const result = await createHookdeckClient({
      apiKey: "k",
      fetch: fetchMock,
    }).retryEvent("evt_1");
    expect(result).toMatchObject({
      ok: false,
      status: 422,
      message: "destination.config.auth is required",
    });
  });

  it("falls back to the status line when the error body is not JSON", async () => {
    const fetchMock = vi.fn<FetchLike>(
      async () => new Response("nope", { status: 500 }),
    );
    const result = await createHookdeckClient({
      apiKey: "k",
      fetch: fetchMock,
    }).retryEvent("evt_1");
    expect(result).toMatchObject({ ok: false, status: 500 });
  });

  it("reports a network failure without throwing", async () => {
    const fetchMock = vi.fn<FetchLike>(async () => {
      throw new Error("ECONNREFUSED");
    });
    const result = await createHookdeckClient({
      apiKey: "k",
      fetch: fetchMock,
    }).retryEvent("evt_1");
    expect(result).toMatchObject({
      ok: false,
      code: "network_error",
      message: "ECONNREFUSED",
    });
  });

  it("times out rather than hanging startup", async () => {
    const fetchMock = vi.fn<FetchLike>(
      (_url, init) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => {
            const err = new Error("aborted");
            err.name = "AbortError";
            reject(err);
          });
        }),
    );
    const client = createHookdeckClient({
      apiKey: "k",
      fetch: fetchMock,
      timeoutMs: 10,
    });
    const result = await client.retryEvent("evt_1");
    expect(result).toMatchObject({ ok: false, code: "timeout" });
  });

  it("honours a custom base url", async () => {
    const fetchMock = vi.fn<FetchLike>(async () => jsonResponse(200, {}));
    await createHookdeckClient({
      apiKey: "k",
      fetch: fetchMock,
      baseUrl: "http://localhost:9999/api/",
    }).retryEvent("evt_1");
    expect(fetchMock.mock.calls[0]![0]).toBe(
      "http://localhost:9999/api/events/evt_1/retry",
    );
  });
});

describe("rate limiting is distinguishable from a broken event", () => {
  it("reports 429 with its own code and the Retry-After", async () => {
    // A caller looping over events would otherwise report a generic failure
    // per event, which reads as "those events are broken" rather than "slow
    // down".
    const client = createHookdeckClient({
      apiKey: "k",
      fetch: async () =>
        new Response(JSON.stringify({ message: "too many requests" }), {
          status: 429,
          headers: { "retry-after": "30", "content-type": "application/json" },
        }),
    });

    const result = await client.retryEvent("evt_1");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("rate_limited");
      expect(result.retryAfterSeconds).toBe(30);
      expect(result.message).toContain("30s");
    }
  });

  it("still reports a rate limit without a Retry-After header", async () => {
    const client = createHookdeckClient({
      apiKey: "k",
      fetch: async () => new Response("{}", { status: 429 }),
    });
    const result = await client.retryEvent("evt_1");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("rate_limited");
      expect(result.retryAfterSeconds).toBeUndefined();
    }
  });

  it("keeps 404 distinct, since that means retention not throttling", async () => {
    const client = createHookdeckClient({
      apiKey: "k",
      fetch: async () => new Response("{}", { status: 404 }),
    });
    const result = await client.getIssue("iss_1");
    expect(result.ok === false && result.code).toBe("not_found");
  });
});

describe("bulk replay sends the body the API actually requires", () => {
  /**
   * Asserted on the ENCODED body, not on the object handed to the client.
   * A test that checks the argument before it becomes a request cannot see a
   * wrong wire shape — and this one was wrong: `target` sent at the top level
   * is answered `422 query.target is required`, so every catch-up replay
   * failed having replayed nothing.
   */
  function capture() {
    const sent: { url: string; body: unknown }[] = [];
    const client = createHookdeckClient({
      apiKey: "k",
      fetch: async (url, init) => {
        sent.push({ url, body: JSON.parse(String(init?.body ?? "{}")) });
        return new Response(
          JSON.stringify({ id: "bch_1", estimated_count: 3 }),
          {
            status: 200,
            headers: { "content-type": "application/json" },
          },
        );
      },
    });
    return { client, sent };
  }

  it("nests target inside query, where the API requires it", async () => {
    const { client, sent } = capture();
    await client.bulkReplayRequests({
      query: { cli_events_count: 0, ignored_count: { gte: 1 } },
      target: { webhook_ids: ["web_1"] },
    });

    expect(sent[0]!.body).toEqual({
      query: {
        cli_events_count: 0,
        ignored_count: { gte: 1 },
        target: { webhook_ids: ["web_1"] },
      },
    });
  });

  it("sends nothing at the top level except query", async () => {
    const { client, sent } = capture();
    await client.bulkReplayRequests({
      query: { cli_events_count: 0 },
      target: { webhook_ids: ["web_1"] },
    });
    expect(Object.keys(sent[0]!.body as object)).toEqual(["query"]);
  });

  it("treats a window that matched nothing as success, not failure", async () => {
    // Hookdeck answers 422 for both a malformed body and an empty match. Only
    // the second is a normal outcome, and reporting it as an outage would send
    // an operator looking for a fault that is not there.
    const client = createHookdeckClient({
      apiKey: "k",
      fetch: async () =>
        new Response(
          JSON.stringify({
            code: "UNPROCESSABLE_ENTITY",
            status: 422,
            data: {
              message:
                "The query filter for the batch operations does not include any requests. Please try a different query filter.",
            },
          }),
          { status: 422, headers: { "content-type": "application/json" } },
        ),
    });

    const result = await client.bulkReplayRequests({
      query: {},
      target: { webhook_ids: ["web_1"] },
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.data.estimated_count).toBe(0);
  });

  it("still reports a genuinely malformed body as a failure", async () => {
    const client = createHookdeckClient({
      apiKey: "k",
      fetch: async () =>
        new Response(
          JSON.stringify({ status: 422, data: ["query.target is required"] }),
          { status: 422, headers: { "content-type": "application/json" } },
        ),
    });

    const result = await client.bulkReplayRequests({
      query: {},
      target: { webhook_ids: ["web_1"] },
    });
    expect(result.ok).toBe(false);
    if (!result.ok)
      expect(result.message).toContain("query.target is required");
  });
});

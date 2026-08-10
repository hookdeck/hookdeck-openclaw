import { describe, expect, it, vi } from "vitest";
import { createHookdeckClient, HOOKDECK_API_BASE, type FetchLike } from "../src/hookdeck/client.js";

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("hookdeck client — retryEvent", () => {
  it("POSTs to the pinned API version with bearer auth", async () => {
    const fetchMock = vi.fn<FetchLike>(async () => jsonResponse(200, {}));
    const client = createHookdeckClient({ apiKey: "key_123", fetch: fetchMock });

    const result = await client.retryEvent("evt_1");

    expect(result).toEqual({ ok: true, data: { eventId: "evt_1" } });
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe(`${HOOKDECK_API_BASE}/events/evt_1/retry`);
    expect(init?.method).toBe("POST");
    expect((init?.headers as Record<string, string>).authorization).toBe("Bearer key_123");
  });

  it("pins the dated API version so a breaking change cannot land silently", () => {
    expect(HOOKDECK_API_BASE).toBe("https://api.hookdeck.com/2025-07-01");
  });

  it("url-encodes the event id", async () => {
    const fetchMock = vi.fn<FetchLike>(async () => jsonResponse(200, {}));
    await createHookdeckClient({ apiKey: "k", fetch: fetchMock }).retryEvent("evt/../danger");
    expect(fetchMock.mock.calls[0]![0]).toContain("evt%2F..%2Fdanger");
  });

  it("maps 404 to not_found", async () => {
    const fetchMock = vi.fn<FetchLike>(async () => jsonResponse(404, { message: "no such event" }));
    const result = await createHookdeckClient({ apiKey: "k", fetch: fetchMock }).retryEvent("evt_1");
    expect(result).toMatchObject({ ok: false, status: 404, code: "not_found", message: "no such event" });
  });

  it("surfaces the API message on other errors", async () => {
    const fetchMock = vi.fn<FetchLike>(async () =>
      jsonResponse(422, { message: "destination.config.auth is required" }),
    );
    const result = await createHookdeckClient({ apiKey: "k", fetch: fetchMock }).retryEvent("evt_1");
    expect(result).toMatchObject({ ok: false, status: 422, message: "destination.config.auth is required" });
  });

  it("falls back to the status line when the error body is not JSON", async () => {
    const fetchMock = vi.fn<FetchLike>(async () => new Response("nope", { status: 500 }));
    const result = await createHookdeckClient({ apiKey: "k", fetch: fetchMock }).retryEvent("evt_1");
    expect(result).toMatchObject({ ok: false, status: 500 });
  });

  it("reports a network failure without throwing", async () => {
    const fetchMock = vi.fn<FetchLike>(async () => {
      throw new Error("ECONNREFUSED");
    });
    const result = await createHookdeckClient({ apiKey: "k", fetch: fetchMock }).retryEvent("evt_1");
    expect(result).toMatchObject({ ok: false, code: "network_error", message: "ECONNREFUSED" });
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
    const client = createHookdeckClient({ apiKey: "k", fetch: fetchMock, timeoutMs: 10 });
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
    expect(fetchMock.mock.calls[0]![0]).toBe("http://localhost:9999/api/events/evt_1/retry");
  });
});

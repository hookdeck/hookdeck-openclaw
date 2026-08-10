import { Readable } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import { readRawBody, type RawBodySource } from "../src/ingress/raw-body.js";

/**
 * The read loop is the one place raw bytes are handled, and signature
 * verification depends on those bytes being exact.
 */

function source(
  chunks: (Buffer | string)[],
  headers: Record<string, string> = {},
): RawBodySource {
  return Object.assign(Readable.from(chunks), { headers });
}

describe("readRawBody — success", () => {
  it("concatenates chunks byte-for-byte", async () => {
    const result = await readRawBody(
      source([Buffer.from('{"a":'), Buffer.from("1}")]),
      { maxBytes: 1024, timeoutMs: 1000 },
    );
    expect(result.ok && result.body.toString("utf8")).toBe('{"a":1}');
  });

  it("preserves multi-byte characters split across chunks", async () => {
    // Splitting a UTF-8 sequence mid-character and decoding per chunk would
    // corrupt it, and the HMAC is over the bytes.
    const full = Buffer.from("€uro", "utf8");
    const result = await readRawBody(
      source([full.subarray(0, 2), full.subarray(2)]),
      { maxBytes: 1024, timeoutMs: 1000 },
    );
    expect(result.ok && result.body.equals(full)).toBe(true);
  });

  it("accepts an empty body", async () => {
    const result = await readRawBody(source([]), {
      maxBytes: 1024,
      timeoutMs: 1000,
    });
    expect(result.ok && result.body.length).toBe(0);
  });
});

describe("readRawBody — limits", () => {
  it("rejects on a declared Content-Length over the limit without reading", async () => {
    // Cheaper and safer than discovering it chunk by chunk.
    const stream = source([Buffer.alloc(10)], { "content-length": "99999" });
    const spy = vi.spyOn(stream, Symbol.asyncIterator as never);
    const result = await readRawBody(stream, {
      maxBytes: 1024,
      timeoutMs: 1000,
    });

    expect(result).toEqual({ ok: false, reason: "too_large" });
    expect(spy).not.toHaveBeenCalled();
  });

  it("rejects when the actual body exceeds the limit mid-stream", async () => {
    const result = await readRawBody(
      source([Buffer.alloc(600), Buffer.alloc(600)]),
      { maxBytes: 1000, timeoutMs: 1000 },
    );
    expect(result).toEqual({ ok: false, reason: "too_large" });
  });

  it("ignores an unparseable Content-Length rather than trusting it", async () => {
    const result = await readRawBody(
      source([Buffer.from("hi")], { "content-length": "abc" }),
      {
        maxBytes: 1024,
        timeoutMs: 1000,
      },
    );
    expect(result.ok).toBe(true);
  });
});

describe("readRawBody — failure modes", () => {
  it("times out rather than waiting for a body that never arrives", async () => {
    const never = Object.assign(
      (async function* () {
        await new Promise(() => {});
      })(),
      { headers: {} },
    ) as RawBodySource;

    const result = await readRawBody(never, { maxBytes: 1024, timeoutMs: 10 });
    expect(result).toEqual({ ok: false, reason: "timeout" });
  });

  it("destroys the stream on timeout, so a slow client stops consuming memory", async () => {
    const destroy = vi.fn();
    const never = Object.assign(
      (async function* () {
        await new Promise(() => {});
      })(),
      { headers: {}, destroy },
    ) as unknown as RawBodySource;

    await readRawBody(never, { maxBytes: 1024, timeoutMs: 10 });
    expect(destroy).toHaveBeenCalled();
  });

  it("reports an aborted stream rather than throwing", async () => {
    const broken = Object.assign(
      (async function* () {
        yield Buffer.from("partial");
        throw new Error("socket reset");
      })(),
      { headers: {} },
    ) as RawBodySource;

    expect(
      await readRawBody(broken, { maxBytes: 1024, timeoutMs: 1000 }),
    ).toEqual({
      ok: false,
      reason: "aborted",
    });
  });

  it("does not destroy the stream on success", async () => {
    // A plain generator rather than a Readable: `Readable.from` destroys itself
    // when its iterator completes, which would mask whether we did.
    const destroy = vi.fn();
    const stream = Object.assign(
      (async function* () {
        yield Buffer.from("ok");
      })(),
      { headers: {}, destroy },
    ) as unknown as RawBodySource;

    const result = await readRawBody(stream, {
      maxBytes: 1024,
      timeoutMs: 1000,
    });
    expect(result.ok).toBe(true);
    expect(destroy).not.toHaveBeenCalled();
  });
});

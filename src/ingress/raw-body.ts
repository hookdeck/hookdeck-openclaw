/**
 * Reads the request body as raw bytes.
 *
 * OpenClaw's SDK helpers (`readRequestBodyWithLimit`, `readWebhookBodyOrReject`)
 * return a decoded string, and the built-in Webhooks plugin only ever sees
 * parsed JSON. Neither is usable for HMAC: the signature covers the exact octets
 * Hookdeck sent, and re-encoding a decoded string is not guaranteed to reproduce
 * them. The Gateway hands the route handler an unconsumed `req` stream, so we
 * read it ourselves and keep the Buffer.
 */

export interface RawBodySource extends AsyncIterable<Buffer | Uint8Array | string> {
  headers?: Record<string, string | string[] | undefined>;
}

export interface ReadRawBodyOptions {
  maxBytes: number;
  timeoutMs: number;
}

export type ReadRawBodyResult =
  | { ok: true; body: Buffer }
  | { ok: false; reason: "too_large" | "timeout" | "aborted" };

export const DEFAULT_MAX_BODY_BYTES = 1024 * 1024;
export const DEFAULT_BODY_TIMEOUT_MS = 15_000;

export async function readRawBody(
  req: RawBodySource,
  options: ReadRawBodyOptions,
): Promise<ReadRawBodyResult> {
  const { maxBytes, timeoutMs } = options;

  // Short-circuit on a declared Content-Length before reading anything.
  const declared = req.headers?.["content-length"];
  const declaredValue = Array.isArray(declared) ? declared[0] : declared;
  if (typeof declaredValue === "string") {
    const length = Number.parseInt(declaredValue, 10);
    if (Number.isFinite(length) && length > maxBytes) return { ok: false, reason: "too_large" };
  }

  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<ReadRawBodyResult>((resolve) => {
    timer = setTimeout(() => resolve({ ok: false, reason: "timeout" }), timeoutMs);
    // Do not hold the event loop open for a body that never arrives.
    timer.unref?.();
  });

  const read = (async (): Promise<ReadRawBodyResult> => {
    const chunks: Buffer[] = [];
    let total = 0;
    try {
      for await (const chunk of req) {
        const buf =
          typeof chunk === "string"
            ? Buffer.from(chunk, "utf8")
            : Buffer.isBuffer(chunk)
              ? chunk
              : Buffer.from(chunk);
        total += buf.length;
        if (total > maxBytes) return { ok: false, reason: "too_large" };
        chunks.push(buf);
      }
    } catch {
      return { ok: false, reason: "aborted" };
    }
    return { ok: true, body: Buffer.concat(chunks, total) };
  })();

  try {
    return await Promise.race([read, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

import { describe, expect, it } from "vitest";
import {
  computeHookdeckSignature,
  timingSafeEqualString,
  verifyHookdeckSignature,
} from "../src/protocol/signature.js";

/**
 * Golden vectors computed independently with `openssl dgst -sha256 -hmac`, NOT
 * with this module — otherwise the test only proves the code agrees with itself.
 */
const SECRET = "whsec_test";
const PREVIOUS_SECRET = "whsec_previous";

const VECTORS = {
  simple: {
    body: '{"hello":"world"}',
    signature: "B+pNeJLT3EuuIg2ZMK+jjEWKmXsvcWoKYVnhd5i+HSg=",
  },
  unicode: {
    // 20 bytes of UTF-8: c3a9 for "é", e29c93 for "✓". Signing the escaped
    // ASCII text instead produces a different digest — which is exactly the
    // class of mistake the raw-bytes rule exists to prevent.
    body: '{"name":"café ✓"}',
    signature: "vXSB5qspmNnjGZQRCanicbkBpZ1JQoWrMcVs8Gpgo98=",
  },
  empty: {
    body: "",
    signature: "Q8D00jyOiEE1j61GJLGlknmSIrKfJbtZuupDzctSLtE=",
  },
} as const;

const PREVIOUS_SIGNATURE = "PljPtCnQQANTnDNccZxPiqBg64Ej/yNDT71Yty9I9u4=";

describe("computeHookdeckSignature", () => {
  for (const [name, vector] of Object.entries(VECTORS)) {
    it(`matches the openssl golden vector (${name})`, () => {
      expect(
        computeHookdeckSignature(Buffer.from(vector.body, "utf8"), SECRET),
      ).toBe(vector.signature);
    });
  }
});

describe("verifyHookdeckSignature", () => {
  const body = Buffer.from(VECTORS.simple.body, "utf8");

  it("accepts a valid primary signature", () => {
    const result = verifyHookdeckSignature({
      rawBody: body,
      secret: SECRET,
      signatures: [VECTORS.simple.signature, undefined],
    });
    expect(result).toEqual({ valid: true, matchedSlot: 0 });
  });

  it("accepts the rotation slot, so a secret roll does not drop live traffic", () => {
    // Mid-rotation Hookdeck sends the NEW secret's signature in slot 1 and the
    // PREVIOUS one in slot 2. Here we still hold the previous secret.
    const result = verifyHookdeckSignature({
      rawBody: body,
      secret: PREVIOUS_SECRET,
      signatures: [VECTORS.simple.signature, PREVIOUS_SIGNATURE],
    });
    expect(result).toEqual({ valid: true, matchedSlot: 1 });
  });

  it("rejects a tampered body", () => {
    const tampered = Buffer.from('{"hello":"worlD"}', "utf8");
    expect(
      verifyHookdeckSignature({
        rawBody: tampered,
        secret: SECRET,
        signatures: [VECTORS.simple.signature, undefined],
      }).valid,
    ).toBe(false);
  });

  it("rejects a single flipped byte in the signature", () => {
    const flipped = `A${VECTORS.simple.signature.slice(1)}`;
    expect(
      verifyHookdeckSignature({
        rawBody: body,
        secret: SECRET,
        signatures: [flipped, undefined],
      }).valid,
    ).toBe(false);
  });

  it("treats an absent secret as failure, never a bypass", () => {
    expect(
      verifyHookdeckSignature({
        rawBody: body,
        secret: "",
        signatures: [VECTORS.simple.signature, undefined],
      }).valid,
    ).toBe(false);
  });

  it("rejects when no signature header is present at all", () => {
    expect(
      verifyHookdeckSignature({
        rawBody: body,
        secret: SECRET,
        signatures: [undefined, undefined],
      }).valid,
    ).toBe(false);
  });

  it("tolerates surrounding whitespace in the header value", () => {
    expect(
      verifyHookdeckSignature({
        rawBody: body,
        secret: SECRET,
        signatures: [`  ${VECTORS.simple.signature}  `, undefined],
      }).valid,
    ).toBe(true);
  });

  it("verifies a body whose bytes survive a latin1 round-trip", () => {
    // OpenClaw's own body helper returns a decoded string, not a Buffer. If we
    // ever fall back to it, `latin1` is the only encoding that round-trips
    // arbitrary bytes — this proves the fallback is byte-faithful.
    const original = Buffer.from(VECTORS.unicode.body, "utf8");
    const roundTripped = Buffer.from(original.toString("latin1"), "latin1");
    expect(roundTripped.equals(original)).toBe(true);
    expect(
      verifyHookdeckSignature({
        rawBody: roundTripped,
        secret: SECRET,
        signatures: [VECTORS.unicode.signature, undefined],
      }).valid,
    ).toBe(true);
  });

  it("does NOT verify when the body is re-serialised from parsed JSON", () => {
    // Why we read raw bytes rather than using the host's JSON helper: whitespace
    // is not preserved, so the HMAC no longer matches.
    const reserialised = Buffer.from(
      JSON.stringify(JSON.parse('{"hello": "world"}')),
      "utf8",
    );
    expect(
      verifyHookdeckSignature({
        rawBody: reserialised,
        secret: SECRET,
        signatures: [
          computeHookdeckSignature(
            Buffer.from('{"hello": "world"}', "utf8"),
            SECRET,
          ),
          undefined,
        ],
      }).valid,
    ).toBe(false);
  });
});

describe("timingSafeEqualString", () => {
  it("is true for equal strings", () => {
    expect(timingSafeEqualString("abc123", "abc123")).toBe(true);
  });

  it("is false for different strings of equal length", () => {
    expect(timingSafeEqualString("abc123", "abc124")).toBe(false);
  });

  it("is false for different lengths without throwing", () => {
    expect(timingSafeEqualString("abc", "abcdef")).toBe(false);
    expect(timingSafeEqualString("abcdef", "abc")).toBe(false);
  });

  it("handles empty strings", () => {
    expect(timingSafeEqualString("", "")).toBe(true);
    expect(timingSafeEqualString("", "a")).toBe(false);
  });
});

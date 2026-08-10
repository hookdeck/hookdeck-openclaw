import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Hookdeck signs the raw request body with the project-level signing secret:
 *
 *   base64( HMAC-SHA256( raw_body_bytes, signing_secret ) )
 *
 * The secret is project-level, not per-connection. No timestamp is signed, so
 * the signature carries no replay protection on its own — deduplication is what
 * provides that, and it is mandatory rather than optional.
 *
 * Everything here is pure and operates on bytes. The raw body must be the exact
 * octets Hookdeck sent: re-serialising parsed JSON will not reproduce them.
 */

export function computeHookdeckSignature(rawBody: Buffer, secret: string): string {
  return createHmac("sha256", secret).update(rawBody).digest("base64");
}

/** Constant-time string comparison that tolerates unequal lengths. */
export function timingSafeEqualString(a: string, b: string): boolean {
  const bufA = Buffer.from(a, "utf8");
  const bufB = Buffer.from(b, "utf8");
  // timingSafeEqual throws on length mismatch. Compare against a same-length
  // copy of `a` so the comparison still runs, then AND in the length check —
  // the branch depends only on lengths, which are not secret for a fixed-size
  // base64 digest.
  const sameLength = bufA.length === bufB.length;
  const probe = sameLength ? bufB : bufA;
  return timingSafeEqual(bufA, probe) && sameLength;
}

export interface VerifyHookdeckSignatureParams {
  rawBody: Buffer;
  secret: string;
  /**
   * Candidate signatures, in header order: the primary `x-hookdeck-signature`
   * plus `x-hookdeck-signature-2` when present.
   *
   * The second slot carries the PREVIOUS secret during a rolling rotation.
   * Rejecting it drops live traffic mid-roll, so both slots are always checked.
   */
  signatures: readonly (string | undefined)[];
}

export interface SignatureVerification {
  valid: boolean;
  /** Which slot matched, for diagnostics. 0 = primary, 1 = rotation slot. */
  matchedSlot?: number;
}

export function verifyHookdeckSignature(
  params: VerifyHookdeckSignatureParams,
): SignatureVerification {
  const { rawBody, secret, signatures } = params;

  // An absent or empty secret is a failure, never a bypass.
  if (!secret) return { valid: false };

  const expected = computeHookdeckSignature(rawBody, secret);

  let matchedSlot: number | undefined;
  // Check every slot rather than short-circuiting, so timing does not reveal
  // which slot matched.
  for (const [slot, candidate] of signatures.entries()) {
    if (typeof candidate !== "string" || candidate.length === 0) continue;
    if (timingSafeEqualString(expected, candidate.trim()) && matchedSlot === undefined) {
      matchedSlot = slot;
    }
  }

  return matchedSlot === undefined ? { valid: false } : { valid: true, matchedSlot };
}

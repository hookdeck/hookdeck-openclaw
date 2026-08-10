/**
 * Parsing of the headers Hookdeck attaches to a delivered request.
 *
 * The `x-hookdeck` prefix is white-labelable per project, so every prefixed
 * header name is derived from config rather than hardcoded. `Idempotency-Key`
 * is NOT prefixed — Hookdeck sets it to the event id — so it serves as a
 * fallback identity when a custom prefix is misconfigured.
 */

export const DEFAULT_HEADER_PREFIX = "x-hookdeck";

export type AttemptTrigger =
  | "INITIAL"
  | "AUTOMATIC"
  | "MANUAL"
  | "BULK_RETRY"
  | "UNPAUSE"
  | "UNKNOWN";

export interface HookdeckDelivery {
  /** Stable across every attempt of one event. Primary identity. */
  eventId?: string;
  /** Stable across REPLAYS, which mint a new event id. Secondary identity. */
  requestId?: string;
  /** Which try this is. Drives the admission rule. */
  attemptCount?: number;
  attemptTrigger: AttemptTrigger;
  /**
   * True when `…-will-retry-after` is absent or empty, meaning Hookdeck will
   * not automatically retry after this attempt. The dead-letter trigger.
   */
  isLastAutomaticAttempt: boolean;
  sourceName?: string;
  connectionName?: string;
  /** Hookdeck's own source-verification result, if the source verifies. */
  verified?: boolean;
  /** Primary signature slot first, rotation slot second. */
  signatures: (string | undefined)[];
  /** True when the request carries at least one Hookdeck signature header. */
  looksLikeHookdeck: boolean;
}

export type HeaderBag = Record<string, string | string[] | undefined>;

function readHeader(headers: HeaderBag, name: string): string | undefined {
  const raw = headers[name.toLowerCase()];
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function parsePositiveInt(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
}

const KNOWN_TRIGGERS = new Set<AttemptTrigger>([
  "INITIAL",
  "AUTOMATIC",
  "MANUAL",
  "BULK_RETRY",
  "UNPAUSE",
]);

export function parseHookdeckDelivery(
  headers: HeaderBag,
  prefix: string = DEFAULT_HEADER_PREFIX,
): HookdeckDelivery {
  const p = prefix.replace(/-+$/, "").toLowerCase();
  const h = (suffix: string) => readHeader(headers, `${p}-${suffix}`);

  const primarySignature = h("signature");
  const rotationSignature = h("signature-2");

  // Note the header is `…-eventid`, with no separator before "id" — unlike
  // `…-attempt-count`. Getting this wrong silently disables deduplication,
  // so `Idempotency-Key` backstops it.
  const eventId = h("eventid") ?? readHeader(headers, "idempotency-key");

  const triggerRaw = h("attempt-trigger")?.toUpperCase();
  const attemptTrigger: AttemptTrigger =
    triggerRaw && KNOWN_TRIGGERS.has(triggerRaw as AttemptTrigger)
      ? (triggerRaw as AttemptTrigger)
      : "UNKNOWN";

  const verifiedRaw = h("verified");

  return {
    eventId,
    requestId: h("requestid"),
    attemptCount: parsePositiveInt(h("attempt-count")),
    attemptTrigger,
    // Absent OR empty both mean "no further automatic attempt". readHeader
    // already collapses an empty string to undefined.
    isLastAutomaticAttempt: h("will-retry-after") === undefined,
    sourceName: h("source-name"),
    connectionName: h("connection-name"),
    verified: verifiedRaw === undefined ? undefined : verifiedRaw === "true",
    signatures: [primarySignature, rotationSignature],
    looksLikeHookdeck: primarySignature !== undefined || rotationSignature !== undefined,
  };
}

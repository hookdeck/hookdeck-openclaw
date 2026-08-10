import type { SecretInput } from "./config-types.js";

/**
 * Secret resolution.
 *
 * Resolved per use, never cached, so rotating a secret takes effect without a
 * Gateway restart — the same behaviour the built-in Webhooks plugin was patched
 * to adopt.
 */

export interface HostSecretResolution {
  value?: string | undefined;
  /** Populated when a secretRef could not be resolved, for diagnostics. */
  reason?: string;
}

export type HostSecretResolver = (
  value: unknown,
  relativeConfigPath: string,
) => Promise<HostSecretResolution>;

export function isSecretRef(
  value: unknown,
): value is Extract<SecretInput, { source: string }> {
  return (
    typeof value === "object" &&
    value !== null &&
    "source" in value &&
    typeof (value as { source: unknown }).source === "string"
  );
}

export class UnresolvedSecretError extends Error {
  constructor(
    readonly configPath: string,
    reason?: string,
  ) {
    super(
      `Secret at '${configPath}' did not resolve to a string${reason ? ` (${reason})` : ""}. ` +
        `Refusing to continue — computing an HMAC over an unresolved secretRef would fail ` +
        `every signature check and surface as a misleading 401.`,
    );
    this.name = "UnresolvedSecretError";
  }
}

/**
 * Resolves a secret and asserts the result really is a string.
 *
 * The assertion earns its place: if the manifest's
 * `configContracts.secretInputs.paths` does not cover a path, the raw
 * `{source, provider, id}` object comes back instead. Silently HMAC-ing over
 * that produces a mismatch on every request and looks exactly like a wrong
 * signing secret, sending the operator hunting in the wrong place.
 */
export async function resolveSecret(
  input: SecretInput | undefined,
  relativeConfigPath: string,
  host: HostSecretResolver,
): Promise<string | undefined> {
  if (input === undefined) return undefined;

  if (typeof input === "string") {
    return input.length > 0 ? input : undefined;
  }

  const resolved = await host(input, relativeConfigPath);
  if (resolved.value === undefined || resolved.value === null) {
    // A secretRef that did not resolve is a config problem, not corruption.
    // Returning undefined lets the caller answer with a retryable 503.
    return undefined;
  }
  if (typeof resolved.value !== "string" || isSecretRef(resolved.value)) {
    throw new UnresolvedSecretError(relativeConfigPath, resolved.reason);
  }
  return resolved.value.length > 0 ? resolved.value : undefined;
}

/** Redacts a secret-shaped value bound for a log line or a tool result. */
export function redact(value: string | undefined): string {
  if (!value) return "(unset)";
  if (value.length <= 8) return "***";
  return `${value.slice(0, 4)}…${value.slice(-2)}`;
}

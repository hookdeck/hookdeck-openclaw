/**
 * Restart backoff for a supervised child process.
 *
 * Jitter matters more than usual here: one child per route means several
 * listeners restart together after a network blip, and without jitter they
 * reconnect in lockstep forever.
 */
export interface BackoffOptions {
  initialDelayMs?: number;
  maxDelayMs?: number;
  factor?: number;
  /** Fraction of the delay to randomise by, e.g. 0.2 for ±20%. */
  jitter?: number;
  /** Continuous connected time after which the counter resets. */
  healthyResetMs?: number;
  /** Give up after this many consecutive failures. Unlimited when omitted. */
  maxConsecutiveFailures?: number;
  random?(): number;
}

export interface Backoff {
  readonly failures: number;
  /** Delay for the next restart, or `undefined` once we have given up. */
  next(): number | undefined;
  /**
   * Called when the child has been connected long enough to count as healthy.
   * Returns whether that reset the counter, which is also the answer to "was
   * that run a success?" — the supervisor needs it to tell a standing failure
   * from ordinary churn.
   */
  markHealthy(connectedForMs: number): boolean;
  reset(): void;
}

export function createBackoff(options: BackoffOptions = {}): Backoff {
  const initial = options.initialDelayMs ?? 1_000;
  const max = options.maxDelayMs ?? 30_000;
  const factor = options.factor ?? 2;
  const jitter = options.jitter ?? 0.2;
  const healthyResetMs = options.healthyResetMs ?? 60_000;
  const random = options.random ?? Math.random;

  let failures = 0;

  return {
    get failures() {
      return failures;
    },

    next() {
      if (
        options.maxConsecutiveFailures !== undefined &&
        failures >= options.maxConsecutiveFailures
      ) {
        return undefined;
      }
      const base = Math.min(max, initial * factor ** failures);
      failures += 1;
      // Symmetric jitter, then clamped: applying it after the cap lets the
      // upper half of the spread exceed maxDelayMs, so the documented maximum
      // is not one.
      const spread = base * jitter;
      const delay = Math.round(base - spread + random() * spread * 2);
      return Math.min(max, Math.max(0, delay));
    },

    markHealthy(connectedForMs) {
      if (connectedForMs < healthyResetMs) return false;
      failures = 0;
      return true;
    },

    reset() {
      failures = 0;
    },
  };
}

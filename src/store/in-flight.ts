/**
 * Local admission control.
 *
 * In CLI transport this is the ONLY limit that exists, because CLI destinations
 * carry no `rate_limit` field — so it is load-bearing rather than
 * belt-and-braces. (`rate_limit_period: "concurrent"` is available on HTTP and
 * Mock API destinations only.)
 *
 * Distinct from pausing a connection, deliberately. This is per-event and
 * automatic: at capacity we answer 503 and Hookdeck redelivers that single
 * event on its own schedule, spreading load. Pausing is an operator action for
 * a planned or diagnosed outage, and unpausing releases the whole accumulated
 * backlog at once — which is the wrong response to transient load.
 */
export interface InFlightRegistry {
  readonly size: number;
  readonly capacity: number;
  has(eventId: string): boolean;
  acquire(eventId: string): boolean;
  release(eventId: string): void;
}

export function createInFlightRegistry(
  maxConcurrent: number,
): InFlightRegistry {
  const active = new Set<string>();
  return {
    get size() {
      return active.size;
    },
    get capacity() {
      return maxConcurrent;
    },
    has(eventId) {
      return active.has(eventId);
    },
    acquire(eventId) {
      if (active.size >= maxConcurrent || active.has(eventId)) return false;
      active.add(eventId);
      return true;
    },
    release(eventId) {
      active.delete(eventId);
    },
  };
}

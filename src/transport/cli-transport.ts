import type { Logger } from "../ingress/handler.js";
import { scrubSecrets } from "../plugin/secrets.js";
import { createBackoff, type BackoffOptions } from "./backoff.js";

/**
 * Supervises one `hookdeck listen` child per route.
 *
 * `hookdeck listen` can forward several sources at once, but `--path` takes a
 * single value per invocation. Since each route has its own ingress path,
 * multiplexing would collapse them onto one path and leave the source-name
 * header as the only way to tell routes apart. One child per route keeps the
 * routing key and the provisioned connections aligned.
 *
 * Two flags are not optional in practice:
 *
 *  - `--output compact`. The default is a full-screen interactive UI that exits
 *    immediately when stdout is not a TTY, so a supervisor piping it into a log
 *    sees a process that dies within a second and restarts forever, with the
 *    backoff disguising misconfiguration as flakiness.
 *  - the API key via `env`, never argv, because argv is world-readable in `ps`.
 *
 * One command is deliberately never run: `hookdeck ci --api-key`. It looks like
 * an idempotent login but rewrites the CLI's global config, swaps the stored
 * key for a session key, and switches the active project — which can leave a
 * developer pointed at the wrong project with the original key unrecoverable.
 * Authentication is the operator's business, not a side effect of starting a
 * gateway.
 */

export interface ChildHandle {
  kill(signal?: NodeJS.Signals): void;
  onLine(cb: (line: string) => void): void;
  onExit(cb: (code: number | null, signal: string | null) => void): void;
}

export type SpawnChild = (
  command: string,
  args: readonly string[],
  env: Record<string, string>,
) => ChildHandle;

export type TransportState =
  "stopped" | "starting" | "connected" | "restarting" | "failed";

export interface CliListenerOptions {
  routeId: string;
  source: string;
  /** Gateway port the CLI forwards to. */
  port: number;
  /** Full destination path, e.g. `/hookdeck/stripe`. */
  path: string;
  binaryPath: string;
  apiKey?: string | undefined;
  extraArgs?: readonly string[];
  readinessPattern?: RegExp;
  readinessTimeoutMs?: number;
  backoff?: BackoffOptions;
  /** SIGTERM grace before SIGKILL. */
  terminateGraceMs?: number;
}

export interface CliListenerDeps {
  spawn: SpawnChild;
  logger: Logger;
  /** Written on every exit — the only durable evidence of an outage window. */
  onDisconnect(routeId: string): void | Promise<void>;
  onConnected?(routeId: string): void | Promise<void>;
  now?(): number;
  setTimer?(fn: () => void, ms: number): { cancel(): void };
}

export interface CliListener {
  readonly state: TransportState;
  readonly restarts: number;
  /** Last lines of child output, for `status` — diagnosable without shelling out. */
  recentOutput(): string[];
  start(): void;
  stop(): Promise<void>;
}

// Word-bounded: an unanchored `ready` matches "address already in use", which
// would report a failed launch as connected and reset the backoff counter.
export const DEFAULT_READINESS = /\b(connected|ready|listening|forwarding)\b/i;
const RING_SIZE = 50;

/**
 * Consecutive failed runs before the supervisor says so loudly.
 *
 * A tunnel that cannot stay up restarts forever at `warn`, which reads as
 * routine churn — meanwhile nothing is reaching the Gateway at all. Three is
 * enough to distinguish a genuine standing failure from a blip.
 */
const ESCALATE_AFTER = 3;

/**
 * Recognisable causes, so the escalation names the fix rather than the symptom.
 *
 * `no connection found matching filter` is the signature of the CLI and the API
 * key pointing at different projects: provisioning created the connection in
 * one, and `hookdeck listen` is looking for it in the other.
 */
function likelyCause(output: readonly string[]): string | undefined {
  const text = output.join("\n");
  if (/no connection found matching filter/i.test(text)) {
    return (
      "the CLI is probably logged into a different Hookdeck project than the configured API key, " +
      "so the connection provisioning created is not visible to `hookdeck listen`. Run hookdeck_doctor, " +
      "which compares the two."
    );
  }
  if (/unauthor|authentication failed|invalid.*key/i.test(text)) {
    return "the CLI session looks unauthenticated or expired. Run `hookdeck login`.";
  }
  return undefined;
}

export function buildListenArgs(options: CliListenerOptions): string[] {
  return [
    "listen",
    String(options.port),
    options.source,
    "--path",
    options.path,
    // Not cosmetic: the interactive default exits without a TTY.
    "--output",
    "compact",
    ...(options.extraArgs ?? []),
  ];
}

export function createCliListener(
  options: CliListenerOptions,
  deps: CliListenerDeps,
): CliListener {
  const now = deps.now ?? Date.now;
  const setTimer =
    deps.setTimer ??
    ((fn: () => void, ms: number) => {
      const t = setTimeout(fn, ms);
      t.unref?.();
      return { cancel: () => clearTimeout(t) };
    });

  const backoff = createBackoff(options.backoff);
  const readiness = options.readinessPattern ?? DEFAULT_READINESS;
  const ring: string[] = [];

  let state: TransportState = "stopped";
  let child: ChildHandle | undefined;
  let stopping = false;
  let restarts = 0;
  let connectedAt: number | undefined;
  let readinessTimer: { cancel(): void } | undefined;
  let restartTimer: { cancel(): void } | undefined;
  let shortRuns = 0;
  let escalated = false;

  /**
   * Scrubs a line of child output once, at the boundary, so every consumer
   * takes it from here: the ring buffer `hookdeck_status` exposes, the debug
   * log, and the readiness match. Scrubbing further downstream would leave one
   * of those printing the raw line.
   */
  function sanitise(line: string): string {
    return scrubSecrets(line, [options.apiKey]);
  }

  function record(line: string): void {
    ring.push(sanitise(line));
    if (ring.length > RING_SIZE) ring.shift();
  }

  function launch(): void {
    state = "starting";
    connectedAt = undefined;

    const env: Record<string, string> = {};
    // Via env, never argv: argv is world-readable in `ps`.
    if (options.apiKey !== undefined) env.HOOKDECK_API_KEY = options.apiKey;

    const args = buildListenArgs(options);
    deps.logger.debug(
      `[${options.routeId}] ${options.binaryPath} ${args.join(" ")}`,
    );

    let handle: ChildHandle;
    try {
      handle = deps.spawn(options.binaryPath, args, env);
    } catch (err) {
      record(
        `spawn failed: ${err instanceof Error ? err.message : String(err)}`,
      );
      scheduleRestart();
      return;
    }
    child = handle;

    readinessTimer = setTimer(() => {
      if (state !== "starting") return;
      deps.logger.warn(
        `[${options.routeId}] no connection banner within the readiness timeout; restarting`,
      );
      handle.kill("SIGTERM");
      // Escalated, as `stop()` does. A child that ignores SIGTERM would
      // otherwise sit there un-restarted with the supervisor waiting on an
      // exit that never comes.
      setTimer(() => {
        if (child === handle) handle.kill("SIGKILL");
      }, options.terminateGraceMs ?? 5_000);
    }, options.readinessTimeoutMs ?? 20_000);

    handle.onLine((raw) => {
      const line = sanitise(raw);
      record(line);
      deps.logger.debug(`[${options.routeId}] ${line}`);
      if (state === "starting" && readiness.test(line)) {
        state = "connected";
        connectedAt = now();
        readinessTimer?.cancel();
        void deps.onConnected?.(options.routeId);
        deps.logger.info(`[${options.routeId}] tunnel connected`);
      }
    });

    handle.onExit((code, signal) => {
      readinessTimer?.cancel();
      child = undefined;
      const wasConnected = connectedAt !== undefined;
      const ranForMs = wasConnected ? now() - connectedAt! : 0;

      // A run that never reached the connection banner, or held it only
      // briefly, is a failure to stay up rather than ordinary churn. Taken from
      // `markHealthy` rather than from the failure count, which has not yet been
      // incremented for this exit.
      const healthy = wasConnected && backoff.markHealthy(ranForMs);
      if (healthy) {
        shortRuns = 0;
        escalated = false;
      } else {
        shortRuns += 1;
      }

      // Written on EVERY exit, crash or clean: it is the only durable evidence
      // of the outage window, and a catch-up query has nothing to bound
      // without it.
      void deps.onDisconnect(options.routeId);

      if (stopping) {
        state = "stopped";
        return;
      }
      record(`exited code=${code ?? "null"} signal=${signal ?? "none"}`);
      deps.logger.warn(
        `[${options.routeId}] listener exited (code ${code ?? "null"})`,
      );

      // Once per streak, not per restart: the point is to break out of the
      // routine-churn reading, which repeating it would undo.
      if (shortRuns >= ESCALATE_AFTER && !escalated) {
        escalated = true;
        const tail = ring.slice(-5);
        const cause = likelyCause(ring);
        deps.logger.warn(
          `[${options.routeId}] TUNNEL DOWN: failed to stay up ${shortRuns} times in a row` +
            `${wasConnected ? ` (last run ${Math.round(ranForMs / 1000)}s)` : " (never connected)"}. ` +
            `No events are reaching the Gateway for this route.` +
            (cause !== undefined ? ` Likely cause: ${cause}` : "") +
            (tail.length > 0 ? ` Last output: ${tail.join(" | ")}` : ""),
        );
      }

      scheduleRestart();
    });
  }

  function scheduleRestart(): void {
    const delay = backoff.next();
    if (delay === undefined) {
      state = "failed";
      deps.logger.warn(
        `[${options.routeId}] giving up after ${backoff.failures} consecutive failures; ` +
          `ingress still serves, but nothing is being forwarded`,
      );
      return;
    }
    state = "restarting";
    restarts += 1;
    restartTimer = setTimer(() => {
      if (!stopping) launch();
    }, delay);
  }

  return {
    get state() {
      return state;
    },
    get restarts() {
      return restarts;
    },

    recentOutput() {
      return [...ring];
    },

    start() {
      if (state !== "stopped" && state !== "failed") return;
      stopping = false;
      backoff.reset();
      launch();
    },

    async stop() {
      stopping = true;
      readinessTimer?.cancel();
      restartTimer?.cancel();
      const handle = child;
      if (handle === undefined) {
        state = "stopped";
        return;
      }
      // Bound our own teardown: the host applies no per-service stop timeout,
      // so a hanging child would block Gateway shutdown indefinitely.
      //
      // The exit listener goes on BEFORE the signal. A child that exits
      // promptly would otherwise do so before anything was listening, and
      // teardown would then wait out the whole grace period before SIGKILLing
      // a process that had already gone.
      await new Promise<void>((resolve) => {
        let settled = false;
        const finish = (): void => {
          if (settled) return;
          settled = true;
          resolve();
        };

        const grace = setTimer(() => {
          handle.kill("SIGKILL");
          finish();
        }, options.terminateGraceMs ?? 5_000);

        handle.onExit(() => {
          grace.cancel();
          finish();
        });

        handle.kill("SIGTERM");
      });
      state = "stopped";
    },
  };
}

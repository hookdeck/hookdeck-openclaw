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
      if (wasConnected) backoff.markHealthy(now() - connectedAt!);

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

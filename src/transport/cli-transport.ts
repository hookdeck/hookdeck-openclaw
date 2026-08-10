import type { Logger } from "../ingress/handler.js";
import { createBackoff, type BackoffOptions } from "./backoff.js";

/**
 * Supervises one `hookdeck listen` child per route.
 *
 * One child per route is forced by the CLI: the source is a required positional
 * and each process forwards exactly one source.
 *
 * Two flags are not optional in practice:
 *
 *  - `--output compact`. The default is a full-screen interactive UI that exits
 *    immediately when stdout is not a TTY. A supervisor piping it into a log
 *    gets a process that dies after ~1s and restarts forever, with the backoff
 *    disguising misconfiguration as flakiness.
 *  - the API key via `env`, never argv, because argv is world-readable in `ps`.
 *
 * And one command is deliberately never run: `hookdeck ci --api-key`. It looks
 * like an idempotent login and is not — it rewrites the CLI's global config,
 * swaps the stored key for a session key, and switches the active project. A
 * sibling plugin shipped that and silently repointed a developer's CLI away
 * from another project, leaving the original key unrecoverable. Authentication
 * is the operator's business, not a side effect of starting a gateway.
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

const DEFAULT_READINESS = /connected|ready|listening|forwarding/i;
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

  function record(line: string): void {
    ring.push(line);
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
      if (state === "starting") {
        deps.logger.warn(
          `[${options.routeId}] no connection banner within the readiness timeout; restarting`,
        );
        handle.kill("SIGTERM");
      }
    }, options.readinessTimeoutMs ?? 20_000);

    handle.onLine((line) => {
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
      handle.kill("SIGTERM");
      // Bound our own teardown: the host applies no per-service stop timeout,
      // so a hanging child would block Gateway shutdown indefinitely.
      await new Promise<void>((resolve) => {
        const grace = setTimer(() => {
          handle.kill("SIGKILL");
          resolve();
        }, options.terminateGraceMs ?? 5_000);
        handle.onExit(() => {
          grace.cancel();
          resolve();
        });
      });
      state = "stopped";
    },
  };
}

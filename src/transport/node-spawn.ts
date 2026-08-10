import { spawn as nodeSpawn, execFile } from "node:child_process";
import { delimiter, join } from "node:path";
import { access, constants } from "node:fs/promises";
import { promisify } from "node:util";
import type { ChildHandle, SpawnChild } from "./cli-transport.js";

const execFileAsync = promisify(execFile);

/**
 * Real child-process transport. Kept behind the `SpawnChild` interface so the
 * supervisor's logic — readiness, backoff, teardown — is testable without ever
 * launching a process.
 */
export const nodeSpawnChild: SpawnChild = (command, args, env): ChildHandle => {
  const child = nodeSpawn(command, [...args], {
    // The key arrives here, never in argv, because argv is world-readable.
    env: { ...process.env, ...env },
    stdio: ["ignore", "pipe", "pipe"],
    detached: false,
  });

  const lineCbs: ((line: string) => void)[] = [];
  const exitCbs: ((code: number | null, signal: string | null) => void)[] = [];

  // The CLI writes progress to both streams; line-buffer each independently.
  for (const stream of [child.stdout, child.stderr]) {
    let buffer = "";
    stream?.setEncoding("utf8");
    stream?.on("data", (chunk: string) => {
      buffer += chunk;
      let index = buffer.indexOf("\n");
      while (index !== -1) {
        const line = buffer.slice(0, index).trimEnd();
        buffer = buffer.slice(index + 1);
        if (line.length > 0) lineCbs.forEach((cb) => cb(line));
        index = buffer.indexOf("\n");
      }
    });
    stream?.on("end", () => {
      // A child that dies mid-line still said something worth keeping.
      const rest = buffer.trimEnd();
      buffer = "";
      if (rest.length > 0) lineCbs.forEach((cb) => cb(rest));
    });
  }

  let exited = false;
  const reportExit = (code: number | null, signal: string | null): void => {
    if (exited) return;
    exited = true;
    exitCbs.forEach((cb) => cb(code, signal));
  };

  // `error` fires WITHOUT an `exit` for ENOENT, EACCES and EAGAIN — a missing
  // or unreadable binary. The supervisor restarts from exits alone, so without
  // this it would wait in `starting` forever and never record the disconnect.
  child.on("error", (err) => {
    lineCbs.forEach((cb) => cb(`spawn error: ${err.message}`));
    reportExit(null, null);
  });
  child.on("exit", (code, signal) => reportExit(code, signal));

  return {
    kill: (signal) => {
      try {
        child.kill(signal ?? "SIGTERM");
      } catch {
        // Already gone.
      }
    },
    onLine: (cb) => lineCbs.push(cb),
    onExit: (cb) => exitCbs.push(cb),
  };
};

/**
 * Finds every `hookdeck` on PATH, in precedence order.
 *
 * Resolved explicitly rather than trusting the shell, because a shadowed binary
 * silently defeats the version gate: an npm-global 2.3.0-beta.1 shim masking a
 * Homebrew 2.4.0 means the check inspects one binary and the tunnel launches
 * another.
 */
export async function findBinaries(
  name: string,
  pathEnv = process.env.PATH ?? "",
): Promise<string[]> {
  const found: string[] = [];
  for (const dir of pathEnv.split(delimiter).filter((d) => d.length > 0)) {
    const candidate = join(dir, name);
    try {
      await access(candidate, constants.X_OK);
      if (!found.includes(candidate)) found.push(candidate);
    } catch {
      // Not here, or not executable.
    }
  }
  return found;
}

export async function readCliVersion(binaryPath: string): Promise<string> {
  const { stdout, stderr } = await execFileAsync(binaryPath, ["version"], {
    timeout: 10_000,
  });
  return `${stdout}\n${stderr}`.trim();
}

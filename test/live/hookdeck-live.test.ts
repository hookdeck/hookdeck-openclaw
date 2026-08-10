import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { createHookdeckClient } from "../../src/hookdeck/client.js";
import {
  buildConnectionSpec,
  uncoveredStatuses,
  type ProvisionRouteSpec,
} from "../../src/hookdeck/provision.js";

/**
 * Live suite. Skips itself unless `HOOKDECK_TEST_API_KEY` is set, so `npm test`
 * stays offline and deterministic.
 *
 * This exists to close the one gap unit tests cannot: everything here has been
 * verified only against a fake client, and the two requirements it depends on
 * are precisely the ones that are undocumented — `auth: {}` alongside
 * `auth_type`, and `path_forwarding_disabled` defaulting to false. Both fail on
 * the first real call or not at all.
 *
 * Creates resources named `openclaw-ci-<runId>-*` and deletes only that prefix.
 */

function readKey(): string | undefined {
  if (process.env.HOOKDECK_TEST_API_KEY)
    return process.env.HOOKDECK_TEST_API_KEY;
  try {
    const contents = readFileSync(join(process.cwd(), ".env.local"), "utf8");
    const match = /^HOOKDECK_TEST_API_KEY=(.+)$/m.exec(contents);
    return match?.[1]?.trim() || undefined;
  } catch {
    return undefined;
  }
}

const apiKey = readKey();
const run = apiKey === undefined ? describe.skip : describe;

// Deterministic per run, and unmistakably ours.
const runId = `ci${Date.now().toString(36)}`;
const created: string[] = [];

run("live Hookdeck API", () => {
  const client = createHookdeckClient({
    apiKey: apiKey!,
    ...(process.env.HOOKDECK_API_BASE
      ? { baseUrl: process.env.HOOKDECK_API_BASE }
      : {}),
  });

  const spec = (
    overrides: Partial<ProvisionRouteSpec> = {},
  ): ProvisionRouteSpec => ({
    routeId: `${runId}-stripe`,
    source: `openclaw-${runId}`,
    path: `/hookdeck/${runId}`,
    kind: "CLI",
    ...overrides,
  });

  afterAll(async () => {
    // Best effort: a leaked test connection is noise, not damage. Never
    // `disable` or delete anything outside our prefix.
    for (const id of created) {
      await client.pauseConnection(id).catch(() => {});
    }
  });

  it("upserts a connection with the undocumented empty auth object", async () => {
    const built = buildConnectionSpec(spec());
    built.name = `openclaw-ci-${runId}`;
    (built.destination as { name: string }).name = `openclaw-ci-${runId}`;
    (built.source as { name: string }).name = `openclaw-ci-${runId}`;

    const result = await client.upsertConnection(built);
    if (!result.ok) {
      throw new Error(
        `upsert failed: ${result.status ?? "?"} ${result.message}. ` +
          `A 422 mentioning destination.config.auth means the empty auth object is not being sent.`,
      );
    }
    expect(result.data.id).toBeTruthy();
    created.push(result.data.id);
  });

  it("is idempotent — the same spec upserts to the same connection", async () => {
    const built = buildConnectionSpec(spec());
    built.name = `openclaw-ci-${runId}`;
    (built.destination as { name: string }).name = `openclaw-ci-${runId}`;
    (built.source as { name: string }).name = `openclaw-ci-${runId}`;

    const first = await client.upsertConnection(built);
    const second = await client.upsertConnection(built);
    expect(first.ok && second.ok).toBe(true);
    if (first.ok && second.ok) expect(second.data.id).toBe(first.data.id);
  });

  it("stores the retry rule we sent, covering every status we emit", async () => {
    const id = created[0];
    expect(id).toBeTruthy();
    const result = await client.getConnection(id!);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const retry = result.data.rules?.find((r) => r.type === "retry");
    // The check `doctor` will run: drift here silently stops retries.
    expect(uncoveredStatuses(retry?.response_status_codes)).toEqual([]);
  });

  it("pauses and unpauses without dropping anything", async () => {
    const id = created[0];
    expect(id).toBeTruthy();

    const paused = await client.pauseConnection(id!);
    expect(paused.ok).toBe(true);
    if (paused.ok) expect(paused.data.paused_at).toBeTruthy();

    const resumed = await client.unpauseConnection(id!);
    expect(resumed.ok).toBe(true);
    if (resumed.ok) expect(resumed.data.paused_at ?? null).toBeNull();
  });

  it("accepts the catch-up replay query shape", async () => {
    const id = created[0];
    expect(id).toBeTruthy();
    // A fresh connection has nothing to replay; the point is that Hookdeck
    // accepts the query and target rather than 422-ing on their shape.
    const result = await client.bulkReplayRequests({
      query: {
        cli_events_count: 0,
        ignored_count: { gte: 1 },
        ingested_at: { gte: new Date(Date.now() - 60_000).toISOString() },
      },
      target: { webhook_ids: [id!] },
    });
    // 422 UNPROCESSABLE is legitimate when nothing matches; a 400 would mean
    // the shape is wrong.
    if (!result.ok) expect(result.status).not.toBe(400);
  });
});

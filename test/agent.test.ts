import { describe, expect, it, vi } from "vitest";
import {
  createAgentDispatcher,
  renderSessionKey,
  type AgentDispatchOptions,
  type AgentRunner,
} from "../src/dispatch/agent.js";
import type { EventRetrier } from "../src/hookdeck/client.js";
import { parseHookdeckDelivery } from "../src/protocol/delivery.js";
import { TRUST_HINT } from "../src/protocol/template.js";
import { createDeadLetterLog } from "../src/store/deadletter.js";
import { createMemoryLedger } from "../src/store/ledger.js";

const delivery = parseHookdeckDelivery({
  "x-hookdeck-signature": "sig",
  "x-hookdeck-eventid": "evt_1",
  "x-hookdeck-source-name": "stripe",
  "x-hookdeck-attempt-count": "1",
});

const silent = { debug: () => {}, info: () => {}, warn: () => {} };

const baseOptions: AgentDispatchOptions = {
  sessionKey: "hook:{routeId}",
  prompt: "Triage {{payload.type}}.",
  ackMode: "async_retry",
  syncTimeoutSeconds: 1,
  maxAgentRetries: 2,
  deliver: false,
  maxConcurrentRuns: 4,
  busyRetryAfterSeconds: 10,
};

/** A runner that can observe completion, like the subagent transport. */
function fakeRunner(overrides: Partial<AgentRunner> = {}): AgentRunner {
  return {
    start: vi.fn(async () => ({ ok: true as const, handle: "run_1" })),
    waitFor: vi.fn(async () => ({ status: "ok" as const })),
    ...overrides,
  };
}

async function harness(
  options: Partial<AgentDispatchOptions> = {},
  runner: AgentRunner = fakeRunner(),
  client?: EventRetrier,
) {
  const ledger = createMemoryLedger({ ttlHours: 168, instanceId: "test" });
  const deadLetter = await createDeadLetterLog({ ttlHours: 168 });
  await ledger.begin("evt_1", 1, { routeId: "stripe" });

  const dispatcher = createAgentDispatcher(
    { ...baseOptions, ...options },
    { runner, ledger, deadLetter, logger: silent, client },
  );
  return { dispatcher, ledger, deadLetter, runner };
}

const ctx = { routeId: "stripe", delivery, payload: { type: "invoice.paid" } };

/** The background settle is fire-and-forget; let the microtask queue drain. */
const settled = () => new Promise((resolve) => setTimeout(resolve, 10));

describe("renderSessionKey", () => {
  it("substitutes placeholders", () => {
    expect(
      renderSessionKey("hook:{routeId}:{eventId}", {
        routeId: "s",
        eventId: "evt_1",
      }),
    ).toBe("hook:s:evt_1");
  });

  it("sanitises to a boring alphabet, since keys reach the host verbatim", () => {
    const key = renderSessionKey("a/../b {x}", { routeId: "r" });
    expect(key).toBe("a----b--x-");
    // What actually matters: no path traversal, no whitespace, no braces.
    expect(key).not.toMatch(/[^A-Za-z0-9:_-]/);
  });

  it("neutralises a payload-derived key that tries to escape", () => {
    const key = renderSessionKey("hook:{eventId}", {
      routeId: "r",
      eventId: "../../etc/passwd",
    });
    expect(key).not.toContain("/");
    expect(key).not.toContain("..");
  });

  it("caps the length", () => {
    expect(renderSessionKey("x".repeat(500), { routeId: "r" }).length).toBe(
      200,
    );
  });
});

describe("agent dispatch — prompt construction", () => {
  it("hands the runner a rendered prompt with the payload as encoded data", async () => {
    const { dispatcher, runner } = await harness();
    await dispatcher.dispatch(ctx);
    const call = (runner.start as ReturnType<typeof vi.fn>).mock.calls[0];
    const prompt = String((call?.[0] as { prompt: string }).prompt);
    expect(prompt).toContain('Triage "invoice.paid".');
    expect(prompt).toContain("untrusted data");
  });

  it("passes the rendered session key and event id", async () => {
    const { dispatcher, runner } = await harness();
    await dispatcher.dispatch(ctx);
    expect(runner.start).toHaveBeenCalledWith(
      expect.objectContaining({ sessionKey: "hook:stripe", eventId: "evt_1" }),
    );
  });
});

describe("agent dispatch — async_retry", () => {
  it("acknowledges 202 while the run is still going, and settles only when it ends", async () => {
    // The run must genuinely block: with an instantly-resolving fake the
    // background settle wins the race and the "still running" window is
    // unobservable, which would make this assertion meaningless rather than
    // wrong.
    let finish!: () => void;
    const running = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const subagent = fakeRunner({
      waitFor: vi.fn(async () => {
        await running;
        return { status: "ok" as const };
      }),
    });
    const { dispatcher, ledger } = await harness({}, subagent);

    const outcome = await dispatcher.dispatch(ctx);
    expect(outcome.plan.status).toBe(202);
    expect(outcome.settle).toBe("deferred");
    // Still `running`: settling now would tell the next boot the work
    // completed, and a crash mid-run would go unrecovered.
    expect(ledger.get("evt_1")?.status).toBe("running");

    finish();
    await settled();
    expect(ledger.get("evt_1")?.status).toBe("succeeded");
  });

  it("settles succeeded once the background run completes", async () => {
    const { dispatcher, ledger } = await harness();
    await dispatcher.dispatch(ctx);
    await settled();
    expect(ledger.get("evt_1")?.status).toBe("succeeded");
  });

  it("asks Hookdeck to redeliver when the run fails", async () => {
    const subagent = fakeRunner({
      waitFor: vi.fn(async () => ({
        status: "error" as const,
        error: "model exploded",
      })),
    });
    const client: EventRetrier = {
      retryEvent: vi.fn(async (eventId: string) => ({
        ok: true as const,
        data: { eventId },
      })),
    };
    const { dispatcher, ledger } = await harness({}, subagent, client);

    await dispatcher.dispatch(ctx);
    await settled();

    expect(client.retryEvent).toHaveBeenCalledWith("evt_1");
    expect(ledger.get("evt_1")).toMatchObject({
      status: "failed",
      agentRetries: 1,
    });
  });

  it("exhausts rather than looping once the retry budget is spent", async () => {
    const subagent = fakeRunner({
      waitFor: vi.fn(async () => ({
        status: "error" as const,
        error: "still broken",
      })),
    });
    const client: EventRetrier = {
      retryEvent: vi.fn(async (eventId: string) => ({
        ok: true as const,
        data: { eventId },
      })),
    };
    const { dispatcher, ledger, deadLetter } = await harness(
      { maxAgentRetries: 1 },
      subagent,
      client,
    );

    await dispatcher.dispatch(ctx);
    await settled();
    expect(ledger.get("evt_1")?.agentRetries).toBe(1);

    // A redelivery arrives and fails again; now over budget.
    await dispatcher.dispatch(ctx);
    await settled();

    expect(ledger.get("evt_1")?.status).toBe("exhausted");
    expect(deadLetter.list()[0]).toMatchObject({ code: "agent_run_failed" });
    expect(client.retryEvent).toHaveBeenCalledTimes(1);
  });

  it("dead-letters without an API key rather than silently dropping", async () => {
    const subagent = fakeRunner({
      waitFor: vi.fn(async () => ({ status: "error" as const, error: "nope" })),
    });
    const { dispatcher, ledger, deadLetter } = await harness({}, subagent);

    await dispatcher.dispatch(ctx);
    await settled();

    expect(ledger.get("evt_1")?.status).toBe("exhausted");
    expect(deadLetter.list()[0]?.reason).toMatch(/no API key/);
  });
});

describe("agent dispatch — sync", () => {
  it("holds the response and answers 200 on success", async () => {
    const { dispatcher, ledger } = await harness({ ackMode: "sync" });
    const outcome = await dispatcher.dispatch(ctx);

    expect(outcome.plan.status).toBe(200);
    expect(outcome.settle).toBe("succeeded");
    expect(ledger.get("evt_1")?.status).toBe("running"); // handler settles it
  });

  it("answers a retryable 500 when the run fails", async () => {
    const subagent = fakeRunner({
      waitFor: vi.fn(async () => ({ status: "error" as const, error: "boom" })),
    });
    const { dispatcher } = await harness({ ackMode: "sync" }, subagent);
    const outcome = await dispatcher.dispatch(ctx);

    expect(outcome.plan.status).toBe(500);
    expect(outcome.settle).toBe("failed");
  });

  it("DEGRADES to 202 on timeout rather than 5xx", async () => {
    // A 5xx would redeliver work that is still running.
    // First wait hits the sync deadline; the run then finishes in the
    // background. A fake that always times out would instead exercise the
    // hour-long background wait, which is a different case.
    let call = 0;
    const subagent = fakeRunner({
      waitFor: vi.fn(async () => {
        call += 1;
        return call === 1
          ? { status: "timeout" as const }
          : { status: "ok" as const };
      }),
    });
    const { dispatcher, ledger } = await harness({ ackMode: "sync" }, subagent);
    const outcome = await dispatcher.dispatch(ctx);

    expect(outcome.plan.status).toBe(202);
    expect(outcome.settle).toBe("deferred");

    // The background waiter takes ownership and settles once it really finishes.
    await settled();
    expect(ledger.get("evt_1")?.status).toBe("succeeded");
  });

  it("recovers a sync-timeout run that later fails, via the same retry path", async () => {
    let call = 0;
    const subagent = fakeRunner({
      waitFor: vi.fn(async () => {
        call += 1;
        return call === 1
          ? { status: "timeout" as const }
          : { status: "error" as const, error: "died later" };
      }),
    });
    const client: EventRetrier = {
      retryEvent: vi.fn(async (eventId: string) => ({
        ok: true as const,
        data: { eventId },
      })),
    };
    const { dispatcher } = await harness({ ackMode: "sync" }, subagent, client);

    await dispatcher.dispatch(ctx);
    await settled();

    expect(client.retryEvent).toHaveBeenCalledWith("evt_1");
  });

  it("passes the configured timeout to the host", async () => {
    const { dispatcher, runner } = await harness({
      ackMode: "sync",
      syncTimeoutSeconds: 30,
    });
    await dispatcher.dispatch(ctx);
    expect(runner.waitFor).toHaveBeenCalledWith("run_1", 30_000);
  });
});

describe("agent dispatch — admission control", () => {
  it("defers with 503 once concurrent runs hit the cap", async () => {
    // The handler's in-flight registry releases its slot the moment we return
    // 202, so without this counter maxConcurrent would stop applying exactly
    // where it matters most.
    let release!: () => void;
    const blocked = new Promise<void>((r) => {
      release = r;
    });
    const subagent = fakeRunner({
      waitFor: vi.fn(async () => {
        await blocked;
        return { status: "ok" as const };
      }),
    });
    const { dispatcher } = await harness({ maxConcurrentRuns: 1 }, subagent);

    const first = await dispatcher.dispatch(ctx);
    expect(first.plan.status).toBe(202);

    const second = await dispatcher.dispatch(ctx);
    expect(second.plan.status).toBe(503);
    expect(second.plan.code).toBe("busy");
    expect(second.plan.retry).toEqual({ kind: "after", seconds: 10 });
    // `failed`, not `deferred`. The handler checks `canAccept` before writing a
    // row, so normally nothing is recorded at all — but if this guard is
    // reached, a row already exists and `deferred` would leave it `running`
    // with no background run to settle it.
    expect(second.settle).toBe("failed");

    release();
    await settled();
  });

  it("frees the slot after a run completes", async () => {
    const { dispatcher } = await harness({ maxConcurrentRuns: 1 });
    await dispatcher.dispatch(ctx);
    await settled();
    const second = await dispatcher.dispatch(ctx);
    expect(second.plan.status).toBe(202);
  });

  it("frees the slot when starting the run throws", async () => {
    const subagent = fakeRunner({
      start: vi.fn(async () => ({
        ok: false as const,
        retryable: true,
        message: "gateway busy",
      })),
    });
    const { dispatcher } = await harness({ maxConcurrentRuns: 1 }, subagent);

    const outcome = await dispatcher.dispatch(ctx);
    expect(outcome.plan.status).toBe(503);
    expect(outcome.plan.code).toBe("agent_start_failed");
    // Retryable with no fixed interval: exponential backoff paces it.
    expect(outcome.plan.retry).toEqual({ kind: "none" });

    const second = await dispatcher.dispatch(ctx);
    expect(second.plan.code).toBe("agent_start_failed");
  });
});

describe("agent dispatch — a runner that cannot observe completion", () => {
  // The TaskFlow transport starts a task but exposes no completion promise.
  // The contract is explicit that a host without a completion hook should say
  // so rather than fake it, so there is nothing to wait on and no run-outcome
  // retry — Hookdeck's job (durable delivery) is done, and run durability
  // belongs to the flow record from there.
  const blindRunner = (): AgentRunner => ({
    start: vi.fn(async () => ({ ok: true as const, handle: "flw_1" })),
  });

  it("acknowledges 202 and settles immediately", async () => {
    const { dispatcher, ledger } = await harness({}, blindRunner());
    const outcome = await dispatcher.dispatch(ctx);

    expect(outcome.plan.status).toBe(202);
    expect(outcome.settle).toBe("succeeded");
    await settled();
    // Nothing left running: the row is not an orphan for the next boot.
    expect(ledger.listOrphans()).toHaveLength(0);
  });

  it("frees its concurrency slot rather than leaking it", async () => {
    const { dispatcher } = await harness(
      { maxConcurrentRuns: 1 },
      blindRunner(),
    );
    await dispatcher.dispatch(ctx);
    const second = await dispatcher.dispatch(ctx);
    expect(second.plan.status).toBe(202);
  });

  it("still reports a failed start as retryable", async () => {
    const runner: AgentRunner = {
      start: vi.fn(async () => ({
        ok: false as const,
        retryable: true,
        message: "no flow",
      })),
    };
    const { dispatcher } = await harness({}, runner);
    const outcome = await dispatcher.dispatch(ctx);
    expect(outcome.plan.status).toBe(503);
    expect(outcome.plan.code).toBe("agent_start_failed");
  });
});

describe("the in-dispatch capacity guard must not strand the row", () => {
  it("settles rather than deferring, so recovery can see it", async () => {
    const { dispatcher, ledger } = await harness({ maxConcurrentRuns: 0 });
    await ledger.begin(ctx.delivery.eventId!, 1);

    const outcome = await dispatcher.dispatch(ctx);

    expect(outcome.plan.status).toBe(503);
    expect(outcome.settle).toBe("failed");
  });
});

describe("the concurrency slot has exactly one owner", () => {
  it("releases it when the runner throws", async () => {
    // The handler turns a runner throw into a retryable response, so the throw
    // is survivable — which is precisely why a leaked slot here would go
    // unnoticed until the route stopped accepting anything.
    const runner = fakeRunner({
      start: vi.fn(async () => {
        throw new Error("host went away");
      }),
    });
    const { dispatcher } = await harness({ maxConcurrentRuns: 1 }, runner);

    await expect(dispatcher.dispatch(ctx)).rejects.toThrow("host went away");
    expect(dispatcher.canAccept?.()).toBe(true);
  });

  it("stays acceptable after repeated runner throws", async () => {
    const runner = fakeRunner({
      start: vi.fn(async () => {
        throw new Error("boom");
      }),
    });
    const { dispatcher } = await harness({ maxConcurrentRuns: 2 }, runner);

    for (let i = 0; i < 5; i += 1) {
      await dispatcher.dispatch(ctx).catch(() => {});
    }
    expect(dispatcher.canAccept?.()).toBe(true);
  });

  it("releases it when the runner refuses to start", async () => {
    const runner = fakeRunner({
      start: vi.fn(async () => ({
        ok: false as const,
        retryable: true,
        message: "no flow",
      })),
    });
    const { dispatcher } = await harness({ maxConcurrentRuns: 1 }, runner);

    await dispatcher.dispatch(ctx);
    expect(dispatcher.canAccept?.()).toBe(true);
  });

  it("releases it when the transport cannot observe completion", async () => {
    const { dispatcher } = await harness(
      { maxConcurrentRuns: 1 },
      fakeRunner({ waitFor: undefined }),
    );
    await dispatcher.dispatch(ctx);
    expect(dispatcher.canAccept?.()).toBe(true);
  });
});

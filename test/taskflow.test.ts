import { describe, expect, it, vi } from "vitest";
import { createTaskFlowDispatcher } from "../src/dispatch/taskflow.js";
import { parseTaskFlowEnvelope } from "../src/protocol/envelope.js";
import { parseHookdeckDelivery } from "../src/protocol/delivery.js";
import type {
  BoundTaskFlowRuntime,
  TaskFlowMutationResult,
} from "../src/plugin/host-api.js";

const delivery = parseHookdeckDelivery({
  "x-hookdeck-signature": "sig",
  "x-hookdeck-eventid": "evt_1",
});

function fakeFlows(
  overrides: Partial<BoundTaskFlowRuntime> = {},
): BoundTaskFlowRuntime {
  const applied: TaskFlowMutationResult = {
    applied: true,
    flow: { flowId: "flw_1", revision: 2 },
  };
  return {
    tryCreateManaged: vi.fn(() => ({ flowId: "flw_1" })),
    get: vi.fn(() => ({ flowId: "flw_1" })),
    list: vi.fn(() => []),
    findLatest: vi.fn(() => ({ flowId: "flw_1" })),
    resolve: vi.fn(() => ({ flowId: "flw_1" })),
    getTaskSummary: vi.fn(() => ({})),
    setWaiting: vi.fn(() => applied),
    resume: vi.fn(() => applied),
    finish: vi.fn(() => applied),
    fail: vi.fn(() => applied),
    requestCancel: vi.fn(() => applied),
    cancel: vi.fn(async () => ({ cancelled: true })),
    runTask: vi.fn(() => ({ created: true })),
    ...overrides,
  };
}

function dispatcher(flows: BoundTaskFlowRuntime, allowedActions?: string[]) {
  return createTaskFlowDispatcher(
    {
      controllerId: "hookdeck/stripe",
      ...(allowedActions ? { allowedActions } : {}),
    },
    () => flows,
  );
}

async function run(
  flows: BoundTaskFlowRuntime,
  payload: unknown,
  allowed?: string[],
) {
  return dispatcher(flows, allowed).dispatch({
    routeId: "stripe",
    delivery,
    payload,
  });
}

describe("envelope parsing", () => {
  it("accepts a well-formed envelope", () => {
    expect(
      parseTaskFlowEnvelope({ action: "create_flow", goal: "ship it" }).ok,
    ).toBe(true);
  });

  it("rejects an unknown action", () => {
    expect(parseTaskFlowEnvelope({ action: "explode" }).ok).toBe(false);
  });

  it("requires expectedRevision on mutators", () => {
    expect(
      parseTaskFlowEnvelope({ action: "finish_flow", flowId: "flw_1" }).ok,
    ).toBe(false);
  });

  it("reports readable errors", () => {
    const result = parseTaskFlowEnvelope({ action: "create_flow" });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.join()).toContain("goal");
  });
});

describe("taskflow dispatch — the status taxonomy", () => {
  it("applies a mutation and reports the new revision", async () => {
    const outcome = await run(fakeFlows(), {
      action: "finish_flow",
      flowId: "flw_1",
      expectedRevision: 1,
    });
    expect(outcome.settle).toBe("succeeded");
    expect(outcome.plan.status).toBe(200);
    expect(outcome.plan.message).toContain("revision 2");
  });

  it("CANCELS retries on a revision conflict", async () => {
    // expectedRevision is baked into the stored request and revisions only
    // increase, so a retry of this exact envelope can never succeed.
    const flows = fakeFlows({
      finish: vi.fn(() => ({
        applied: false as const,
        code: "revision_conflict",
        current: { revision: 7 },
      })),
    });
    const outcome = await run(flows, {
      action: "finish_flow",
      flowId: "flw_1",
      expectedRevision: 1,
    });

    expect(outcome.plan.status).toBe(409);
    expect(outcome.plan.retry).toEqual({
      kind: "cancel",
      reason: "flow_revision_conflict",
    });
    // The caller needs the current revision to correct and re-send.
    expect(outcome.plan.message).toContain("7");
  });

  it("does NOT cancel on not_found — the flow may not exist yet", async () => {
    const flows = fakeFlows({
      resume: vi.fn(() => ({ applied: false as const, code: "not_found" })),
    });
    const outcome = await run(flows, {
      action: "resume_flow",
      flowId: "flw_x",
      expectedRevision: 1,
    });

    expect(outcome.plan.status).toBe(404);
    expect(outcome.plan.retry).toEqual({ kind: "none" });
  });

  it("cancels when the flow is not managed by this controller", async () => {
    const flows = fakeFlows({
      fail: vi.fn(() => ({ applied: false as const, code: "not_managed" })),
    });
    const outcome = await run(flows, {
      action: "fail_flow",
      flowId: "flw_1",
      expectedRevision: 1,
    });
    expect(outcome.plan.retry).toEqual({
      kind: "cancel",
      reason: "flow_not_managed",
    });
  });

  it("defers briefly on persist_failed, which is genuinely transient", async () => {
    const flows = fakeFlows({
      setWaiting: vi.fn(() => ({
        applied: false as const,
        code: "persist_failed",
      })),
    });
    const outcome = await run(flows, {
      action: "set_waiting",
      flowId: "flw_1",
      expectedRevision: 1,
    });
    expect(outcome.plan.status).toBe(503);
    expect(outcome.plan.retry).toEqual({ kind: "after", seconds: 15 });
  });

  it("answers 202 when a cancel is pending on active children", async () => {
    const flows = fakeFlows({
      cancel: vi.fn(async () => ({
        cancelled: false,
        reason: "One or more child tasks are still active.",
      })),
    });
    const outcome = await run(flows, {
      action: "cancel_flow",
      flowId: "flw_1",
    });
    expect(outcome.plan.status).toBe(202);
    expect(outcome.settle).toBe("succeeded");
  });

  it("cancels retries on an invalid envelope", async () => {
    const outcome = await run(fakeFlows(), { action: "finish_flow" });
    expect(outcome.plan.status).toBe(400);
    expect(outcome.plan.retry).toEqual({
      kind: "cancel",
      reason: "invalid_envelope",
    });
  });

  it("cancels retries on a disallowed action", async () => {
    const outcome = await run(
      fakeFlows(),
      { action: "cancel_flow", flowId: "flw_1" },
      ["create_flow"],
    );
    expect(outcome.plan.status).toBe(403);
    expect(outcome.plan.retry).toEqual({
      kind: "cancel",
      reason: "forbidden_action",
    });
  });

  it("allows an action on the allowlist", async () => {
    const outcome = await run(
      fakeFlows(),
      { action: "create_flow", goal: "g" },
      ["create_flow"],
    );
    expect(outcome.plan.status).toBe(200);
  });
});

describe("taskflow dispatch — creates and reads", () => {
  it("creates a flow with the route's controllerId", async () => {
    const flows = fakeFlows();
    await run(flows, { action: "create_flow", goal: "ship it" });
    expect(flows.tryCreateManaged).toHaveBeenCalledWith(
      expect.objectContaining({
        controllerId: "hookdeck/stripe",
        goal: "ship it",
      }),
    );
  });

  it("lets an envelope override the controllerId", async () => {
    const flows = fakeFlows();
    await run(flows, {
      action: "create_flow",
      goal: "g",
      controllerId: "other",
    });
    expect(flows.tryCreateManaged).toHaveBeenCalledWith(
      expect.objectContaining({ controllerId: "other" }),
    );
  });

  it("defers when a flow cannot be persisted", async () => {
    const flows = fakeFlows({ tryCreateManaged: vi.fn(() => null) });
    const outcome = await run(flows, { action: "create_flow", goal: "g" });
    expect(outcome.plan.status).toBe(503);
  });

  it("answers 200 for a read of an absent flow, since that is an answer", async () => {
    const flows = fakeFlows({ get: vi.fn(() => undefined) });
    const outcome = await run(flows, { action: "get_flow", flowId: "flw_x" });
    expect(outcome.plan.status).toBe(200);
    expect(outcome.settle).toBe("succeeded");
  });

  it("reports a task that could not be created", async () => {
    const flows = fakeFlows({
      runTask: vi.fn(() => ({
        created: false,
        found: true,
        reason: "flow already finished",
      })),
    });
    const outcome = await run(flows, {
      action: "run_task",
      flowId: "flw_1",
      task: "do it",
    });
    expect(outcome.plan.status).toBe(409);
  });

  it("treats a run_task on a missing flow as retryable 404", async () => {
    const flows = fakeFlows({
      runTask: vi.fn(() => ({
        created: false,
        found: false,
        reason: "no flow",
      })),
    });
    const outcome = await run(flows, {
      action: "run_task",
      flowId: "flw_x",
      task: "do it",
    });
    expect(outcome.plan.status).toBe(404);
    expect(outcome.plan.retry).toEqual({ kind: "none" });
  });
});

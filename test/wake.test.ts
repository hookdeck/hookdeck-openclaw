import { describe, expect, it, vi } from "vitest";
import { createWakeDispatcher, renderWakeText, type SystemRuntime } from "../src/dispatch/wake.js";
import { parseHookdeckDelivery } from "../src/protocol/delivery.js";

function delivery(overrides: Record<string, string> = {}) {
  return parseHookdeckDelivery({
    "x-hookdeck-signature": "sig",
    "x-hookdeck-eventid": "evt_1",
    "x-hookdeck-source-name": "stripe",
    ...overrides,
  });
}

function fakeSystem(overrides: Partial<SystemRuntime> = {}) {
  return {
    enqueueSystemEvent: vi.fn(() => true),
    requestHeartbeat: vi.fn(),
    ...overrides,
  } satisfies SystemRuntime;
}

describe("renderWakeText", () => {
  it("substitutes the supported placeholders", () => {
    expect(
      renderWakeText("{source} sent {eventId} on {routeId}", {
        routeId: "r",
        source: "stripe",
        eventId: "evt_1",
      }),
    ).toBe("stripe sent evt_1 on r");
  });

  it("falls back to the route id when the source is unknown", () => {
    expect(renderWakeText("{source}", { routeId: "r" })).toBe("r");
  });

  it("leaves unknown placeholders alone", () => {
    expect(renderWakeText("{whatever}", { routeId: "r" })).toBe("{whatever}");
  });
});

describe("createWakeDispatcher", () => {
  it("enqueues a system event against the configured session", async () => {
    const system = fakeSystem();
    const dispatcher = createWakeDispatcher(
      { mode: "wake", sessionKey: "hook:stripe" },
      system,
    );

    const result = await dispatcher.dispatch({ routeId: "stripe", delivery: delivery() });

    expect(result).toEqual({ ok: true });
    expect(system.enqueueSystemEvent).toHaveBeenCalledWith("Webhook received from stripe", {
      sessionKey: "hook:stripe",
    });
  });

  it("requests an immediate heartbeat for wakeMode 'now'", async () => {
    const system = fakeSystem();
    await createWakeDispatcher(
      { mode: "wake", sessionKey: "s", wakeMode: "now" },
      system,
    ).dispatch({ routeId: "stripe", delivery: delivery() });

    expect(system.requestHeartbeat).toHaveBeenCalledWith({
      source: "hook",
      intent: "immediate",
      reason: "hookdeck:stripe",
    });
  });

  it("only enqueues for wakeMode 'next-heartbeat'", async () => {
    const system = fakeSystem();
    await createWakeDispatcher(
      { mode: "wake", sessionKey: "s", wakeMode: "next-heartbeat" },
      system,
    ).dispatch({ routeId: "stripe", delivery: delivery() });

    expect(system.enqueueSystemEvent).toHaveBeenCalledOnce();
    expect(system.requestHeartbeat).not.toHaveBeenCalled();
  });

  it("defaults to 'now' when wakeMode is omitted", async () => {
    const system = fakeSystem();
    await createWakeDispatcher({ mode: "wake", sessionKey: "s" }, system).dispatch({
      routeId: "stripe",
      delivery: delivery(),
    });
    expect(system.requestHeartbeat).toHaveBeenCalledOnce();
  });

  it("treats a suppressed enqueue as success, not a retry", async () => {
    // enqueueSystemEvent returns false for empty text or duplicate suppression.
    // Neither improves on retry.
    const system = fakeSystem({ enqueueSystemEvent: vi.fn(() => false) });
    const result = await createWakeDispatcher({ mode: "wake", sessionKey: "s" }, system).dispatch({
      routeId: "stripe",
      delivery: delivery(),
    });

    expect(result).toEqual({ ok: true, detail: "suppressed" });
    expect(system.requestHeartbeat).not.toHaveBeenCalled();
  });

  it("reports a throwing enqueue as retryable", async () => {
    const system = fakeSystem({
      enqueueSystemEvent: vi.fn(() => {
        throw new Error("no session");
      }),
    });
    const result = await createWakeDispatcher({ mode: "wake", sessionKey: "s" }, system).dispatch({
      routeId: "stripe",
      delivery: delivery(),
    });

    expect(result).toEqual({ ok: false, retryable: true, message: "no session" });
  });

  it("does not retry when only the heartbeat nudge fails", async () => {
    // The event is already queued; retrying would enqueue it twice.
    const system = fakeSystem({
      requestHeartbeat: vi.fn(() => {
        throw new Error("heartbeat busy");
      }),
    });
    const result = await createWakeDispatcher({ mode: "wake", sessionKey: "s" }, system).dispatch({
      routeId: "stripe",
      delivery: delivery(),
    });

    expect(result.ok).toBe(true);
  });
});

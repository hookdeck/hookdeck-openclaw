import { describe, expect, it } from "vitest";
import { parseHookdeckDelivery } from "../src/protocol/delivery.js";

const BASE = {
  "x-hookdeck-signature": "sig-primary",
  "x-hookdeck-eventid": "evt_abc",
  "x-hookdeck-requestid": "req_abc",
  "x-hookdeck-attempt-count": "3",
  "x-hookdeck-attempt-trigger": "AUTOMATIC",
  "x-hookdeck-will-retry-after": "60",
  "x-hookdeck-source-name": "stripe",
  "x-hookdeck-connection-name": "stripe-to-openclaw",
  "x-hookdeck-verified": "true",
};

describe("parseHookdeckDelivery", () => {
  it("parses the documented header set", () => {
    const d = parseHookdeckDelivery(BASE);
    expect(d).toMatchObject({
      eventId: "evt_abc",
      requestId: "req_abc",
      attemptCount: 3,
      attemptTrigger: "AUTOMATIC",
      isLastAutomaticAttempt: false,
      sourceName: "stripe",
      connectionName: "stripe-to-openclaw",
      verified: true,
      looksLikeHookdeck: true,
    });
    expect(d.signatures).toEqual(["sig-primary", undefined]);
  });

  it("reads the event id from '-eventid', with no separator before 'id'", () => {
    // Getting this wrong silently disables deduplication, so it gets its own test.
    expect(parseHookdeckDelivery({ ...BASE, "x-hookdeck-event-id": "wrong" }).eventId).toBe(
      "evt_abc",
    );
  });

  it("falls back to the unprefixed Idempotency-Key when the prefix is misconfigured", () => {
    const d = parseHookdeckDelivery({
      "x-hookdeck-signature": "sig",
      "idempotency-key": "evt_fallback",
    });
    expect(d.eventId).toBe("evt_fallback");
  });

  it("prefers the prefixed event id over Idempotency-Key", () => {
    const d = parseHookdeckDelivery({ ...BASE, "idempotency-key": "evt_other" });
    expect(d.eventId).toBe("evt_abc");
  });

  describe("white-label header prefix", () => {
    it("reads a custom prefix", () => {
      const d = parseHookdeckDelivery(
        {
          "x-acme-signature": "sig",
          "x-acme-eventid": "evt_1",
          "x-acme-attempt-count": "2",
        },
        "x-acme",
      );
      expect(d).toMatchObject({ eventId: "evt_1", attemptCount: 2, looksLikeHookdeck: true });
    });

    it("tolerates a trailing dash in the configured prefix", () => {
      expect(parseHookdeckDelivery({ "x-acme-signature": "s" }, "x-acme-").looksLikeHookdeck).toBe(
        true,
      );
    });

    it("does not see default-prefixed headers when a custom prefix is set", () => {
      const d = parseHookdeckDelivery(BASE, "x-acme");
      expect(d.looksLikeHookdeck).toBe(false);
      // …but Idempotency-Key is unprefixed, so identity can still survive.
      expect(d.eventId).toBeUndefined();
    });
  });

  describe("isLastAutomaticAttempt", () => {
    it("is false when will-retry-after carries a value", () => {
      expect(parseHookdeckDelivery(BASE).isLastAutomaticAttempt).toBe(false);
    });

    it("is true when the header is absent", () => {
      const { "x-hookdeck-will-retry-after": _omit, ...rest } = BASE;
      expect(parseHookdeckDelivery(rest).isLastAutomaticAttempt).toBe(true);
    });

    it("is true when the header is present but empty", () => {
      expect(
        parseHookdeckDelivery({ ...BASE, "x-hookdeck-will-retry-after": "" })
          .isLastAutomaticAttempt,
      ).toBe(true);
    });

    it("is true when the header is whitespace only", () => {
      expect(
        parseHookdeckDelivery({ ...BASE, "x-hookdeck-will-retry-after": "   " })
          .isLastAutomaticAttempt,
      ).toBe(true);
    });
  });

  describe("attempt trigger", () => {
    for (const trigger of ["INITIAL", "AUTOMATIC", "MANUAL", "BULK_RETRY", "UNPAUSE"]) {
      it(`recognises ${trigger}`, () => {
        expect(
          parseHookdeckDelivery({ ...BASE, "x-hookdeck-attempt-trigger": trigger }).attemptTrigger,
        ).toBe(trigger);
      });
    }

    it("normalises case", () => {
      expect(
        parseHookdeckDelivery({ ...BASE, "x-hookdeck-attempt-trigger": "manual" }).attemptTrigger,
      ).toBe("MANUAL");
    });

    it("maps an unknown value to UNKNOWN rather than throwing", () => {
      expect(
        parseHookdeckDelivery({ ...BASE, "x-hookdeck-attempt-trigger": "TELEPORT" })
          .attemptTrigger,
      ).toBe("UNKNOWN");
    });

    it("is UNKNOWN when absent", () => {
      const { "x-hookdeck-attempt-trigger": _omit, ...rest } = BASE;
      expect(parseHookdeckDelivery(rest).attemptTrigger).toBe("UNKNOWN");
    });
  });

  it("captures the rotation signature slot", () => {
    const d = parseHookdeckDelivery({ ...BASE, "x-hookdeck-signature-2": "sig-previous" });
    expect(d.signatures).toEqual(["sig-primary", "sig-previous"]);
  });

  it("reports looksLikeHookdeck false with no signature headers", () => {
    expect(parseHookdeckDelivery({ "content-type": "application/json" }).looksLikeHookdeck).toBe(
      false,
    );
  });

  it("handles array-valued headers", () => {
    expect(parseHookdeckDelivery({ "x-hookdeck-signature": ["a", "b"] }).signatures[0]).toBe("a");
  });

  it("ignores a non-numeric attempt count rather than producing NaN", () => {
    expect(
      parseHookdeckDelivery({ ...BASE, "x-hookdeck-attempt-count": "many" }).attemptCount,
    ).toBeUndefined();
  });

  it("reads verified: false", () => {
    expect(parseHookdeckDelivery({ ...BASE, "x-hookdeck-verified": "false" }).verified).toBe(false);
  });
});

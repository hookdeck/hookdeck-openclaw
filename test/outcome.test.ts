import { describe, expect, it } from "vitest";
import {
  CANCEL_REASONS,
  cancelRetries,
  isRetryableStatus,
  ok,
  planToBody,
  renderRetryAfterHeader,
  deferFor,
  retryable,
  RETRYABLE_STATUS_CODES,
  RETRYABLE_STATUSES,
} from "../src/protocol/outcome.js";

describe("renderRetryAfterHeader", () => {
  it("omits the header when there is no directive", () => {
    expect(
      renderRetryAfterHeader(ok("done"), { allowRetryCancel: true }),
    ).toBeUndefined();
  });

  it("renders whole seconds", () => {
    expect(
      renderRetryAfterHeader(deferFor(503, "busy", 30), {
        allowRetryCancel: false,
      }),
    ).toBe("30");
  });

  it("rounds and floors at zero", () => {
    expect(
      renderRetryAfterHeader(deferFor(503, "busy", 1.4), {
        allowRetryCancel: false,
      }),
    ).toBe("1");
    expect(
      renderRetryAfterHeader(deferFor(503, "busy", -5), {
        allowRetryCancel: false,
      }),
    ).toBe("0");
  });

  it("renders -1 for a cancellation when enabled", () => {
    expect(
      renderRetryAfterHeader(cancelRetries("malformed_json", 400), {
        allowRetryCancel: true,
      }),
    ).toBe("-1");
  });

  it("DEGRADES a cancellation to no header when the kill switch is off", () => {
    // The default. With it off, wire behaviour matches the sibling Hermes and
    // n8n plugins exactly — Hookdeck's own retry rules stay in force.
    expect(
      renderRetryAfterHeader(cancelRetries("malformed_json", 400), {
        allowRetryCancel: false,
      }),
    ).toBeUndefined();
  });
});

describe("cancelRetries", () => {
  it("always dead-letters — if Hookdeck stops trying, the payload must survive locally", () => {
    for (const reason of CANCEL_REASONS) {
      expect(cancelRetries(reason, 400).deadLetter).toBe(true);
    }
  });

  it("carries the reason as the response code", () => {
    expect(cancelRetries("too_large", 413).code).toBe("too_large");
  });

  it("does not include any reason a config change could fix", () => {
    // The rule that keeps events recoverable: a missing secret, an unresolvable
    // secretRef or a storage failure must stay retryable.
    const forbidden = [
      "no_signing_secret",
      "unresolved_secret",
      "state_write_failed",
      "dispatch_failed",
      "busy",
      "internal_error",
    ];
    for (const reason of forbidden) {
      expect(CANCEL_REASONS as readonly string[]).not.toContain(reason);
    }
  });
});

describe("isRetryableStatus", () => {
  it.each([
    [200, false],
    [202, false],
    [400, true],
    [401, true],
    [404, true],
    [408, true],
    [409, true],
    [413, false],
    [415, false],
    [429, true],
    [500, true],
    [503, true],
    [599, true],
  ])("status %i -> retryable %s", (status, expected) => {
    expect(isRetryableStatus(status)).toBe(expected);
  });

  it("covers every status the pipeline emits as retryable", () => {
    // Two halves of one contract. Drift is silent data loss: we answer 404
    // expecting a redelivery, the rule does not cover 404, the event is gone,
    // and nothing records that a choice was made.
    for (const status of RETRYABLE_STATUSES) {
      expect(isRetryableStatus(status)).toBe(true);
    }
  });

  it("expresses the provisioned rule in Hookdeck's own form", () => {
    // Asserted against the derived list rather than a literal, so adding a
    // retryable status cannot silently change what this test claims to check.
    for (const status of RETRYABLE_STATUSES) {
      const covered =
        RETRYABLE_STATUS_CODES.includes(String(status)) ||
        (status >= 500 && RETRYABLE_STATUS_CODES.includes("500-599"));
      expect(
        covered,
        `status ${status} is not in the provisioned retry rule`,
      ).toBe(true);
    }
  });

  it("excludes 413, whose limit is a plugin constant rather than operator config", () => {
    expect(RETRYABLE_STATUS_CODES).not.toContain("413");
  });
});

describe("planToBody", () => {
  it("marks 2xx as ok", () => {
    expect(JSON.parse(planToBody(ok("dispatched")))).toEqual({
      ok: true,
      code: "dispatched",
    });
  });

  it("marks 4xx and 5xx as not ok", () => {
    expect(
      JSON.parse(planToBody(retryable(503, "dispatch_failed", "boom"))),
    ).toEqual({
      ok: false,
      code: "dispatch_failed",
      message: "boom",
    });
  });

  it("merges extra fields", () => {
    expect(
      JSON.parse(
        planToBody(ok("duplicate"), { duplicate: true, eventId: "evt_1" }),
      ),
    ).toEqual({
      ok: true,
      code: "duplicate",
      duplicate: true,
      eventId: "evt_1",
    });
  });
});

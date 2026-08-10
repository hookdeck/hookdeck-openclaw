import { describe, expect, it } from "vitest";
import {
  decideAdmission,
  isPrunable,
  type LedgerRow,
  type LedgerStatus,
} from "../src/protocol/admission.js";

function row(status: LedgerStatus, attempt: number): LedgerRow {
  return { eventId: "evt_1", attempt, runCount: 1, status, updatedAt: 1_000 };
}

describe("decideAdmission — shared contract §3", () => {
  it("admits a first delivery", () => {
    expect(decideAdmission(undefined, 1)).toEqual({ admit: true, reason: "first_delivery" });
  });

  it("admits when the attempt number advances", () => {
    // THE case this rule exists for: Hookdeck redelivers a FAILED event under
    // the SAME event id. Deduplicating on identity alone would block it.
    expect(decideAdmission(row("failed", 1), 2)).toEqual({
      admit: true,
      reason: "attempt_advanced",
    });
  });

  it("admits a retry of an event still marked running", () => {
    // A crash mid-dispatch leaves `running`. The redelivery has a higher
    // attempt number and must be allowed through.
    expect(decideAdmission(row("running", 1), 2).admit).toBe(true);
  });

  it("rejects a repeat of the same attempt number", () => {
    expect(decideAdmission(row("succeeded", 3), 3)).toEqual({
      admit: false,
      reason: "already_succeeded",
    });
  });

  it("rejects an attempt number that goes backwards", () => {
    expect(decideAdmission(row("succeeded", 5), 2).admit).toBe(false);
  });

  it("reports in_flight distinctly for a duplicate of a running attempt", () => {
    expect(decideAdmission(row("running", 2), 2)).toEqual({ admit: false, reason: "in_flight" });
  });

  it("reports exhausted distinctly", () => {
    expect(decideAdmission(row("exhausted", 4), 4)).toEqual({ admit: false, reason: "exhausted" });
  });

  describe("with no attempt header", () => {
    it("admits only when the previous run failed", () => {
      expect(decideAdmission(row("failed", 1), undefined)).toEqual({
        admit: true,
        reason: "previous_failed",
      });
    });

    it("rejects when the previous run succeeded", () => {
      expect(decideAdmission(row("succeeded", 1), undefined).admit).toBe(false);
    });

    it("rejects when the previous run is still in flight", () => {
      expect(decideAdmission(row("running", 1), undefined)).toEqual({
        admit: false,
        reason: "in_flight",
      });
    });

    it("rejects when exhausted — we gave up deliberately", () => {
      expect(decideAdmission(row("exhausted", 1), undefined).admit).toBe(false);
    });
  });
});

describe("isPrunable", () => {
  const ttl = 1000;

  it("never prunes a running row, however old", () => {
    expect(isPrunable(row("running", 1), 1_000_000, ttl)).toBe(false);
  });

  it("prunes a terminal row past its TTL", () => {
    expect(isPrunable(row("succeeded", 1), 1_000 + ttl + 1, ttl)).toBe(true);
  });

  it("keeps a terminal row inside its TTL", () => {
    expect(isPrunable(row("succeeded", 1), 1_000 + ttl - 1, ttl)).toBe(false);
  });
});

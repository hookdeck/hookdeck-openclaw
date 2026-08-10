import { describe, expect, it } from "vitest";
import { evaluateFilters } from "../src/protocol/filters.js";

const payload = {
  type: "invoice.paid",
  livemode: true,
  data: { amount: 4200 },
  note: null,
};

describe("evaluateFilters", () => {
  it("matches when there are no filters", () => {
    expect(evaluateFilters(undefined, payload).matched).toBe(true);
    expect(evaluateFilters([], payload).matched).toBe(true);
  });

  it("matches on equality", () => {
    expect(
      evaluateFilters([{ path: "type", equals: "invoice.paid" }], payload)
        .matched,
    ).toBe(true);
    expect(
      evaluateFilters([{ path: "type", equals: "charge.failed" }], payload)
        .matched,
    ).toBe(false);
  });

  it("matches booleans and numbers, not just strings", () => {
    expect(
      evaluateFilters([{ path: "livemode", equals: true }], payload).matched,
    ).toBe(true);
    expect(
      evaluateFilters([{ path: "data.amount", equals: 4200 }], payload).matched,
    ).toBe(true);
  });

  it("matches on membership", () => {
    expect(
      evaluateFilters(
        [{ path: "type", in: ["invoice.paid", "invoice.failed"] }],
        payload,
      ).matched,
    ).toBe(true);
    expect(
      evaluateFilters([{ path: "type", in: ["charge.failed"] }], payload)
        .matched,
    ).toBe(false);
  });

  it("matches on presence, treating null as absent", () => {
    expect(
      evaluateFilters([{ path: "data", exists: true }], payload).matched,
    ).toBe(true);
    expect(
      evaluateFilters([{ path: "note", exists: true }], payload).matched,
    ).toBe(false);
    expect(
      evaluateFilters([{ path: "missing", exists: false }], payload).matched,
    ).toBe(true);
  });

  it("requires every filter to pass", () => {
    expect(
      evaluateFilters(
        [
          { path: "type", equals: "invoice.paid" },
          { path: "livemode", equals: false },
        ],
        payload,
      ).matched,
    ).toBe(false);
  });

  it("reports which filter rejected", () => {
    const result = evaluateFilters(
      [{ path: "type", equals: "charge.failed" }],
      payload,
    );
    expect(result.reason).toContain("type");
    expect(result.reason).toContain("charge.failed");
  });

  it("does not match a missing path against a value", () => {
    expect(
      evaluateFilters([{ path: "nope.deep", equals: "x" }], payload).matched,
    ).toBe(false);
  });

  it("inherits the prototype-path guard", () => {
    expect(
      evaluateFilters([{ path: "__proto__", exists: true }], payload).matched,
    ).toBe(false);
  });
});

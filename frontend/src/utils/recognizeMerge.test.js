import { describe, expect, it } from "vitest";
import { mergeRecognizedResults } from "./recognizeMerge";

function baseResult(overrides = {}) {
  return {
    first_name: "JAN",
    last_name: "NOVAK",
    birth_date: "1994-03-12",
    doc_number: "999123456",
    doc_number_verified: true,
    mrz_raw: "",
    warnings: [],
    address: null,
    ...overrides,
  };
}

describe("mergeRecognizedResults — warnings vs addressHint split", () => {
  it("keeps warnings empty and puts a found address only in addressHint (a clean merge, nothing to flag)", () => {
    const merged = mergeRecognizedResults([
      baseResult({ address: "Vinohradská 45, Praha 2" }),
    ]);
    expect(merged.warnings).toEqual([]);
    expect(merged.addressHint).toContain("Vinohradská 45, Praha 2");
  });

  it("leaves addressHint null when no address was found", () => {
    const merged = mergeRecognizedResults([baseResult()]);
    expect(merged.addressHint).toBeNull();
    expect(merged.warnings).toEqual([]);
  });

  it("surfaces a real per-document warning (e.g. failed checksum) in warnings, independent of any address", () => {
    const merged = mergeRecognizedResults([
      baseResult({
        address: "Vinohradská 45, Praha 2",
        warnings: ["Číslo dokladu (999123456) se nepodařilo ověřit kontrolním součtem — zkontrolujte prosím ručně podle fotografie."],
      }),
    ]);
    expect(merged.warnings).toHaveLength(1);
    expect(merged.warnings[0]).toContain("kontrolním součtem");
    expect(merged.addressHint).toContain("Vinohradská 45, Praha 2");
  });

  it("flags a genuine name mismatch between two merged documents as a warning", () => {
    const merged = mergeRecognizedResults(
      [
        baseResult({ first_name: "JAN" }),
        baseResult({ first_name: "JOHN" }),
      ],
      { compactNameWarning: true }
    );
    expect(merged.warnings.length).toBeGreaterThan(0);
    expect(merged.warnings.some((w) => w.includes("Jméno"))).toBe(true);
  });
});

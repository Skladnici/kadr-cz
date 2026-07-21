import { describe, expect, it } from "vitest";
import { isStrpeniVisaCode } from "./visaStatus";

describe("isStrpeniVisaCode", () => {
  it("flags the real Roman Shyshka strpeni code", () => {
    expect(isStrpeniVisaCode("D/SD/91")).toBe(true);
  });

  it("does not flag a different real visa category code (David Hambaryan)", () => {
    expect(isStrpeniVisaCode("D/VR/27")).toBe(false);
  });

  it("returns false for empty/missing input", () => {
    expect(isStrpeniVisaCode("")).toBe(false);
    expect(isStrpeniVisaCode(null)).toBe(false);
    expect(isStrpeniVisaCode(undefined)).toBe(false);
  });

  it("returns false for a malformed code that isn't 3 slash-separated parts", () => {
    expect(isStrpeniVisaCode("SD")).toBe(false);
    expect(isStrpeniVisaCode("D/SD")).toBe(false);
    expect(isStrpeniVisaCode("D/SD/91/extra")).toBe(false);
  });
});

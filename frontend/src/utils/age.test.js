import { describe, expect, it } from "vitest";
import { calculateAge, parseFlexibleDate } from "./age";

// Fixed "today" so results don't depend on when the suite happens to run.
const TODAY = new Date(2026, 6, 17); // 2026-07-17, months are 0-indexed

describe("calculateAge", () => {
  it("flags 17 years 11 months as under 18", () => {
    // Birthday one month from TODAY -> still 17.
    expect(calculateAge("17.08.2008", TODAY)).toBe(17);
  });

  it("does not flag exactly 18 years old (birthday is today)", () => {
    expect(calculateAge("17.07.2008", TODAY)).toBe(18);
  });

  it("does not flag someone turning 18 tomorrow as already 18 (still 17)", () => {
    expect(calculateAge("18.07.2008", TODAY)).toBe(17);
  });

  it("does not flag a 25-year-old", () => {
    expect(calculateAge("17.07.2001", TODAY)).toBe(25);
  });

  it("returns null for an empty field", () => {
    expect(calculateAge("", TODAY)).toBeNull();
    expect(calculateAge(undefined, TODAY)).toBeNull();
  });

  it("returns null for an unparseable value", () => {
    expect(calculateAge("not a date", TODAY)).toBeNull();
  });

  it("returns null for a birth date in the future (typo, not a real minor)", () => {
    expect(calculateAge("17.07.2099", TODAY)).toBeNull();
  });

  it("counts the birthday correctly across a leap-day boundary", () => {
    // Born 29.02.2008 (leap year); by 2026-07-17 they've had their 2026
    // birthday (29.02 already passed this year) -> 18.
    expect(calculateAge("29.02.2008", TODAY)).toBe(18);
  });

  it("accepts DD-MM-YYYY and DD/MM/YYYY as well as DD.MM.YYYY", () => {
    expect(calculateAge("17-07-2008", TODAY)).toBe(18);
    expect(calculateAge("17/07/2008", TODAY)).toBe(18);
  });

  it("accepts ISO-style YYYY-MM-DD (as produced by mock OCR samples)", () => {
    expect(calculateAge("2008-07-17", TODAY)).toBe(18);
  });
});

describe("parseFlexibleDate", () => {
  it("parses all formats mirrored from the backend's _parse_any_date", () => {
    const expected = Date.UTC(1994, 2, 12); // 12.03.1994
    expect(parseFlexibleDate("12.03.1994").getTime()).toBe(expected);
    expect(parseFlexibleDate("12-03-1994").getTime()).toBe(expected);
    expect(parseFlexibleDate("12/03/1994").getTime()).toBe(expected);
    expect(parseFlexibleDate("1994-03-12").getTime()).toBe(expected);
    expect(parseFlexibleDate("1994.03.12").getTime()).toBe(expected);
    expect(parseFlexibleDate("1994/03/12").getTime()).toBe(expected);
  });

  it("accepts single-digit day/month, matching Python's strptime leniency", () => {
    expect(parseFlexibleDate("5.3.1994").getTime()).toBe(Date.UTC(1994, 2, 5));
  });

  it("rejects a calendar-invalid date instead of silently rolling it over", () => {
    expect(parseFlexibleDate("31.02.2024")).toBeNull();
  });

  it("rejects empty and garbage input", () => {
    expect(parseFlexibleDate("")).toBeNull();
    expect(parseFlexibleDate("   ")).toBeNull();
    expect(parseFlexibleDate("hello")).toBeNull();
  });
});

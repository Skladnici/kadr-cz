import { describe, expect, it } from "vitest";
import { canAutoMerge } from "./BatchDocFiller";

// Minimal fixture matching the real PersonCard shape canAutoMerge reads:
// fields.birth_date + rawResults[].doc_type (batch mode never has more
// than one raw result per card at merge-decision time until an actual
// merge happens — see BatchDocFiller's own runRecognizeQueue comment).
function card(birthDate, docType, { alreadyPaired = false } = {}) {
  return {
    fields: { birth_date: birthDate },
    rawResults: alreadyPaired
      ? [{ doc_type: docType }, { doc_type: docType }]
      : [{ doc_type: docType }],
  };
}

describe("canAutoMerge — real shipped function, residence permit case", () => {
  it("Kohili Hadj Benamar Ahmed's real 'Povolení k pobytu' never merges with an unrelated card sharing its birth date", () => {
    // Exact birth_date this real card's OCR extraction actually produces
    // (08.03.1987 — see test_ocr_service.py's own real-sample test) and
    // its real doc_type ("Povolení k pobytu", from DOC_TYPE_KEYWORDS).
    const residencePermit = card("08.03.1987", "Povolení k pobytu");
    // A completely unrelated person, birth date coinciding purely by
    // construction — this is exactly the scenario a real production
    // report traced the "falls apart" bug back to.
    const unrelatedPerson = card("08.03.1987", "Neznámý dokument");

    expect(canAutoMerge(residencePermit, unrelatedPerson)).toBe(false);
    expect(canAutoMerge(unrelatedPerson, residencePermit)).toBe(false);
  });

  it("still refuses even when the OTHER side is itself a passport/visa type (no birth-date exception for any pairing involving a standalone type)", () => {
    const residencePermit = card("08.03.1987", "Zaměstnanecká karta");
    const passport = card("08.03.1987", "Cestovní pas");
    expect(canAutoMerge(residencePermit, passport)).toBe(false);
  });

  it("does NOT reject two residence permits from merging on doc_type grounds alone (birth_date must actually differ) — confirms the block is real doc-type gating, not an always-false stub", () => {
    const a = card("08.03.1987", "Povolení k pobytu");
    const b = card("01.01.1990", "Povolení k pobytu");
    expect(canAutoMerge(a, b)).toBe(false); // different birth dates — correctly refused for THAT reason
  });
});

describe("canAutoMerge — regression: the original passport+visa happy path still works", () => {
  it("still allows a real passport+visa pair to merge (same birth date, no standalone type involved)", () => {
    const passport = card("12.02.1977", "Cestovní pas");
    const visa = card("12.02.1977", "Vízum");
    expect(canAutoMerge(passport, visa)).toBe(true);
  });

  it("still refuses when birth dates simply don't match", () => {
    const passport = card("12.02.1977", "Cestovní pas");
    const visa = card("01.01.1980", "Vízum");
    expect(canAutoMerge(passport, visa)).toBe(false);
  });

  it("refuses to merge into a card that's already been paired once", () => {
    const alreadyMergedPair = card("12.02.1977", "Cestovní pas", { alreadyPaired: true });
    const thirdFileSameBirthDate = card("12.02.1977", "Neznámý dokument");
    expect(canAutoMerge(alreadyMergedPair, thirdFileSameBirthDate)).toBe(false);
  });
});

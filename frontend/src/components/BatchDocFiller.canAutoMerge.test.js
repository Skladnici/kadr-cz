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

describe("canAutoMerge — real shipped function, residence permit front+back", () => {
  it("Kohili Hadj Benamar Ahmed's real 'Povolení k pobytu' front and back DO merge into one card", () => {
    // Real report: uploaded as two separate photos (front: printed
    // fields; back: TD1 MRZ) — both independently produced the exact
    // same birth_date (08.03.1987 — see test_ocr_service.py's own real-
    // sample tests) and the exact same doc_type ("Povolení k pobytu" —
    // "residence permit" is one of DOC_TYPE_KEYWORDS' own synonyms, so
    // the MRZ-only back side matched it too), yet stayed as two separate
    // "Osoba" cards under the first version of this check, which blocked
    // ANY merge touching a standalone type instead of only a DIFFERENT
    // one.
    const front = card("08.03.1987", "Povolení k pobytu");
    const back = card("08.03.1987", "Povolení k pobytu");
    expect(canAutoMerge(front, back)).toBe(true);
  });

  it("also merges when the back side's doc_type came back undetected (blank/pure-MRZ back, no OCR-recognizable keyword text)", () => {
    // "Neznámý dokument" here isn't "some other document" — it's simply
    // what a back side with nothing but an MRZ block (no printed
    // keyword text at all) correctly detects as. Must not permanently
    // block it from combining with its own front side just because
    // detection came up empty.
    const front = card("08.03.1987", "Povolení k pobytu");
    const undetectedBack = card("08.03.1987", "Neznámý dokument");
    expect(canAutoMerge(front, undetectedBack)).toBe(true);
    expect(canAutoMerge(undetectedBack, front)).toBe(true);
  });

  it("never merges with a DIFFERENT, confidently-detected standalone type sharing its birth date", () => {
    // Genuinely different documents (not two sides of the same one) —
    // the coincidental-birth-date-collision risk this whole check exists
    // to guard against.
    const residencePermit = card("08.03.1987", "Povolení k pobytu");
    const unrelatedIdCard = card("08.03.1987", "Zaměstnanecká karta");
    expect(canAutoMerge(residencePermit, unrelatedIdCard)).toBe(false);
  });

  it("still refuses to pair with a passport/visa type (no birth-date exception for a standalone-vs-passport/visa mismatch)", () => {
    const residencePermit = card("08.03.1987", "Zaměstnanecká karta");
    const passport = card("08.03.1987", "Cestovní pas");
    expect(canAutoMerge(residencePermit, passport)).toBe(false);
  });

  it("still refuses two residence permits with different birth dates (confirms the doc-type wildcard isn't an always-true stub)", () => {
    const a = card("08.03.1987", "Povolení k pobytu");
    const b = card("01.01.1990", "Povolení k pobytu");
    expect(canAutoMerge(a, b)).toBe(false);
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

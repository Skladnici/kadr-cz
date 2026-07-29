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

  it("keeps a genuine name mismatch between two merged documents out of warnings — it's expected OCR noise (e.g. a passport vs. its own visa sticker), not a real problem", () => {
    // Real bug this guards against: a differing name across uploaded
    // files used to render as a permanently-visible, paragraph-length
    // "Pozor: ..." warning (both in this plain `warnings` list and as
    // batch mode's amber StatusDot triangle) even when the merge itself
    // was entirely correct — routine OCR noise, not a sign anything went
    // wrong. It's surfaced instead via the compact, click-to-expand
    // nameMismatchHint/nameMismatchDetail badge (see NameMismatchWarningIcon).
    const merged = mergeRecognizedResults([
      baseResult({ first_name: "JAN" }),
      baseResult({ first_name: "JOHN" }),
    ]);
    expect(merged.warnings).toEqual([]);
    expect(merged.nameMismatchHint).toContain("Jméno");
    expect(merged.nameMismatchDetail).toContain("JAN");
    expect(merged.nameMismatchDetail).toContain("JOHN");
  });

  it("leaves nameMismatchHint/nameMismatchDetail null when names agree", () => {
    const merged = mergeRecognizedResults(
      [baseResult({ first_name: "JAN" }), baseResult({ first_name: "JAN" })]
    );
    expect(merged.nameMismatchHint).toBeNull();
    expect(merged.nameMismatchDetail).toBeNull();
  });
});

describe("mergeRecognizedResults — residence_type pass-through", () => {
  it("carries a residence permit's OCR-detected residence_type through to fields", () => {
    // Real gap this guards against: ocr_service.py's _extract_fields_
    // from_text started returning residence_type for a "Povolení k
    // pobytu" card, but this function's own returned `fields` object
    // never listed the key at all — the value was extracted correctly
    // on the backend and then silently dropped before it ever reached
    // the form.
    const merged = mergeRecognizedResults([
      baseResult({ residence_type: "PŘECHODNÝ POBYT - RP" }),
    ]);
    expect(merged.fields.residence_type).toBe("PŘECHODNÝ POBYT - RP");
  });

  it("leaves residence_type empty for a passport/visa result that never has one", () => {
    const merged = mergeRecognizedResults([baseResult()]);
    expect(merged.fields.residence_type).toBe("");
  });
});

describe("mergeRecognizedResults — residence permit front+back (Kohili Hadj Benamar Ahmed, real case)", () => {
  it("prefers the back side's checksum-verified, clean-MRZ name/doc_number over the front side's label-parsed one", () => {
    // Real, observed shapes: the front side's own label regex mis-parses
    // this card's two-labels-on-one-header-row layout ("PŘÍJMENÍ Jméno"
    // followed by two value lines) and comes back with doc_number empty
    // (unverified); the back side's TD1 MRZ correctly self-verifies the
    // doc_number via ICAO checksum and has a clean MRZ line. Confirms
    // the SAME reliability ranking that already prefers a verified
    // passport/visa MRZ read also protects this front+back case, even
    // though the front's own local mis-parse is a real, separate bug in
    // its own right (not fixed here — see ocr_service.py's NAME_LABEL_
    // PATTERNS for that one).
    const front = baseResult({
      doc_type: "Povolení k pobytu",
      birth_date: "08.03.1987",
      doc_number: null,
      doc_number_verified: false,
      first_name: "Kohili", // mis-parsed — this is actually the surname
      last_name: "Jméno", // mis-parsed — this is literally the OTHER field's label
      mrz_raw: null,
      residence_type: "PŘECHODNÝ POBYT - RP",
    });
    const back = baseResult({
      doc_type: "Povolení k pobytu",
      birth_date: "08.03.1987",
      doc_number: "001968879",
      doc_number_verified: true,
      first_name: "Hadj Benamar Ahmed",
      last_name: "Kohili",
      mrz_raw: "IRCZE0019688796<<<<<<<<<<<<<<\n8703086M2811176DZA8703082421<9\nKOHILI<<HADJ<BENAMAR<AHMED<<",
      residence_type: null,
    });

    const merged = mergeRecognizedResults([front, back]);

    expect(merged.fields.first_name).toBe("HADJ BENAMAR AHMED");
    expect(merged.fields.last_name).toBe("KOHILI");
    expect(merged.fields.doc_number).toBe("001968879");
    expect(merged.docNumberVerified).toBe(true);
    // residence_type only the front side has — must still come through.
    expect(merged.fields.residence_type).toBe("PŘECHODNÝ POBYT - RP");
  });
});

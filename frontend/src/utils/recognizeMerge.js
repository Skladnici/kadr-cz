// Merges an array of /api/recognize-shaped results (one entry per uploaded
// file/pasted text) that all belong to the SAME person — e.g. a passport
// photo plus a visa sticker — into that one person's identity fields.
// Extracted from SimpleDocFiller.jsx's original applyRecognizedResults so
// both the single-person form and batch mode's per-person recognition run
// through exactly the same reconciliation logic, instead of batch mode
// inventing its own way to decide which fields "win" across documents.
//
// compactNameWarning: single mode leaves this off (the default) — there,
// the person combining several uploaded files IS the identity check (no
// automatic verification happens), so the detailed "here are the exact
// variants found, pick the right one" warning is the only signal they
// get if the files don't actually belong together. Batch mode passes
// true: there, files only ever get linked into one card after an
// independent birth-date match already ran (see BatchDocFiller's
// canAutoMerge / the manual "Sloučit" click), so a differing name is
// just OCR noise on an already-confirmed identity — worth a nudge to
// eyeball it, not an alarming variant-by-variant dump telling the
// person to go pick the "correct" one themselves.
export function mergeRecognizedResults(results, { compactNameWarning = false } = {}) {
  const pick = (key) => {
    for (const r of results) {
      if (r[key] && r[key] !== "—") return r[key];
    }
    return "";
  };

  // Identity fields (name, birth date, doc number) can come back non-empty
  // from more than one uploaded file — a visa sticker carries its own
  // MRZ-style name line too, alongside a passport/ID's. Neither "is this
  // doc_number checksum-verified" nor "is this a non-visa document" is a
  // reliable enough signal on its own for the *name* fields — a real test
  // found a passport whose own MRZ read out worse (OCR turned its '<'
  // separators/filler into unrelated-script characters) than the visa's,
  // even though the passport's doc_number happened to still verify. So
  // for names, first check the raw MRZ text itself for contamination —
  // a genuine ICAO 9303 MRZ line contains only A-Z, digits, '<' and
  // whitespace; anything else means OCR garbled that zone, regardless of
  // which document it came from or whether its doc_number checksummed
  // clean. A result with no MRZ at all (name came from a label instead)
  // is treated as neutral rather than penalized, since there's nothing
  // to judge here.
  const hasCleanMrz = (r) => !r.mrz_raw || /^[A-Z0-9<\s]+$/.test(r.mrz_raw);
  const pickReliableResult = (key) => {
    const isNameField = key === "first_name" || key === "last_name";
    const clean = (r) => !isNameField || hasCleanMrz(r);
    return (
      results.find((r) => r[key] && r[key] !== "—" && r.doc_number_verified && clean(r)) ||
      results.find((r) => r[key] && r[key] !== "—" && clean(r)) ||
      results.find((r) => r[key] && r[key] !== "—" && r.doc_type !== "Vízum") ||
      results.find((r) => r[key] && r[key] !== "—")
    );
  };
  const pickReliable = (key) => pickReliableResult(key)?.[key] || "";

  const docNumberSource = pickReliableResult("doc_number");

  // A letter misread within the valid MRZ alphabet (e.g. "M" -> "B") is
  // invisible to hasCleanMrz above — both readings are still all-valid
  // MRZ characters, just wrong. The only remaining signal for that class
  // of error is disagreement between documents: if two uploaded files
  // both name a person, but spell it differently, at least one of them
  // is wrong and no automatic check here can tell which. So this only
  // warns — it never blocks or auto-picks a "winner" — leaving the final
  // call to the person who can look at the actual photos, same as the
  // honest photo-quality hedge above.
  const nameMismatchMessages = [["first_name", "Jméno"], ["last_name", "Příjmení"]].flatMap(
    ([key, label]) => {
      const variants = [];
      results.forEach((r, i) => {
        const value = r[key];
        if (!value || value === "—") return;
        const normalized = value.trim().toUpperCase();
        if (!variants.some((v) => v.normalized === normalized)) {
          variants.push({ normalized, display: value, fileNumber: i + 1 });
        }
      });
      if (variants.length < 2) return [];
      if (compactNameWarning) {
        return [`${label} se liší mezi doklady — zkontrolujte.`];
      }
      const listed = variants.map((v) => `„${v.display}" (soubor ${v.fileNumber})`).join(", ");
      return [
        `Pozor: ${label} bylo na nahraných dokumentech rozpoznáno odlišně — ${listed}. Zkontrolujte prosím ručně podle fotografií a vyberte správnou variantu.`,
      ];
    }
  );

  // In compact mode (batch/merged cards), a name mismatch is *expected*
  // OCR noise on an identity already confirmed by an independent
  // birth-date match (see this function's own top comment) — a
  // successful, correct merge routinely produces one (visa MRZ names
  // often read slightly differently than a passport's). It must NOT set
  // off the same amber-triangle "this needs a manual look" signal a real
  // problem does (missing field, failed checksum, expired document) —
  // real case: every auto-merged and manually-merged card was showing
  // the warning triangle even when the merge was entirely correct,
  // reading as "something went wrong" to whoever's reviewing the batch.
  // Surfaced separately (like `addressHint` below) instead, purely
  // informational. In non-compact (single) mode this stays a real
  // `warnings` entry — there, the person combining files IS the identity
  // check, so a differing name is the only signal they get that the
  // files might not belong together at all.
  const nameMismatchHint = compactNameWarning && nameMismatchMessages.length > 0
    ? nameMismatchMessages.join(" ")
    : null;

  // Actionable warnings only — backend per-file quality/checksum/expiry
  // flags, plus (single mode only) a genuine cross-document name
  // mismatch. Deliberately excludes the address hint below: that fires
  // whenever an address happened to appear in the OCR text, which is
  // routine on most ID documents, not a sign anything went wrong. Kept
  // separate (as `addressHint`, not folded into `warnings`) specifically
  // so a caller that uses `warnings.length` to flag "this needs a manual
  // look" (see BatchDocFiller/PersonCard's StatusDot) doesn't light up
  // on every ordinary successful merge just because an address was
  // printed on the document — a real bug found by testing two real
  // people in one batch: one had an address on their ID and got
  // flagged, the other didn't and came up clean, even though both
  // merged without any actual problem.
  const warnings = [
    ...results.flatMap((r) => r.warnings || []),
    ...(compactNameWarning ? [] : nameMismatchMessages),
  ];

  const recognizedAddress = pick("address");
  const addressHint = recognizedAddress
    ? `V dokumentu byl nalezen možný adresní text: „${recognizedAddress}" — zkontrolujte a případně zkopírujte ručně, automaticky se nevyplňuje.`
    : null;

  return {
    fields: {
      first_name: pickReliable("first_name").toUpperCase(),
      last_name: pickReliable("last_name").toUpperCase(),
      birth_date: pickReliable("birth_date"),
      nationality: pick("nationality"),
      doc_number: docNumberSource?.doc_number || "",
      visa_number: pick("visa_number"),
      visa_validity: pick("visa_validity"),
      // The visa's printed category/type code (e.g. "D/SD/91") — see
      // ocr_service.py's _find_visa_info. Never user-edited, only ever
      // set from OCR, so a plain pick() (first non-empty result) is
      // enough — no reliability ranking needed the way name/doc_number
      // have.
      visa_type_code: pick("visa_type_code"),
    },
    docNumberVerified: Boolean(docNumberSource?.doc_number_verified),
    warnings,
    addressHint,
    nameMismatchHint,
    rawText: results.map((r, i) => `--- Soubor ${i + 1} ---\n${r.ocr_raw_text || ""}`).join("\n\n"),
    ocrMode: results[0]?.ocr_mode,
  };
}

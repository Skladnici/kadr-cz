// Merges an array of /api/recognize-shaped results (one entry per uploaded
// file/pasted text) that all belong to the SAME person — e.g. a passport
// photo plus a visa sticker — into that one person's identity fields.
// Extracted from SimpleDocFiller.jsx's original applyRecognizedResults so
// both the single-person form and batch mode's per-person recognition run
// through exactly the same reconciliation logic, instead of batch mode
// inventing its own way to decide which fields "win" across documents.
export function mergeRecognizedResults(results) {
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
  const nameMismatchWarnings = [["first_name", "Jméno"], ["last_name", "Příjmení"]].flatMap(
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
      const listed = variants.map((v) => `„${v.display}" (soubor ${v.fileNumber})`).join(", ");
      return [
        `Pozor: ${label} bylo na nahraných dokumentech rozpoznáno odlišně — ${listed}. Zkontrolujte prosím ručně podle fotografií a vyberte správnou variantu.`,
      ];
    }
  );

  const recognizedAddress = pick("address");
  const warnings = [...results.flatMap((r) => r.warnings || []), ...nameMismatchWarnings];
  if (recognizedAddress) {
    warnings.push(
      `V dokumentu byl nalezen možný adresní text: „${recognizedAddress}" — zkontrolujte a případně zkopírujte ručně, automaticky se nevyplňuje.`
    );
  }

  return {
    fields: {
      first_name: pickReliable("first_name").toUpperCase(),
      last_name: pickReliable("last_name").toUpperCase(),
      birth_date: pickReliable("birth_date"),
      nationality: pick("nationality"),
      doc_number: docNumberSource?.doc_number || "",
      visa_number: pick("visa_number"),
      visa_validity: pick("visa_validity"),
    },
    docNumberVerified: Boolean(docNumberSource?.doc_number_verified),
    warnings,
    rawText: results.map((r, i) => `--- Soubor ${i + 1} ---\n${r.ocr_raw_text || ""}`).join("\n\n"),
    ocrMode: results[0]?.ocr_mode,
  };
}

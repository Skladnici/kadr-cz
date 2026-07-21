import JSZip from "jszip";
import { apiFetchWithTimeout } from "./api";

// The server's own generated filename (e.g.
// "dpp_template_NOVAK_JAN_<uuid>.docx") is deliberately opaque — the
// UUID in it is the actual bearer secret protecting /api/download,
// which has no auth of its own (see blank_service.py's fill_blank).
// What the person actually sees saved to their Downloads folder should
// be a clean, human name instead.
export function sanitizeFilenamePart(s) {
  return (s || "")
    .normalize("NFD").replace(/[̀-ͯ]/g, "") // strip diacritics: "Novák" -> "Novak"
    .trim()
    .replace(/[^A-Za-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

// `fields` needs only first_name/last_name — used as both a batch
// person's folder name and a single-mode result's zip filename, so it
// takes the plain fields shape both already have rather than either
// component's own wrapper object.
export function nameFolderPart(fields) {
  const first = sanitizeFilenamePart(fields?.first_name);
  const last = sanitizeFilenamePart(fields?.last_name);
  return [first, last].filter(Boolean).join("_") || "dokument";
}

// The one and only shape every DPP/DPČ/HPP generation can produce (see
// backend's /api/fill + _BUNDLE_TEMPLATE_IDS) — shared by batch mode
// (one entry per person) and single mode (exactly one entry), so both
// zip exactly the same four-or-five files the same way.
export const BUNDLE_FILE_SPECS = [
  { tokenKey: "docxToken", filename: "smlouva.docx" },
  { tokenKey: "pdfToken", filename: "smlouva.pdf" },
  { tokenKey: "gdprDocxToken", filename: "souhlas_gdpr.docx" },
  { tokenKey: "zdravotniDocxToken", filename: "prohlaseni_zdravotni.docx" },
  { tokenKey: "poplatnikPdfToken", filename: "prohlaseni_poplatnika.pdf" },
];

// /api/download isn't rate-limited (no @limiter.limit in main.py, unlike
// /api/recognize and /api/fill), so runWithRetry's narrow "only retry on
// a 429" wouldn't actually retry anything here — this is a separate,
// general-purpose retry instead: worth one or two more tries on a
// network hiccup/timeout or a transient server error, but not on a 401
// (auth expired — retrying won't help) or a 404 (the token's file was
// already served and deleted server-side — retrying can only ever fail
// the same way).
async function fetchDownloadWithRetry(apiFetch, token, maxAttempts = 3) {
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const res = await apiFetchWithTimeout(apiFetch, `/api/download/${token}`, {}, 30000);
      if (res.ok || res.status === 401 || res.status === 404 || attempt === maxAttempts) {
        return res;
      }
    } catch (e) {
      if (attempt === maxAttempts) throw e;
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
}

// Shared by batch mode's bulk-download button and single mode's result-
// screen download button — packaging every generated file into ONE zip
// instead of N separate downloads/tab opens is what makes either
// reliable in a real (non-automated) browser: real-world testing
// confirmed Chrome throttles both a rapid sequence of automatic
// downloads and a rapid sequence of window.open() calls after the first
// one, requiring the person to notice and approve a permission by hand
// — a single zip is one browser action, so that throttling never gets a
// chance to trigger either way.
//
// One folder per entry (e.g. "Jan_Novak/") rather than a flat pile —
// requested once the 4-document onboarding packet made a flat zip
// confusing to sort through by hand for more than one or two people;
// single mode reuses the same structure (one folder, one person) purely
// so both modes' zips look identical rather than because a lone folder
// is otherwise needed.
//
// `entries` is [{ folderName, tokens }] — `tokens` uses the same key
// shape as `fileSpecs`' tokenKeys, so a caller who only has one token
// (single mode) or a whole batch's worth (one per person) can build it
// the same way. `buildZipFilename(addedCount)` gets the *actual* number
// of entries that ended up with at least one file (which can be lower
// than entries.length if every download for one entry failed), so it's
// a callback rather than a plain string.
//
// /api/download tokens are single-use (the file is deleted server-side
// once served), which is why this must never run twice concurrently for
// the same entries — two overlapping calls would race each other for
// the same tokens, and whichever request loses arrives to find its file
// already gone. Callers guard against that themselves (see
// BatchDocFiller's isBulkDownloadingRef).
export async function zipFolderedDownload(apiFetch, entries, fileSpecs, buildZipFilename, onError) {
  const zip = new JSZip();
  const usedFolderNames = new Set();
  let addedCount = 0;
  let anyDownloadFailed = false;
  for (const entry of entries) {
    // Two entries can share a folder name (or both lack one) — dedupe so
    // one never silently overwrites another's folder in the zip.
    let folderName = entry.folderName;
    let suffix = 2;
    while (usedFolderNames.has(folderName)) {
      folderName = `${entry.folderName}_${suffix}`;
      suffix += 1;
    }

    let addedAnyFileForThisEntry = false;
    for (const { tokenKey, filename } of fileSpecs) {
      const token = entry.tokens?.[tokenKey];
      if (!token) continue; // no such document for this entry (bundle doc failed, or not a bundle template at all)
      try {
        const res = await fetchDownloadWithRetry(apiFetch, token);
        if (!res.ok) {
          if (res.status !== 401) {
            anyDownloadFailed = true;
          }
          continue;
        }
        const blob = await res.blob();
        zip.file(`${folderName}/${filename}`, blob);
        addedAnyFileForThisEntry = true;
      } catch {
        anyDownloadFailed = true;
      }
    }
    if (addedAnyFileForThisEntry) {
      usedFolderNames.add(folderName);
      addedCount += 1;
    }
  }
  if (anyDownloadFailed && onError) {
    onError("Některé soubory se nepodařilo stáhnout — zkontrolujte připojení a zkuste to znovu.");
  }
  if (addedCount === 0) return false;
  const zipBlob = await zip.generateAsync({ type: "blob" });
  const zipUrl = URL.createObjectURL(zipBlob);
  const a = document.createElement("a");
  a.href = zipUrl;
  a.download = buildZipFilename(addedCount);
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(zipUrl), 30000);
  return true;
}

// Mirrors backend/app/ocr_service.py's _parse_any_date format list — a
// birth_date coming back from OCR can arrive in any of these shapes
// depending on which regex matched server-side (labeled-date capture vs.
// bilingual-tuple fallback vs. mock ISO samples), and manual entry here
// is typed as DD.MM.YYYY. Keeping the same format list means a date that
// parses on the backend also parses here.
const DMY_FORMATS = [
  /^(\d{1,2})\.(\d{1,2})\.(\d{4})$/, // D.M.YYYY
  /^(\d{1,2})-(\d{1,2})-(\d{4})$/, // D-M-YYYY
  /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/, // D/M/YYYY
];

const YMD_FORMATS = [
  /^(\d{4})-(\d{1,2})-(\d{1,2})$/, // YYYY-M-D
  /^(\d{4})\.(\d{1,2})\.(\d{1,2})$/, // YYYY.M.D
  /^(\d{4})\/(\d{1,2})\/(\d{1,2})$/, // YYYY/M/D
];

function toValidUtcDate(year, month, day) {
  const d = new Date(Date.UTC(year, month - 1, day));
  // Date.UTC silently rolls invalid values over (e.g. 31.02.2024 becomes
  // March 2nd) — reading the parts back out catches that instead of
  // accepting a date that was never actually printed on the document.
  if (d.getUTCFullYear() !== year || d.getUTCMonth() !== month - 1 || d.getUTCDate() !== day) {
    return null;
  }
  return d;
}

// Returns a UTC-midnight Date for a recognized birth_date shape, or null
// if `raw` is empty, unrecognized, or not a real calendar date.
export function parseFlexibleDate(raw) {
  const value = (raw || "").trim();
  if (!value) return null;
  for (const pattern of DMY_FORMATS) {
    const m = value.match(pattern);
    if (m) return toValidUtcDate(Number(m[3]), Number(m[2]), Number(m[1]));
  }
  for (const pattern of YMD_FORMATS) {
    const m = value.match(pattern);
    if (m) return toValidUtcDate(Number(m[1]), Number(m[2]), Number(m[3]));
  }
  return null;
}

// Whole years between a birth_date (any shape parseFlexibleDate accepts)
// and referenceDate (defaults to now) — counts a birthday only once the
// month/day has actually been reached, not just the year difference.
// Returns null for unparseable input or a birth date in the future
// (almost certainly a typo, not grounds for an age warning).
export function calculateAge(raw, referenceDate = new Date()) {
  const dob = parseFlexibleDate(raw);
  if (!dob) return null;
  const ref = new Date(Date.UTC(referenceDate.getFullYear(), referenceDate.getMonth(), referenceDate.getDate()));
  if (dob > ref) return null;
  let age = ref.getUTCFullYear() - dob.getUTCFullYear();
  const hadBirthdayThisYear =
    ref.getUTCMonth() > dob.getUTCMonth() ||
    (ref.getUTCMonth() === dob.getUTCMonth() && ref.getUTCDate() >= dob.getUTCDate());
  if (!hadBirthdayThisYear) age -= 1;
  return age;
}

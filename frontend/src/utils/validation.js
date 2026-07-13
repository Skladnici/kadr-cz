// IČO/DIČ are typed in by hand (or come from OCR, which is unreliable on
// small print) and go straight into a legal contract — a silent typo here
// (transposed digit, missing "CZ" prefix) is the kind of mistake nobody
// notices until the document is already signed. These checks are advisory
// only: they flag the field red and explain why, but never block
// generation, since edge cases (foreign companies, sole traders without a
// VAT number) are common enough that hard-blocking would be wrong.

// Official ČSÚ checksum: weight digits 1-7 by 8..2, mod 11, map the
// remainder to the expected 8th digit.
export function isValidIco(raw) {
  const digits = (raw || "").replace(/\s+/g, "");
  if (!/^\d{8}$/.test(digits)) return false;
  const weights = [8, 7, 6, 5, 4, 3, 2];
  const sum = weights.reduce((acc, w, i) => acc + w * Number(digits[i]), 0);
  const remainder = sum % 11;
  const expected = remainder === 0 ? 1 : remainder === 1 ? 0 : 11 - remainder;
  return expected === Number(digits[7]);
}

// DIČ = country prefix (usually "CZ") + 8-10 digits. The digit count
// varies (8 for companies sharing their IČO, up to 10 for individuals
// keyed off a birth number), so unlike IČO there's no single checksum to
// verify — this only checks the shape.
export function isValidDic(raw) {
  const value = (raw || "").replace(/\s+/g, "").toUpperCase();
  return /^[A-Z]{2}\d{8,10}$/.test(value);
}

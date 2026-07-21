// The visa's printed category/type code (see backend's _find_visa_info)
// has the shape LETTER(S)/LETTERS/DIGITS, e.g. "D/SD/91" or "D/VR/27" —
// the middle two-letter group identifies the specific residence
// category. "SD" is the one that means "strpění" (tolerated stay), a
// special status distinct from an ordinary short/long-term visa —
// confirmed against a real document (Roman Shyshka's visa, code
// "D/SD/91"); a different real sample (David Hambaryan) carried
// "D/VR/27" instead, so this only flags the specific "SD" category, not
// every code matching the general shape.
export function isStrpeniVisaCode(code) {
  if (!code) return false;
  const parts = code.split("/");
  return parts.length === 3 && parts[1] === "SD";
}

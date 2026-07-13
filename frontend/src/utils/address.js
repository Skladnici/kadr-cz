import { CZ_CITY_PSC, UA_CITY_PSC } from "../data/cityData";

// Splits a free-text recognized address into a street part and a postal
// code, when one can be confidently found — so the PSČ/indeks field gets
// auto-filled too, not just the street field.
export function splitRecognizedAddress(raw) {
  if (!raw) return { street: "" };
  // Ukrainian postal codes: 5 digits. Czech: "NNN NN" (with or without space).
  const czMatch = raw.match(/\b(\d{3}\s?\d{2})\b/);
  const uaMatch = raw.match(/\b(\d{5})\b/);
  const match = czMatch || uaMatch;
  if (!match) return { street: raw.trim() };
  const psc = match[1].replace(/\s+/g, czMatch ? " " : "");
  const street = (raw.slice(0, match.index) + raw.slice(match.index + match[0].length))
    .replace(/[,\s]+$/, "")
    .replace(/^[,\s]+/, "")
    .replace(/\s{2,}/g, " ")
    .trim();
  return { street, psc };
}

// Tries to spot a known city name embedded in the recognized address
// text and split it out into its own field, using the same city lists
// that power the manual autocomplete — so a recognized address ends up
// with city + PSČ already separated, not just dumped into "street".
export function smartSplitAddress(raw, countryGuess) {
  const base = splitRecognizedAddress(raw);
  if (!base.street) return base;

  // Search both city tables regardless of any pre-guessed country — a
  // real city-name match is a strong enough signal on its own, and
  // relying on a separately-guessed country (which can be stale from a
  // previous document) was causing the split to silently skip.
  const lowerStreet = base.street.toLowerCase();
  let bestMatch = null;
  let bestKey = null;
  let bestTable = null;
  for (const table of [CZ_CITY_PSC, UA_CITY_PSC]) {
    for (const cityName of Object.keys(table)) {
      // City keys may be "Cyrillic / Latin" (Ukraine) or a plain Czech
      // name — check every segment, since recognized address text is
      // usually in Latin transliteration even for Ukrainian addresses.
      for (const part of cityName.split(" / ").map((p) => p.trim())) {
        if (part.length >= 3 && lowerStreet.includes(part.toLowerCase())) {
          if (!bestMatch || part.length > bestMatch.length) {
            bestMatch = part;
            bestKey = cityName;
            bestTable = table;
          }
        }
      }
    }
  }
  if (!bestMatch) return base;

  const idx = lowerStreet.indexOf(bestMatch.toLowerCase());
  const street = (base.street.slice(0, idx) + base.street.slice(idx + bestMatch.length))
    .replace(/[,\s]+$/, "")
    .replace(/^[,\s]+/, "")
    .replace(/\s{2,}/g, " ")
    .trim();
  return {
    street,
    city: bestMatch,
    psc: base.psc || bestTable[bestKey],
  };
}

export function composeCzAddress(parts) {
  return [parts.street, [parts.psc, parts.city].filter(Boolean).join(" ")].filter(Boolean).join(", ");
}

export function composeOriginAddress(country, parts) {
  if (country === "ua") {
    return [parts.street, parts.city, parts.psc].filter(Boolean).join(", ");
  }
  return [parts.street, [parts.psc, parts.city].filter(Boolean).join(" "), parts.country].filter(Boolean).join(", ");
}

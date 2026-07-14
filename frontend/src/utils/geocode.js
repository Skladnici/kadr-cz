// Thin wrapper around Nominatim's free public geocoding endpoint — used
// to resolve a real PSČ wherever CZ_CITY_PSC can't supply one: the large
// multi-district cities that intentionally have no single correct value
// (see CZ_AMBIGUOUS_PSC_CITIES in data/cityData.js), and any city that
// simply isn't in that static list at all (a small town/village).
// The caller is responsible for debouncing and for supplying an
// AbortSignal (both for cancelling a superseded request and for
// enforcing a timeout) — see AddressBuilder.jsx.
//
// Browser fetch() cannot set a custom User-Agent header (the platform
// treats it as forbidden/unsafe to override), so this relies on the
// Referer header the browser sends automatically to identify the calling
// site, which Nominatim's usage policy accepts as an alternative to a
// custom User-Agent. Fine at this app's traffic volume (a small shared
// HR tool); a backend proxy with an explicit User-Agent and server-side
// caching would be the more correct home for this if usage ever grows
// enough to matter.
const NOMINATIM_URL = "https://nominatim.openstreetmap.org/search";

// Returns the PSČ (as a string, e.g. "708 00") for the given street+city,
// or null if Nominatim didn't return a usable result. Never throws for
// "no result" — only for genuine network/abort failures, which the
// caller is expected to catch and treat the same as "no result".
export async function fetchPscForAddress(street, city, signal) {
  const query = `${street}, ${city}, Czechia`;
  const url = `${NOMINATIM_URL}?format=json&addressdetails=1&countrycodes=cz&limit=1&q=${encodeURIComponent(query)}`;
  const res = await fetch(url, { signal, headers: { Accept: "application/json" } });
  if (!res.ok) return null;
  const results = await res.json();
  return results?.[0]?.address?.postcode || null;
}

import { memo, useEffect, useRef, useState } from "react";
import CityAutocomplete from "./CityAutocomplete";
import { CZ_CITY_PSC, CZ_AMBIGUOUS_PSC_CITIES, UA_CITY_PSC } from "../data/cityData";
import { fetchPscForAddress } from "../utils/geocode";

// Debounced so typing a street doesn't fire a Nominatim request per
// keystroke — comfortably under their "max 1 request/sec" usage policy.
const GEOCODE_DEBOUNCE_MS = 1000;
// Nominatim occasionally hangs rather than erroring — bound how long we
// wait so the field just falls back to manual entry instead of leaving
// the "hledám PSČ…" hint stuck forever.
const GEOCODE_TIMEOUT_MS = 6000;

// Memoized because it sits below SimpleDocFiller's single `fields` state —
// without this, every keystroke in an unrelated field (salary, position,
// company name, ...) would re-render the whole address block too. Only
// pays off because the caller passes stable (useCallback'd) setters —
// see setCzPart/setOriginPart/handleSetOriginCountry in SimpleDocFiller.
function AddressBuilder({ czParts, setCzPart, originCountry, setOriginCountry, originParts, setOriginPart }) {
  const cityMatchKey = czParts.city
    ? Object.keys(CZ_CITY_PSC).find((c) => c.toLowerCase() === czParts.city.trim().toLowerCase())
    : null;
  // Large cities (statutární města) span several postal districts — a
  // single PSČ per city name would be wrong more often than not, so
  // these intentionally have "" in CZ_CITY_PSC (see cityData.js). Instead
  // of leaving the field permanently blank, the effect below asks
  // Nominatim to resolve the real PSČ once a street has been typed.
  const isAmbiguousCity = cityMatchKey && CZ_AMBIGUOUS_PSC_CITIES.has(cityMatchKey);
  const cityMatch = cityMatchKey && !isAmbiguousCity ? cityMatchKey : null;
  const uaCityMatch = originCountry === "ua" && originParts.city
    ? Object.keys(UA_CITY_PSC).find((c) => c.toLowerCase() === originParts.city.trim().toLowerCase())
    : null;

  // --- Live PSČ lookup for ambiguous cities ---------------------------
  const [geocodeStatus, setGeocodeStatus] = useState("idle"); // idle | loading | done
  const latestPscRef = useRef(czParts.psc);
  const lastFilledPscRef = useRef(null); // the value *we* last wrote in
  const lastQueryRef = useRef(null);
  const abortRef = useRef(null);

  useEffect(() => { latestPscRef.current = czParts.psc; }, [czParts.psc]);

  useEffect(() => {
    if (!isAmbiguousCity) {
      setGeocodeStatus("idle");
      return;
    }
    const street = (czParts.street || "").trim();
    const city = (czParts.city || "").trim();
    if (!street || !city) {
      setGeocodeStatus("idle");
      return;
    }
    const query = `${street}, ${city}`;
    if (query === lastQueryRef.current) return; // already resolved this exact address

    // Declared here (not inside the timer callback) so the cleanup below
    // can reach the same controller instance to abort it.
    let controller = null;

    const timer = setTimeout(() => {
      lastQueryRef.current = query;
      controller = new AbortController();
      abortRef.current = controller;
      const timeoutId = setTimeout(() => controller.abort(), GEOCODE_TIMEOUT_MS);
      setGeocodeStatus("loading");

      // Bail out of updating state only if a *newer* request has taken
      // over (abortRef has since been reassigned or cleared) — not
      // simply because controller.signal.aborted is true, since our own
      // GEOCODE_TIMEOUT_MS firing also sets that flag on this exact
      // controller, and that case still needs to resolve to "done" so
      // the UI doesn't get stuck showing "hledám PSČ podle adresy…"
      // forever.
      const isStillCurrent = () => abortRef.current === controller;

      fetchPscForAddress(street, city, controller.signal)
        .then((postcode) => {
          if (!isStillCurrent()) return;
          if (postcode) {
            const current = (latestPscRef.current || "").trim();
            // Never clobber something the person typed themselves —
            // only fill if the field is still empty, or still holds
            // exactly what our own last lookup put there.
            if (!current || current === lastFilledPscRef.current) {
              setCzPart("psc", postcode);
              lastFilledPscRef.current = postcode;
            }
          }
          setGeocodeStatus("done");
        })
        .catch(() => {
          if (!isStillCurrent()) return;
          // Network error, timeout, or Nominatim unreachable — silently
          // fall back to the manual-entry warning below, same as a
          // genuine "no result" response.
          setGeocodeStatus("done");
        })
        .finally(() => clearTimeout(timeoutId));
    }, GEOCODE_DEBOUNCE_MS);

    return () => {
      clearTimeout(timer);
      // Marks the in-flight request (if any) as no longer current *before*
      // aborting it, so its .then()/.catch() (which may still fire
      // asynchronously after this) knows to skip updating state — this is
      // what stops a stale response from touching state after this effect
      // was superseded by a newer one, or after the component unmounted.
      if (controller) {
        if (abortRef.current === controller) abortRef.current = null;
        controller.abort();
      }
    };
  }, [isAmbiguousCity, czParts.street, czParts.city, setCzPart]);

  // True only while the field still holds exactly the PSČ our own lookup
  // wrote — the moment the person edits it, this goes false on its own
  // and the "podle adresy" hint disappears instead of misdescribing it.
  const pscFromGeocode = Boolean(
    isAmbiguousCity && lastFilledPscRef.current && czParts.psc === lastFilledPscRef.current
  );

  return (
    <div className="space-y-4">
      {/* Block 1 — always Czech residence address */}
      <div className="rounded-xl border border-slate-200 p-3 md:p-6 bg-slate-50/40">
        <div className="text-[11px] md:text-[12px] uppercase tracking-wide text-slate-400 mb-2">Adresa pobytu v ČR</div>
        <div className="grid grid-cols-2 gap-x-3 gap-y-4">
          <label className="block col-span-2">
            <span className="text-[11px] md:text-[12px] text-slate-400">Ulice a číslo popisné</span>
            <input
              value={czParts.street || ""}
              onChange={(e) => setCzPart("street", e.target.value)}
              placeholder="Vinohradská 45"
              autoComplete="off"
              className="mt-1 w-full rounded-xl border border-slate-200 px-2.5 py-1.5 md:px-3.5 md:py-3 text-[13px] md:text-[14.5px] focus:outline-none focus:ring-2 focus:ring-[#0B1220]/10"
            />
          </label>
          <label className="block">
            <span className="text-[11px] md:text-[12px] text-slate-400">Město</span>
            <CityAutocomplete
              value={czParts.city}
              onChange={(v) => setCzPart("city", v)}
              onSelect={(name, psc) => { setCzPart("city", name); setCzPart("psc", psc); }}
              cityTable={CZ_CITY_PSC}
              placeholder="Praha"
            />
          </label>
          <label className="block">
            <span className="text-[11px] md:text-[12px] text-slate-400">
              PSČ
              {cityMatch && <span className="text-emerald-600"> · doplněno automaticky</span>}
              {isAmbiguousCity && pscFromGeocode && (
                <span className="text-sky-600"> · doplněno podle adresy</span>
              )}
              {isAmbiguousCity && !pscFromGeocode && geocodeStatus === "loading" && (
                <span className="text-slate-400"> · hledám PSČ podle adresy…</span>
              )}
              {isAmbiguousCity && !pscFromGeocode && geocodeStatus !== "loading" && (
                <span className="text-amber-600"> · liší se podle části města, zadejte ručně</span>
              )}
            </span>
            <input
              value={czParts.psc || ""}
              onChange={(e) => setCzPart("psc", e.target.value)}
              placeholder={isAmbiguousCity ? "např. 702 00" : "100 00"}
              className="mt-1 w-full rounded-xl border border-slate-200 px-2.5 py-1.5 md:px-3.5 md:py-3 text-[13px] md:text-[14.5px] focus:outline-none focus:ring-2 focus:ring-[#0B1220]/10"
            />
          </label>
        </div>
      </div>

      {/* Block 2 — home country address, country picked via short tabs */}
      <div className="rounded-xl border border-slate-200 p-3 md:p-6 bg-slate-50/40">
        <div className="flex items-center justify-between mb-2">
          <div className="text-[11px] md:text-[12px] uppercase tracking-wide text-slate-400">Adresa v zemi původu</div>
          <div className="flex gap-1">
            {[["ua", "UA"], ["eu", "EU"]].map(([key, label]) => (
              <button
                key={key}
                type="button"
                onClick={() => setOriginCountry(key)}
                className={`rounded-xl px-2 py-0.5 md:px-3 md:py-1 text-[11px] md:text-[12px] font-medium border transition-colors
                  ${originCountry === key ? "bg-[#0B1220] text-white border-[#0B1220]" : "bg-white text-slate-500 border-slate-200 hover:border-slate-300"}`}
              >
                {label}
              </button>
            ))}
          </div>
        </div>

        {originCountry === "ua" ? (
          <div className="grid grid-cols-2 gap-x-3 gap-y-4">
            <label className="block col-span-2">
              <span className="text-[11px] md:text-[12px] text-slate-400">Vulytsia, budynok (ulice, číslo)</span>
              <input
                value={originParts.street || ""}
                onChange={(e) => setOriginPart("street", e.target.value)}
                placeholder="vul. Chreščatyk 10"
                autoComplete="off"
                className="mt-1 w-full rounded-xl border border-slate-200 px-2.5 py-1.5 md:px-3.5 md:py-3 text-[13px] md:text-[14.5px] focus:outline-none focus:ring-2 focus:ring-[#0B1220]/10"
              />
            </label>
            <label className="block">
              <span className="text-[11px] md:text-[12px] text-slate-400">Misto (město)</span>
              <CityAutocomplete
                value={originParts.city}
                onChange={(v) => setOriginPart("city", v)}
                onSelect={(name, psc) => { setOriginPart("city", name); setOriginPart("psc", psc); }}
                cityTable={UA_CITY_PSC}
                placeholder="Kyjev"
              />
            </label>
            <label className="block">
              <span className="text-[11px] md:text-[12px] text-slate-400">
                Indeks {uaCityMatch && <span className="text-emerald-600">· auto</span>}
              </span>
              <input
                value={originParts.psc || ""}
                onChange={(e) => setOriginPart("psc", e.target.value)}
                placeholder="01001"
                className="mt-1 w-full rounded-xl border border-slate-200 px-2.5 py-1.5 md:px-3.5 md:py-3 text-[13px] md:text-[14.5px] focus:outline-none focus:ring-2 focus:ring-[#0B1220]/10"
              />
            </label>
          </div>
        ) : (
          <div className="grid grid-cols-2 gap-x-3 gap-y-4">
            <label className="block col-span-2">
              <span className="text-[11px] md:text-[12px] text-slate-400">Ulice a číslo</span>
              <input
                value={originParts.street || ""}
                onChange={(e) => setOriginPart("street", e.target.value)}
                autoComplete="off"
                className="mt-1 w-full rounded-xl border border-slate-200 px-2.5 py-1.5 md:px-3.5 md:py-3 text-[13px] md:text-[14.5px] focus:outline-none focus:ring-2 focus:ring-[#0B1220]/10"
              />
            </label>
            <label className="block">
              <span className="text-[11px] md:text-[12px] text-slate-400">Město</span>
              <input
                value={originParts.city || ""}
                onChange={(e) => setOriginPart("city", e.target.value)}
                className="mt-1 w-full rounded-xl border border-slate-200 px-2.5 py-1.5 md:px-3.5 md:py-3 text-[13px] md:text-[14.5px] focus:outline-none focus:ring-2 focus:ring-[#0B1220]/10"
              />
            </label>
            <label className="block">
              <span className="text-[11px] md:text-[12px] text-slate-400">PSČ</span>
              <input
                value={originParts.psc || ""}
                onChange={(e) => setOriginPart("psc", e.target.value)}
                className="mt-1 w-full rounded-xl border border-slate-200 px-2.5 py-1.5 md:px-3.5 md:py-3 text-[13px] md:text-[14.5px] focus:outline-none focus:ring-2 focus:ring-[#0B1220]/10"
              />
            </label>
            <label className="block col-span-2">
              <span className="text-[11px] md:text-[12px] text-slate-400">Země</span>
              <input
                value={originParts.country || ""}
                onChange={(e) => setOriginPart("country", e.target.value)}
                placeholder="Polsko, Slovensko, Německo…"
                className="mt-1 w-full rounded-xl border border-slate-200 px-2.5 py-1.5 md:px-3.5 md:py-3 text-[13px] md:text-[14.5px] focus:outline-none focus:ring-2 focus:ring-[#0B1220]/10"
              />
            </label>
          </div>
        )}
      </div>
    </div>
  );
}

export default memo(AddressBuilder);

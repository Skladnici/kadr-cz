import { memo } from "react";
import CityAutocomplete from "./CityAutocomplete";
import { CZ_CITY_PSC, UA_CITY_PSC } from "../data/cityData";

// Memoized because it sits below SimpleDocFiller's single `fields` state —
// without this, every keystroke in an unrelated field (salary, position,
// company name, ...) would re-render the whole address block too. Only
// pays off because the caller passes stable (useCallback'd) setters —
// see setCzPart/setOriginPart/handleSetOriginCountry in SimpleDocFiller.
function AddressBuilder({ czParts, setCzPart, originCountry, setOriginCountry, originParts, setOriginPart }) {
  const cityMatch = czParts.city
    ? Object.keys(CZ_CITY_PSC).find((c) => c.toLowerCase() === czParts.city.trim().toLowerCase())
    : null;
  const uaCityMatch = originCountry === "ua" && originParts.city
    ? Object.keys(UA_CITY_PSC).find((c) => c.toLowerCase() === originParts.city.trim().toLowerCase())
    : null;

  return (
    <div className="space-y-4">
      {/* Block 1 — always Czech residence address */}
      <div className="rounded-xl border border-slate-200 p-3 bg-slate-50/40">
        <div className="text-[11px] uppercase tracking-wide text-slate-400 mb-2">Adresa pobytu v ČR</div>
        <div className="grid grid-cols-2 gap-x-3 gap-y-4">
          <label className="block col-span-2">
            <span className="text-[11px] text-slate-400">Ulice a číslo popisné</span>
            <input
              value={czParts.street || ""}
              onChange={(e) => setCzPart("street", e.target.value)}
              placeholder="Vinohradská 45"
              autoComplete="off"
              className="mt-1 w-full rounded-xl border border-slate-200 px-2.5 py-1.5 text-[13px] focus:outline-none focus:ring-2 focus:ring-[#0B1220]/10"
            />
          </label>
          <label className="block">
            <span className="text-[11px] text-slate-400">Město</span>
            <CityAutocomplete
              value={czParts.city}
              onChange={(v) => setCzPart("city", v)}
              onSelect={(name, psc) => { setCzPart("city", name); setCzPart("psc", psc); }}
              cityTable={CZ_CITY_PSC}
              placeholder="Praha"
            />
          </label>
          <label className="block">
            <span className="text-[11px] text-slate-400">
              PSČ {cityMatch && <span className="text-emerald-600">· doplněno automaticky</span>}
            </span>
            <input
              value={czParts.psc || ""}
              onChange={(e) => setCzPart("psc", e.target.value)}
              placeholder="100 00"
              className="mt-1 w-full rounded-xl border border-slate-200 px-2.5 py-1.5 text-[13px] focus:outline-none focus:ring-2 focus:ring-[#0B1220]/10"
            />
          </label>
        </div>
      </div>

      {/* Block 2 — home country address, country picked via short tabs */}
      <div className="rounded-xl border border-slate-200 p-3 bg-slate-50/40">
        <div className="flex items-center justify-between mb-2">
          <div className="text-[11px] uppercase tracking-wide text-slate-400">Adresa v zemi původu</div>
          <div className="flex gap-1">
            {[["ua", "UA"], ["eu", "EU"]].map(([key, label]) => (
              <button
                key={key}
                type="button"
                onClick={() => setOriginCountry(key)}
                className={`rounded-xl px-2 py-0.5 text-[11px] font-medium border transition-colors
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
              <span className="text-[11px] text-slate-400">Vulytsia, budynok (ulice, číslo)</span>
              <input
                value={originParts.street || ""}
                onChange={(e) => setOriginPart("street", e.target.value)}
                placeholder="vul. Chreščatyk 10"
                autoComplete="off"
                className="mt-1 w-full rounded-xl border border-slate-200 px-2.5 py-1.5 text-[13px] focus:outline-none focus:ring-2 focus:ring-[#0B1220]/10"
              />
            </label>
            <label className="block">
              <span className="text-[11px] text-slate-400">Misto (město)</span>
              <CityAutocomplete
                value={originParts.city}
                onChange={(v) => setOriginPart("city", v)}
                onSelect={(name, psc) => { setOriginPart("city", name); setOriginPart("psc", psc); }}
                cityTable={UA_CITY_PSC}
                placeholder="Kyjev"
              />
            </label>
            <label className="block">
              <span className="text-[11px] text-slate-400">
                Indeks {uaCityMatch && <span className="text-emerald-600">· auto</span>}
              </span>
              <input
                value={originParts.psc || ""}
                onChange={(e) => setOriginPart("psc", e.target.value)}
                placeholder="01001"
                className="mt-1 w-full rounded-xl border border-slate-200 px-2.5 py-1.5 text-[13px] focus:outline-none focus:ring-2 focus:ring-[#0B1220]/10"
              />
            </label>
          </div>
        ) : (
          <div className="grid grid-cols-2 gap-x-3 gap-y-4">
            <label className="block col-span-2">
              <span className="text-[11px] text-slate-400">Ulice a číslo</span>
              <input
                value={originParts.street || ""}
                onChange={(e) => setOriginPart("street", e.target.value)}
                autoComplete="off"
                className="mt-1 w-full rounded-xl border border-slate-200 px-2.5 py-1.5 text-[13px] focus:outline-none focus:ring-2 focus:ring-[#0B1220]/10"
              />
            </label>
            <label className="block">
              <span className="text-[11px] text-slate-400">Město</span>
              <input
                value={originParts.city || ""}
                onChange={(e) => setOriginPart("city", e.target.value)}
                className="mt-1 w-full rounded-xl border border-slate-200 px-2.5 py-1.5 text-[13px] focus:outline-none focus:ring-2 focus:ring-[#0B1220]/10"
              />
            </label>
            <label className="block">
              <span className="text-[11px] text-slate-400">PSČ</span>
              <input
                value={originParts.psc || ""}
                onChange={(e) => setOriginPart("psc", e.target.value)}
                className="mt-1 w-full rounded-xl border border-slate-200 px-2.5 py-1.5 text-[13px] focus:outline-none focus:ring-2 focus:ring-[#0B1220]/10"
              />
            </label>
            <label className="block col-span-2">
              <span className="text-[11px] text-slate-400">Země</span>
              <input
                value={originParts.country || ""}
                onChange={(e) => setOriginPart("country", e.target.value)}
                placeholder="Polsko, Slovensko, Německo…"
                className="mt-1 w-full rounded-xl border border-slate-200 px-2.5 py-1.5 text-[13px] focus:outline-none focus:ring-2 focus:ring-[#0B1220]/10"
              />
            </label>
          </div>
        )}
      </div>
    </div>
  );
}

export default memo(AddressBuilder);

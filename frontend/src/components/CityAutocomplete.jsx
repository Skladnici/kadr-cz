import { useState, useRef } from "react";
import { MapPin } from "lucide-react";

// Custom autocomplete dropdown for city fields — replaces the native
// <datalist>, which some browsers render as a huge, unstyled system
// popup. Shows up to 6 matches with the typed portion highlighted,
// supports arrow-key navigation + Enter, and calls onSelect(name, psc)
// so the caller can auto-fill PSČ/indeks in the same step.
export default function CityAutocomplete({ value, onChange, onSelect, cityTable, placeholder }) {
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(-1);
  const wrapRef = useRef(null);

  const query = (value || "").trim().toLowerCase();
  const matches = query
    ? Object.keys(cityTable).filter((c) => c.toLowerCase().includes(query)).slice(0, 6)
    : [];

  const highlight = (name) => {
    const idx = name.toLowerCase().indexOf(query);
    if (idx === -1) return name;
    return (
      <>
        {name.slice(0, idx)}
        <b className="font-semibold text-[#0B1220]">{name.slice(idx, idx + query.length)}</b>
        {name.slice(idx + query.length)}
      </>
    );
  };

  const select = (name) => {
    onSelect(name, cityTable[name]);
    setOpen(false);
    setActiveIndex(-1);
  };

  return (
    <div className="relative" ref={wrapRef}>
      <input
        value={value || ""}
        onChange={(e) => { onChange(e.target.value); setOpen(true); setActiveIndex(-1); }}
        onFocus={() => value && setOpen(true)}
        onBlur={() => setTimeout(() => setOpen(false), 150)}
        onKeyDown={(e) => {
          if (!open || matches.length === 0) return;
          if (e.key === "ArrowDown") { e.preventDefault(); setActiveIndex((i) => Math.min(i + 1, matches.length - 1)); }
          else if (e.key === "ArrowUp") { e.preventDefault(); setActiveIndex((i) => Math.max(i - 1, 0)); }
          else if (e.key === "Enter" && activeIndex >= 0) { e.preventDefault(); select(matches[activeIndex]); }
        }}
        placeholder={placeholder}
        autoComplete="off"
        className="mt-1 w-full rounded-md border border-slate-200 px-2.5 py-1.5 text-[13px] focus:outline-none focus:ring-2 focus:ring-[#0B1220]/10"
      />
      {open && matches.length > 0 && (
        <div className="absolute z-20 top-full left-0 right-0 mt-1 rounded-lg border border-slate-200 bg-white shadow-lg max-h-52 overflow-y-auto p-1">
          {matches.map((name, i) => (
            <div
              key={name}
              onMouseDown={(e) => { e.preventDefault(); select(name); }}
              onMouseEnter={() => setActiveIndex(i)}
              className={`flex items-center gap-2 px-2.5 py-2 rounded-md text-[13px] text-slate-700 cursor-pointer ${i === activeIndex ? "bg-slate-100" : ""}`}
            >
              <MapPin size={13} className="text-slate-400 shrink-0" />
              <span>{highlight(name)}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

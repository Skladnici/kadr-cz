import { useState } from "react";
import { AlertTriangle } from "lucide-react";

// Replaces the old full-width banner (see git history for MinorWarning.jsx)
// — a banner above the whole form was too heavy for something advisory.
// This renders only inside the birth_date field's own relative-positioned
// wrapper (see SimpleDocFiller's renderField), so it never affects page
// layout: the popover is absolutely positioned and floats above whatever
// is below it instead of pushing it down. Same advisory-only spirit as
// the IČO/DIČ checks in utils/validation.js — this never blocks
// generation, it only surfaces the same explanation the banner used to.
export default function MinorWarningIcon() {
  const [hovered, setHovered] = useState(false);
  const [pinned, setPinned] = useState(false);
  const expanded = hovered || pinned;

  return (
    <div className="absolute right-2 top-1/2 -translate-y-1/2">
      <button
        type="button"
        aria-expanded={expanded}
        aria-label="Nezletilá osoba — zobrazit podrobnosti"
        onClick={() => setPinned((v) => !v)}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            setPinned((v) => !v);
          }
        }}
        onMouseEnter={() => setHovered(true)}
        onMouseLeave={() => setHovered(false)}
        className="flex h-4 w-4 items-center justify-center rounded-full text-amber-600 focus:outline-none focus:ring-2 focus:ring-amber-300"
      >
        <AlertTriangle size={14} />
      </button>
      {expanded && (
        <div
          onMouseEnter={() => setHovered(true)}
          onMouseLeave={() => setHovered(false)}
          className="absolute right-0 top-full z-20 mt-1.5 w-64 rounded-xl bg-amber-50 p-2.5 text-[11.5px] leading-snug text-amber-700 shadow-lg"
        >
          Podle rozpoznaného data narození je této osobě méně než 18 let.
          Pracovní smlouvy s nezletilými mají zvláštní právní požadavky
          (souhlas zákonného zástupce, omezení druhu práce a pracovní doby).
          Ověřte prosím podmínky před vygenerováním dokumentu.
        </div>
      )}
    </div>
  );
}

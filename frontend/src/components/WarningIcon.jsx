import { useState } from "react";
import { AlertTriangle } from "lucide-react";

// Generic version of the same compact, click-to-expand badge
// MinorWarningIcon pioneered (see that component for the original
// reasoning: a full-width banner was too heavy for something
// advisory-only) — extracted so new advisory badges (expired visa,
// "strpění" residence status, ...) reuse the exact same look and
// interaction instead of each growing its own near-identical component.
// Shared between single mode (SimpleDocFiller) and batch mode
// (PersonCard) so both modes' badges are pixel-identical.
export default function WarningIcon({ ariaLabel, children }) {
  const [hovered, setHovered] = useState(false);
  const [pinned, setPinned] = useState(false);
  const expanded = hovered || pinned;

  return (
    // `inset-y-0` (not `top-1/2 -translate-y-1/2`) so this wrapper's own
    // box spans the *whole* input height, with the button merely
    // flex-centered inside it — real bug this fixes: the previous
    // top-1/2/-translate-y-1/2 wrapper was only as tall as the 16px
    // button itself, so the popover's `top-full` below anchored to the
    // vertical middle of the input rather than its actual bottom edge,
    // making the expanded popover start partway through the input and
    // spill further down than intended into the next form row —
    // swallowing hover/click there while the popover was open.
    <div className="absolute inset-y-0 right-2 flex items-center">
      <button
        type="button"
        aria-expanded={expanded}
        aria-label={ariaLabel}
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
          {children}
        </div>
      )}
    </div>
  );
}

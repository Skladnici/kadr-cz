import { useEffect, useRef, useState } from "react";
import { AlertTriangle } from "lucide-react";

// Generic version of the same compact, click-to-expand badge
// MinorWarningIcon pioneered (see that component for the original
// reasoning: a full-width banner was too heavy for something
// advisory-only) — extracted so new advisory badges (expired visa,
// "strpění" residence status, name mismatch, ...) reuse the exact same
// look and interaction instead of each growing its own near-identical
// component. Shared between single mode (SimpleDocFiller) and batch
// mode (PersonCard) so both modes' badges are pixel-identical.
//
// The expanded text used to be a `position: absolute` popover anchored
// below the input (`top-full`) — real bug that caused: because it was
// taken out of normal flow, opening it never grew the field's own
// height, so it just floated on top of whatever the next form row
// happened to be, swallowing that row's hover/click while open instead
// of pushing it down. Fixed by rendering the expanded text as a normal,
// in-flow block instead: every field sits in a `grid grid-cols-2`
// column (SimpleDocFiller/PersonCard), so a taller field naturally
// grows that grid row and pushes every row below it down — no manual
// reflow needed, CSS Grid does it for free.
//
// That only works if the small triangle button itself stays pinned to
// the *input's* height, not the now-variable height of input+expanded
// text combined — `inset-y-0` (stretch-to-full-parent-height) would
// otherwise re-center the button halfway into the expanded text every
// time it opens. `top-0 h-8 md:h-11` fixes the button's box to the
// input's own (fixed, responsive) height instead, so it stays anchored
// to the input regardless of what renders below it.
export default function WarningIcon({ ariaLabel, children }) {
  const [hovered, setHovered] = useState(false);
  const [pinned, setPinned] = useState(false);
  const expanded = hovered || pinned;
  // `display: contents` (the `contents` class) so this wrapper generates
  // no box of its own — its two children (button + expanded text) lay
  // out exactly as if they were direct children of the caller's
  // `relative` wrapper, same as before this was wrapped in a single
  // element. It exists purely to give the click-outside listener below
  // one ref covering both pieces.
  const rootRef = useRef(null);

  // Click outside closes a pinned (click-opened) popover. Hover-opened
  // ones already close on mouseleave and never reach here.
  useEffect(() => {
    if (!pinned) return undefined;
    const onPointerDown = (e) => {
      if (rootRef.current && !rootRef.current.contains(e.target)) {
        setPinned(false);
      }
    };
    document.addEventListener("mousedown", onPointerDown);
    return () => document.removeEventListener("mousedown", onPointerDown);
  }, [pinned]);

  return (
    <div ref={rootRef} className="contents">
      <div className="absolute right-2 top-0 h-8 md:h-11 flex items-center">
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
      </div>
      {expanded && (
        <div
          onMouseEnter={() => setHovered(true)}
          onMouseLeave={() => setHovered(false)}
          className="mt-1.5 w-full rounded-xl bg-amber-50 p-2.5 text-[11.5px] leading-snug text-amber-700 shadow-sm"
        >
          {children}
        </div>
      )}
    </div>
  );
}

import { useEffect, useState } from "react";
import { Check, AlertTriangle } from "lucide-react";

// How long the toast stays fully visible before starting its exit —
// counted from mount, same "hold, then play a real exit animation before
// unmounting" shape as WelcomeToast/SignedDocsNotifier's own panel.
const HOLD_MS = 2200;
// Matches .toast-out's own duration in index.css, so the DOM node
// disappears right as the fade-out finishes rather than snapping away
// mid-animation or leaving a visible gap after.
const OUT_ANIM_MS = 250;

// Bottom-of-screen, fade+slide notification — success (green, per the
// app's color system: green means "done/succeeded", nothing else) is the
// only tone actually in use today (document generation), but `tone`
// stays open for a real-error case without every call site needing to
// know the class names.
export default function Toast({ message, tone = "success", onDone }) {
  const [closing, setClosing] = useState(false);

  useEffect(() => {
    const closeTimer = setTimeout(() => setClosing(true), HOLD_MS);
    const doneTimer = setTimeout(onDone, HOLD_MS + OUT_ANIM_MS);
    return () => {
      clearTimeout(closeTimer);
      clearTimeout(doneTimer);
    };
  }, [onDone]);

  const isSuccess = tone === "success";

  return (
    <div className="fixed bottom-6 left-1/2 -translate-x-1/2 z-50 px-4 pointer-events-none">
      <div
        className={`flex items-center gap-2 rounded-xl px-4 py-2.5 text-[13px] font-medium shadow-[0_8px_24px_-8px_rgba(11,18,32,0.35)] ${
          isSuccess ? "bg-[#eaf3de] text-[#3B6D11]" : "bg-red-50 text-red-700"
        } ${closing ? "toast-out" : "toast-in"}`}
      >
        {isSuccess ? <Check size={14} className="shrink-0" /> : <AlertTriangle size={14} className="shrink-0" />}
        {message}
      </div>
    </div>
  );
}

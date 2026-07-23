import { useEffect } from "react";

// Purely decorative, one-shot greeting shown right after a successful
// login (mounted only from handleLogin's success branch in
// SimpleDocFiller.jsx — never from session-restore on page reload, so it
// only ever appears on an actual new sign-in, not every time the app
// loads with a still-valid session). Fixed positioning + pointer-events
// none means it never shifts the form underneath and never blocks
// interacting with it while animating in or out — see the .welcome-toast
// keyframes in index.css for the timing this component's own unmount
// timer is kept in sync with.
export default function WelcomeToast({ onDone }) {
  useEffect(() => {
    // Matches .welcome-toast's total animation time in index.css (0.4s in
    // + 2.2s hold + 0.3s out = 2.5s) so the card unmounts right as the
    // fade-out finishes, not before or with a visible gap after.
    const timer = setTimeout(onDone, 2500);
    return () => clearTimeout(timer);
  }, [onDone]);

  return (
    <div className="fixed top-6 left-1/2 -translate-x-1/2 z-40 w-full max-w-xs px-4 pointer-events-none">
      <div
        className="welcome-toast rounded-2xl px-6 py-5 text-center shadow-[0_12px_32px_-12px_rgba(4,44,83,0.45)]"
        style={{ background: "var(--gradient-primary)" }}
      >
        <div className="text-[19px] font-semibold text-white leading-tight">Dobrý den</div>
        <div className="mt-1 text-[12.5px] text-white/70">Vyberte typ zpracování a pokračujte.</div>
      </div>
    </div>
  );
}

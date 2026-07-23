import { useEffect, useMemo } from "react";

// Time-of-day greeting, per Czech convention — Vítejte for the late-night
// window instead of a literal "good night" (that would read as "goodbye"
// rather than "welcome" in this context). Boundaries all fall on whole
// hours, so bucketing by getHours() alone (ignoring minutes) is exact.
function getGreeting(hour) {
  if (hour >= 5 && hour <= 10) return "Dobré ráno";
  if (hour >= 11 && hour <= 17) return "Dobrý den";
  if (hour >= 18 && hour <= 22) return "Dobrý večer";
  return "Vítejte"; // 23:00–4:59
}

// Purely decorative, one-shot greeting shown right after a successful
// login (mounted only from handleLogin's success branch in
// SimpleDocFiller.jsx — never from session-restore on page reload, so it
// only ever appears on an actual new sign-in, not every time the app
// loads with a still-valid session). Fixed positioning + pointer-events
// none means it never shifts the form underneath and never blocks
// interacting with it while animating in or out — see the .welcome-toast-*
// rules in index.css for the timing this component's own unmount timer
// is kept in sync with.
export default function WelcomeToast({ onDone }) {
  const greeting = useMemo(() => getGreeting(new Date().getHours()), []);

  useEffect(() => {
    // Matches index.css's total animation time (2.8s hold, counted from
    // mount, + 0.9s fade-out = 3.7s) so the card unmounts right as the
    // fade-out finishes, not before or with a visible gap after.
    const timer = setTimeout(onDone, 3700);
    return () => clearTimeout(timer);
  }, [onDone]);

  return (
    <div className="fixed top-6 left-1/2 -translate-x-1/2 z-40 w-full max-w-xs px-4 pointer-events-none">
      <div className="welcome-toast-frame rounded-[18px]">
        <div className="welcome-toast-glass rounded-[18px] px-[34px] py-5 text-center">
          <span className="welcome-toast-sheen" aria-hidden="true" />
          <div className="welcome-toast-text">
            <div className="welcome-toast-eyebrow">KADR.CZ</div>
            <div className="welcome-toast-title">{greeting}</div>
            <div className="welcome-toast-subtitle">Vyberte typ zpracování a pokračujte.</div>
          </div>
        </div>
      </div>
    </div>
  );
}

// Two-tone "someone just signed" chime for SignedDocsNotifier — built
// from oscillators (Web Audio API) rather than an audio file, so there's
// nothing to fetch and no format/licensing concerns.
//
// iOS Safari (and most browsers) refuse to run an AudioContext until it's
// been created/resumed inside a real user gesture — this poll-driven
// chime has no click of its own to piggyback on, so instead we opportunistically
// resume one shared AudioContext on every real user gesture anywhere on
// the page (not just the first one — see keepPrimed below), then just
// resume() it again (a no-op if already running) before every later,
// gesture-less play triggered by the background poll.
let ctx = null;

function getContext() {
  if (ctx) return ctx;
  const AudioContextClass = window.AudioContext || window.webkitAudioContext;
  if (!AudioContextClass) return null;
  ctx = new AudioContextClass();
  return ctx;
}

function keepPrimed() {
  const c = getContext();
  if (!c || c.state !== "suspended") return;
  c.resume().catch(() => {});
}

// NOT { once: true } — mobile browsers (iOS Safari especially) can
// re-suspend an already-unlocked AudioContext on their own later (screen
// lock, a phone call/Siri interruption, low-power mode, just being
// backgrounded and returned to) — a single first-tap unlock isn't
// durable the way it is on desktop. Re-checking (cheaply — this is a
// no-op whenever the context is already running) on every later tap/key
// anywhere in the app means the NEXT real interaction after any such
// interruption quietly re-arms the chime instead of it staying silently
// dead until a page reload. touchend/click cover mobile taps
// specifically — Safari's "was this a legitimate user gesture" check
// has historically been pickier about which event types count than
// desktop's pointerdown/mousedown/keydown are.
if (typeof window !== "undefined") {
  const events = ["pointerdown", "mousedown", "touchend", "click", "keydown"];
  for (const evt of events) {
    window.addEventListener(evt, keepPrimed, { capture: true, passive: true });
  }
}

function playTone(c, freq, startAt, duration, peakGain) {
  const osc = c.createOscillator();
  const gain = c.createGain();
  osc.type = "sine";
  osc.frequency.value = freq;
  osc.connect(gain);
  gain.connect(c.destination);

  const attack = 0.012;
  gain.gain.setValueAtTime(0.0001, startAt);
  gain.gain.linearRampToValueAtTime(peakGain, startAt + attack);
  gain.gain.exponentialRampToValueAtTime(0.0001, startAt + duration);

  osc.start(startAt);
  osc.stop(startAt + duration + 0.02);
}

// A5 (880 Hz) then E6 (1318.5 Hz), the second starting 70ms after the
// first so they overlap slightly instead of reading as two separate
// blips.
export function playSignChime() {
  const c = getContext();
  if (!c) return;
  if (c.state === "suspended") c.resume().catch(() => {});
  try {
    const now = c.currentTime;
    playTone(c, 880, now, 0.18, 0.35);
    playTone(c, 1318.5, now + 0.07, 0.26, 0.28);
  } catch {
    // best-effort — a missed chime is not worth surfacing to the admin
  }
}

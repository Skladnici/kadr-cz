// Two-tone "someone just signed" chime for SignedDocsNotifier — built
// from oscillators (Web Audio API) rather than an audio file, so there's
// nothing to fetch and no format/licensing concerns.
//
// iOS Safari (and most browsers) refuse to run an AudioContext until it's
// been created/resumed inside a real user gesture — this poll-driven
// chime has no click of its own to piggyback on, so instead we prime one
// shared AudioContext off the very first pointerdown/keydown anywhere on
// the page, then just resume() it (a no-op if already running) before
// every later, gesture-less play triggered by the background poll.
let ctx = null;

function getContext() {
  if (ctx) return ctx;
  const AudioContextClass = window.AudioContext || window.webkitAudioContext;
  if (!AudioContextClass) return null;
  ctx = new AudioContextClass();
  return ctx;
}

function primeOnce() {
  const c = getContext();
  // TEMP DEBUG — see playSignChime's own note; search "SIGN-SOUND-DEBUG".
  console.log("[SIGN-SOUND-DEBUG] primeOnce fired (first click/keypress on the page), context:", c && c.state);
  if (c && c.state === "suspended") {
    c.resume().then(
      () => console.log("[SIGN-SOUND-DEBUG] primeOnce resume() resolved, state now:", c.state),
      (err) => console.error("[SIGN-SOUND-DEBUG] primeOnce resume() rejected:", err)
    );
  }
}

if (typeof window !== "undefined") {
  window.addEventListener("pointerdown", primeOnce, { once: true, capture: true });
  window.addEventListener("keydown", primeOnce, { once: true, capture: true });
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
  // TEMP DEBUG — remove once the "no sound at all" report is confirmed
  // fixed on a real deploy. Search "SIGN-SOUND-DEBUG" to find every line
  // to strip.
  const c = getContext();
  console.log("[SIGN-SOUND-DEBUG] playSignChime called, context:", c && { state: c.state, currentTime: c.currentTime });
  if (!c) {
    console.log("[SIGN-SOUND-DEBUG] no AudioContext available (window.AudioContext/webkitAudioContext missing)");
    return;
  }
  if (c.state === "suspended") {
    console.log("[SIGN-SOUND-DEBUG] context suspended, calling resume()");
    c.resume().then(
      () => console.log("[SIGN-SOUND-DEBUG] resume() resolved, state now:", c.state),
      (err) => console.error("[SIGN-SOUND-DEBUG] resume() rejected:", err)
    );
  }
  try {
    const now = c.currentTime;
    playTone(c, 880, now, 0.18, 0.35);
    playTone(c, 1318.5, now + 0.07, 0.26, 0.28);
    console.log("[SIGN-SOUND-DEBUG] both tones scheduled at currentTime =", now, "state =", c.state);
  } catch (err) {
    console.error("[SIGN-SOUND-DEBUG] playTone threw:", err);
  }
}

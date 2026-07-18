// Shared sliding-window pacing for the two batch-mode queues (OCR
// recognition and contract generation) — both backend routes are
// independently capped at 10 requests/minute per IP (see
// backend/app/main.py's @limiter.limit("10/minute") on /api/recognize and
// /api/fill), and a queue that fires requests as fast as it can would
// blow straight through that and start getting 429s partway through a
// batch of more than 10 people.

export const BATCH_RATE_LIMIT = 10;
export const BATCH_RATE_WINDOW_MS = 60000;

// Pacing itself deliberately targets one request fewer than the server's
// real cap. In testing, a queue paced at exactly 10/60s still drew an
// occasional 429 from the backend — the server-side limiter's window
// doesn't start counting from the same instant this client's does, so
// pacing to the literal published number leaves zero margin for that
// clock skew. The ETA text shown to the user still reads against the
// real BATCH_RATE_LIMIT (10) below, since that's the number the task
// asks the estimate to be based on — this safety margin is purely
// internal to how the queue paces itself.
const PACE_SAFETY_LIMIT = BATCH_RATE_LIMIT - 1;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Call this immediately before firing each request in a sequential queue,
// passing a useRef([]) that's dedicated to that one queue (recognize and
// fill need separate refs — they're separate rate-limit buckets
// server-side). Resolves right away if fewer than `limit` calls have
// started within the trailing `windowMs`; otherwise waits until the
// oldest of those calls ages out of the window. Also records this call's
// start time into the ref, so callers don't need a separate bookkeeping
// step — and persists across a queue being appended to later (e.g. "+
// Přidat další" mid-batch), since it's the same ref the whole time, not
// reset per batch.
export async function paceRateLimit(startTimesRef, limit = PACE_SAFETY_LIMIT, windowMs = BATCH_RATE_WINDOW_MS) {
  const now = Date.now();
  startTimesRef.current = startTimesRef.current.filter((t) => now - t < windowMs);
  if (startTimesRef.current.length >= limit) {
    const oldest = startTimesRef.current[0];
    const wait = windowMs - (now - oldest);
    if (wait > 0) await sleep(wait);
  }
  startTimesRef.current.push(Date.now());
}

// Even with the pacing above, a 429 can still slip through — another
// browser tab/teammate sharing the same office IP, or plain clock skew
// against the server's own window. Rather than permanently failing that
// one person's card over what's actually a transient, fully-recoverable
// condition, retry it after backing off a full window (the backend's own
// 429 response already advertises Retry-After: 60 for exactly this
// reason — see backend/app/main.py's _rate_limit_exceeded_handler).
// Bounded to a couple of retries so a persistent failure (bad file, 401,
// ...) still surfaces instead of looping forever.
export async function runWithRetry(fn, { retries = 2, waitMs = BATCH_RATE_WINDOW_MS } = {}) {
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn();
    } catch (e) {
      if (e?.status === 429 && attempt < retries) {
        await sleep(waitMs);
        continue;
      }
      throw e;
    }
  }
}

// A plain reading of "remaining count ÷ rate limit" — not modeling actual
// observed per-request latency, just the floor imposed by the shared
// 10/minute cap, which is what the pacing above actually enforces once a
// queue is longer than `limit` items.
export function estimateSecondsRemaining(remainingCount, limit = BATCH_RATE_LIMIT, windowMs = BATCH_RATE_WINDOW_MS) {
  if (remainingCount <= 0) return 0;
  return Math.ceil((remainingCount / limit) * (windowMs / 1000));
}

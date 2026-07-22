import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { paceRateLimit, BATCH_RATE_LIMIT, BATCH_RATE_WINDOW_MS } from "./rateLimitQueue";

// Simulates a sequential batch queue exactly like BatchDocFiller's
// runRecognizeQueue: paceRateLimit() then an awaited "request" with
// realistic Render-observed latency (1.2-2.1s per the logs that
// prompted this test), repeated for a batch bigger than the pacer's
// safety limit (9) so the old burst-then-cliff behavior would show up.
async function simulateBatch(fileCount, requestLatencyMs) {
  const startTimesRef = { current: [] };
  const requestStarts = [];
  for (let i = 0; i < fileCount; i++) {
    await paceRateLimit(startTimesRef);
    requestStarts.push(Date.now());
    await new Promise((resolve) => setTimeout(resolve, requestLatencyMs));
  }
  return requestStarts;
}

describe("paceRateLimit", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("spaces every request evenly instead of bursting 9 then stalling ~47s", async () => {
    const fileCount = 10;
    const requestLatencyMs = 1700; // mid-point of the observed 1.2-2.1s
    const resultPromise = simulateBatch(fileCount, requestLatencyMs);
    await vi.runAllTimersAsync();
    const starts = await resultPromise;

    const gaps = [];
    for (let i = 1; i < starts.length; i++) gaps.push(starts[i] - starts[i - 1]);

    const expectedInterval = BATCH_RATE_WINDOW_MS / (BATCH_RATE_LIMIT - 1); // ~6667ms
    // No gap should come anywhere near the old ~47s stall — this is the
    // regression this test guards against.
    for (const gap of gaps) {
      expect(gap).toBeLessThan(expectedInterval + requestLatencyMs + 500);
    }
    // And pacing shouldn't be *tighter* than the safety-margin interval either.
    for (const gap of gaps) {
      expect(gap).toBeGreaterThanOrEqual(expectedInterval - 1);
    }
  });

  it("never exceeds the safety-margin request count within any 60s window", async () => {
    const fileCount = 15;
    const starts = await (async () => {
      const p = simulateBatch(fileCount, 1500);
      await vi.runAllTimersAsync();
      return p;
    })();
    for (let i = 0; i < starts.length; i++) {
      const windowCount = starts.filter((t) => t > starts[i] - BATCH_RATE_WINDOW_MS && t <= starts[i]).length;
      expect(windowCount).toBeLessThanOrEqual(BATCH_RATE_LIMIT - 1);
    }
  });
});

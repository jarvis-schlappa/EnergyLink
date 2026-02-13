import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

/**
 * Tests für die UDP-Retry-Logik.
 * 
 * Testet die Retry-Funktion isoliert, ohne den vollen UDP-Stack zu brauchen.
 * Die eigentliche Retry-Logik ist ein Wrapper um sendUdpCommandOnce.
 */

// Mock den gesamten Transport-Layer und teste nur die Retry-Logik
// Wir extrahieren die Retry-Logik als testbare Funktion

describe("UDP Retry Logic", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  /**
   * Simuliert die Retry-Logik aus sendUdpCommand als isolierte Funktion.
   * Gleicher Algorithmus wie in wallbox-transport.ts.
   */
  async function retryWithBackoff<T>(
    fn: () => Promise<T>,
    config: { maxAttempts: number; baseDelayMs: number; backoffFactor: number }
  ): Promise<T> {
    for (let attempt = 1; attempt <= config.maxAttempts; attempt++) {
      try {
        return await fn();
      } catch (error) {
        const isTimeout = error instanceof Error && error.message.includes("timeout");
        const isLastAttempt = attempt >= config.maxAttempts;

        if (!isTimeout || isLastAttempt) {
          throw error;
        }

        const delay = config.baseDelayMs * Math.pow(config.backoffFactor, attempt - 1);
        await new Promise(resolve => setTimeout(resolve, delay));
      }
    }
    throw new Error("retry logic error");
  }

  it("should succeed on first attempt without retry", async () => {
    const fn = vi.fn().mockResolvedValue({ ID: 2, State: 3 });

    const result = await retryWithBackoff(fn, {
      maxAttempts: 3,
      baseDelayMs: 500,
      backoffFactor: 2,
    });

    expect(result).toEqual({ ID: 2, State: 3 });
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("should retry on timeout and succeed on second attempt", async () => {
    const fn = vi.fn()
      .mockRejectedValueOnce(new Error("UDP request timeout"))
      .mockResolvedValueOnce({ ID: 2, State: 2 });

    const promise = retryWithBackoff(fn, {
      maxAttempts: 3,
      baseDelayMs: 100,
      backoffFactor: 2,
    });

    // Advance past backoff delay (100ms)
    await vi.advanceTimersByTimeAsync(200);

    const result = await promise;
    expect(result).toEqual({ ID: 2, State: 2 });
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it("should use exponential backoff between retries", async () => {
    const fn = vi.fn()
      .mockRejectedValueOnce(new Error("UDP request timeout"))
      .mockRejectedValueOnce(new Error("UDP request timeout"))
      .mockResolvedValueOnce({ ID: 1 });

    const promise = retryWithBackoff(fn, {
      maxAttempts: 3,
      baseDelayMs: 100,
      backoffFactor: 2,
    });

    // First backoff: 100ms * 2^0 = 100ms
    await vi.advanceTimersByTimeAsync(100);
    expect(fn).toHaveBeenCalledTimes(2);

    // Second backoff: 100ms * 2^1 = 200ms
    await vi.advanceTimersByTimeAsync(200);
    expect(fn).toHaveBeenCalledTimes(3);

    const result = await promise;
    expect(result).toEqual({ ID: 1 });
  });

  it("should throw after all retries exhausted", async () => {
    const fn = vi.fn()
      .mockRejectedValueOnce(new Error("UDP request timeout"))
      .mockRejectedValueOnce(new Error("UDP request timeout"));

    let caughtError: Error | null = null;
    const promise = retryWithBackoff(fn, {
      maxAttempts: 2,
      baseDelayMs: 100,
      backoffFactor: 2,
    }).catch(e => { caughtError = e as Error; });

    // Advance past first backoff
    await vi.advanceTimersByTimeAsync(200);
    await promise;

    expect(caughtError?.message).toContain("timeout");
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it("should not retry on non-timeout errors", async () => {
    const fn = vi.fn()
      .mockRejectedValueOnce(new Error("Socket nicht verfügbar"));

    let caughtError: Error | null = null;
    try {
      await retryWithBackoff(fn, { maxAttempts: 3, baseDelayMs: 100, backoffFactor: 2 });
    } catch (e) {
      caughtError = e as Error;
    }

    expect(caughtError?.message).toBe("Socket nicht verfügbar");
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("should work with maxAttempts=1 (no retry)", async () => {
    const fn = vi.fn()
      .mockRejectedValueOnce(new Error("UDP request timeout"));

    let caughtError: Error | null = null;
    try {
      await retryWithBackoff(fn, { maxAttempts: 1, baseDelayMs: 100, backoffFactor: 2 });
    } catch (e) {
      caughtError = e as Error;
    }

    expect(caughtError?.message).toContain("timeout");
    expect(fn).toHaveBeenCalledTimes(1);
  });
});

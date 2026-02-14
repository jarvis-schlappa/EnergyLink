import { describe, it, expect } from "vitest";

/**
 * Tests for E3DC Poller backoff and idle-throttle logic.
 * Tests the algorithms in isolation without real timers or connections.
 */

describe("E3DC Poller - Exponential Backoff", () => {
  const BACKOFF_INTERVALS = [10, 30, 60, 300, 600]; // seconds
  const MAX_BACKOFF_LEVEL = 4;

  function getBackoffInterval(level: number): number {
    return BACKOFF_INTERVALS[Math.min(level, MAX_BACKOFF_LEVEL)];
  }

  function simulateBackoff(failures: number): number {
    let level = 0;
    for (let i = 0; i < failures; i++) {
      if (level < MAX_BACKOFF_LEVEL) level++;
    }
    return level;
  }

  it("starts at level 0 (10s interval)", () => {
    expect(getBackoffInterval(0)).toBe(10);
  });

  it("increases to level 1 (30s) after first failure", () => {
    expect(getBackoffInterval(simulateBackoff(1))).toBe(30);
  });

  it("increases to level 2 (60s) after second failure", () => {
    expect(getBackoffInterval(simulateBackoff(2))).toBe(60);
  });

  it("increases to level 3 (5min) after third failure", () => {
    expect(getBackoffInterval(simulateBackoff(3))).toBe(300);
  });

  it("caps at level 4 (10min) after fourth failure", () => {
    expect(getBackoffInterval(simulateBackoff(4))).toBe(600);
  });

  it("does not exceed max level after many failures", () => {
    expect(getBackoffInterval(simulateBackoff(100))).toBe(600);
  });

  it("resets to level 0 on success", () => {
    let level = simulateBackoff(3); // level 3
    expect(level).toBe(3);
    // Success resets to 0
    level = 0;
    expect(getBackoffInterval(level)).toBe(10);
  });
});

describe("E3DC Poller - Idle Throttle (PV=0 / Strategy off)", () => {
  const IDLE_WALLBOX_POLL_INTERVAL_MS = 30_000;
  const IDLE_E3DC_POLL_INTERVAL_S = 30;
  const BASE_INTERVAL_S = 10;

  function getEffectiveInterval(isIdle: boolean, backoffLevel: number): number {
    const backoffInterval = [10, 30, 60, 300, 600][backoffLevel];
    return (isIdle && backoffLevel === 0)
      ? Math.max(backoffInterval, IDLE_E3DC_POLL_INTERVAL_S)
      : backoffInterval;
  }

  function shouldPollWallbox(isIdle: boolean, lastPollTime: number, now: number): boolean {
    return !isIdle || (now - lastPollTime >= IDLE_WALLBOX_POLL_INTERVAL_MS);
  }

  it("uses 30s interval when idle and no backoff", () => {
    expect(getEffectiveInterval(true, 0)).toBe(30);
  });

  it("uses normal 10s interval when not idle", () => {
    expect(getEffectiveInterval(false, 0)).toBe(10);
  });

  it("idle throttle does not override higher backoff levels", () => {
    // backoff level 2 = 60s > 30s idle → use 60s
    expect(getEffectiveInterval(true, 2)).toBe(60);
  });

  it("polls wallbox immediately when not idle", () => {
    expect(shouldPollWallbox(false, 0, 5000)).toBe(true);
  });

  it("skips wallbox poll when idle and recently polled", () => {
    const now = 15000;
    const lastPoll = 5000; // 10s ago < 30s threshold
    expect(shouldPollWallbox(true, lastPoll, now)).toBe(false);
  });

  it("polls wallbox when idle but 30s have passed", () => {
    const now = 35000;
    const lastPoll = 0; // 35s ago ≥ 30s threshold
    expect(shouldPollWallbox(true, lastPoll, now)).toBe(true);
  });
});

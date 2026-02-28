/**
 * Stale Power Cache Test (Issue #79, Bug A)
 *
 * When fetchAndBroadcastStatus() in broadcast-listener sends updated wallbox
 * data via SSE, it must also update lastCachedStatus in wallbox-routes.
 * Otherwise, /api/status returns stale power values from the last HTTP poll.
 *
 * Root cause: lastCachedStatus was only set in the /api/wallbox/status HTTP
 * endpoint. SSE broadcasts (triggered by E pres, State, Plug changes) did
 * NOT update the cache → /api/status showed stale wbPower.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";

// Mock logger before importing modules
vi.mock("../core/logger", () => ({ log: vi.fn() }));

import {
  getLastCachedWallboxStatus,
  updateLastCachedWallboxStatus,
} from "../routes/wallbox-routes";

describe("Wallbox status cache update via broadcasts (Issue #79)", () => {
  beforeEach(() => {
    // Reset cache to null by updating with null-like state
    // Note: We test the exported functions directly
    vi.clearAllMocks();
  });

  it("updateLastCachedWallboxStatus should update the cached status", () => {
    const status = {
      state: 3,
      plug: 7,
      power: 7.5,  // kW
      enableSys: 1,
      maxCurr: 32,
      ePres: 5000,
      eTotal: 100000,
      phases: 1,
      i1: 32,
      i2: 0,
      i3: 0,
      lastUpdated: new Date().toISOString(),
    };

    updateLastCachedWallboxStatus(status);
    const cached = getLastCachedWallboxStatus();

    expect(cached).not.toBeNull();
    expect(cached!.power).toBe(7.5);
    expect(cached!.state).toBe(3);
    expect(cached!.plug).toBe(7);
  });

  it("cache should reflect latest broadcast, not stale HTTP poll", () => {
    // Simulate initial HTTP poll with low power (startup)
    const initialStatus = {
      state: 3,
      plug: 7,
      power: 0.004633,  // 4.6W in kW (startup)
      enableSys: 1,
      maxCurr: 32,
      ePres: 10,
      eTotal: 100000,
      phases: 0,
      i1: 0.397,
      i2: 0,
      i3: 0,
      lastUpdated: new Date().toISOString(),
    };
    updateLastCachedWallboxStatus(initialStatus);

    let cached = getLastCachedWallboxStatus();
    expect(cached!.power).toBeCloseTo(0.004633);

    // Simulate broadcast with real charging power
    const broadcastStatus = {
      state: 3,
      plug: 7,
      power: 7.5,  // 7.5kW - real charging
      enableSys: 1,
      maxCurr: 32,
      ePres: 500,
      eTotal: 100500,
      phases: 1,
      i1: 32,
      i2: 0,
      i3: 0,
      lastUpdated: new Date().toISOString(),
    };
    updateLastCachedWallboxStatus(broadcastStatus);

    cached = getLastCachedWallboxStatus();
    // Must reflect broadcast value, not stale initial poll
    expect(cached!.power).toBe(7.5);
  });

  it("getLastCachedWallboxStatus returns only state/plug/power subset", () => {
    updateLastCachedWallboxStatus({
      state: 2,
      plug: 3,
      power: 0,
      enableSys: 1,
      maxCurr: 16,
      ePres: 0,
      eTotal: 0,
      phases: 0,
      i1: 0,
      i2: 0,
      i3: 0,
      lastUpdated: new Date().toISOString(),
    });

    const cached = getLastCachedWallboxStatus();
    expect(cached).toEqual({ state: 2, plug: 3, power: 0 });
    // Should NOT leak other fields
    expect(cached).not.toHaveProperty("enableSys");
    expect(cached).not.toHaveProperty("phases");
  });
});

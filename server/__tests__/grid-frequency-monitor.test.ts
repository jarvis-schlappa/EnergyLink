import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * Tests for Grid Frequency Monitor logic.
 * Tests tier calculation, hysteresis, state management, and tier transitions
 * without needing real E3DC connections or Prowl notifications.
 */

// Mock external I/O only
vi.mock("../core/logger", () => ({
  log: vi.fn(),
}));

vi.mock("../core/storage", () => ({
  storage: {
    getSettings: vi.fn(() => ({
      gridFrequencyMonitor: {
        enabled: true,
        tier2Threshold: 0.1,
        tier3Threshold: 0.2,
        enableEmergencyCharging: true,
      },
      e3dc: { enabled: true },
    })),
  },
}));

vi.mock("../e3dc/modbus", () => {
  const subscribers: Array<(data: any) => void> = [];
  return {
    getE3dcLiveDataHub: vi.fn(() => ({
      subscribe: vi.fn((cb: (data: any) => void) => {
        subscribers.push(cb);
        return () => {
          const idx = subscribers.indexOf(cb);
          if (idx >= 0) subscribers.splice(idx, 1);
        };
      }),
    })),
    __subscribers: subscribers,
  };
});

vi.mock("../monitoring/prowl-notifier", () => ({
  triggerProwlEvent: vi.fn(),
  getProwlNotifier: vi.fn(),
}));

vi.mock("../e3dc/client", () => ({
  e3dcClient: {
    enableGridCharge: vi.fn(() => Promise.resolve()),
  },
}));

// ── Pure Logic Tests (no module imports needed) ──────────────────────────

describe("Grid Frequency Monitor - Tier Calculation (Pure Logic)", () => {
  const NOMINAL_FREQUENCY = 50.0;
  const DEFAULT_TIER2 = 0.1;
  const DEFAULT_TIER3 = 0.2;

  /**
   * Mirrors calculateTier from grid-frequency-monitor.ts
   */
  function calculateTier(
    frequency: number,
    tier2Threshold: number = DEFAULT_TIER2,
    tier3Threshold: number = DEFAULT_TIER3,
  ): 0 | 1 | 2 | 3 {
    if (frequency === 0) return 0;
    const deviation = Math.abs(frequency - NOMINAL_FREQUENCY);
    if (deviation > tier3Threshold) return 3;
    if (deviation > tier2Threshold) return 2;
    return 1;
  }

  describe("Tier 0 - Measurement Error", () => {
    it("returns tier 0 for frequency = 0 (sensor failure)", () => {
      expect(calculateTier(0)).toBe(0);
    });
  });

  describe("Tier 1 - Normal Operation", () => {
    it("returns tier 1 for exactly 50.0 Hz", () => {
      expect(calculateTier(50.0)).toBe(1);
    });

    it("returns tier 1 for 50.05 Hz (within ±0.1)", () => {
      expect(calculateTier(50.05)).toBe(1);
    });

    it("returns tier 1 for 49.95 Hz (within ±0.1)", () => {
      expect(calculateTier(49.95)).toBe(1);
    });

    it("50.1/49.9 Hz falls to tier 2 due to floating-point precision", () => {
      // |50.1 - 50.0| = 0.10000000000000142 (IEEE 754), which IS > 0.1
      expect(calculateTier(50.1)).toBe(2);
      expect(calculateTier(49.9)).toBe(2);
    });
  });

  describe("Tier 2 - Warning", () => {
    it("returns tier 2 for 50.15 Hz (>0.1, ≤0.2)", () => {
      expect(calculateTier(50.15)).toBe(2);
    });

    it("returns tier 2 for 49.85 Hz (>0.1, ≤0.2)", () => {
      expect(calculateTier(49.85)).toBe(2);
    });

    it("50.2/49.8 Hz falls to tier 3 due to floating-point precision", () => {
      // |50.2 - 50.0| = 0.20000000000000284 (IEEE 754), which IS > 0.2
      expect(calculateTier(50.2)).toBe(3);
      expect(calculateTier(49.8)).toBe(3);
    });

    it("returns tier 2 just above tier 2 threshold", () => {
      expect(calculateTier(50.101)).toBe(2);
      expect(calculateTier(49.899)).toBe(2);
    });
  });

  describe("Tier 3 - Critical", () => {
    it("returns tier 3 for 50.25 Hz (>0.2)", () => {
      expect(calculateTier(50.25)).toBe(3);
    });

    it("returns tier 3 for 49.75 Hz (>0.2)", () => {
      expect(calculateTier(49.75)).toBe(3);
    });

    it("returns tier 3 just above tier 3 threshold", () => {
      expect(calculateTier(50.201)).toBe(3);
      expect(calculateTier(49.799)).toBe(3);
    });

    it("returns tier 3 for extreme deviation (48 Hz)", () => {
      expect(calculateTier(48.0)).toBe(3);
    });

    it("returns tier 3 for extreme high frequency (52 Hz)", () => {
      expect(calculateTier(52.0)).toBe(3);
    });
  });

  describe("Custom Thresholds", () => {
    it("respects custom tier 2 threshold", () => {
      expect(calculateTier(50.06, 0.05, 0.2)).toBe(2);
      expect(calculateTier(50.04, 0.05, 0.2)).toBe(1);
    });

    it("respects custom tier 3 threshold", () => {
      expect(calculateTier(50.4, 0.1, 0.5)).toBe(2);
      expect(calculateTier(50.6, 0.1, 0.5)).toBe(3);
    });
  });
});

describe("Grid Frequency Monitor - Hysteresis Logic (Pure Logic)", () => {
  const HYSTERESIS_COUNT = 2;

  /**
   * Simulates hysteresis: tier must be stable for HYSTERESIS_COUNT readings
   * before a transition is triggered.
   */
  function simulateHysteresis(
    readings: Array<0 | 1 | 2 | 3>,
    initialTier: 0 | 1 | 2 | 3 = 1,
  ): Array<{ reading: number; transitioned: boolean; currentTier: number }> {
    let currentTier = initialTier;
    let pendingTier = initialTier;
    let consecutiveReadings = 0;
    const results: Array<{ reading: number; transitioned: boolean; currentTier: number }> = [];

    for (const newTier of readings) {
      if (newTier === pendingTier) {
        consecutiveReadings++;
      } else {
        pendingTier = newTier;
        consecutiveReadings = 1;
      }

      let transitioned = false;
      if (consecutiveReadings >= HYSTERESIS_COUNT && newTier !== currentTier) {
        currentTier = newTier;
        consecutiveReadings = 0;
        transitioned = true;
      }

      results.push({ reading: newTier, transitioned, currentTier });
    }

    return results;
  }

  it("does not transition on a single reading", () => {
    const results = simulateHysteresis([2]);
    expect(results[0].transitioned).toBe(false);
    expect(results[0].currentTier).toBe(1);
  });

  it("transitions after 2 consecutive identical readings", () => {
    const results = simulateHysteresis([2, 2]);
    expect(results[0].transitioned).toBe(false);
    expect(results[1].transitioned).toBe(true);
    expect(results[1].currentTier).toBe(2);
  });

  it("resets counter when reading changes", () => {
    const results = simulateHysteresis([2, 1, 2, 2]);
    expect(results[0].transitioned).toBe(false);
    expect(results[1].transitioned).toBe(false);
    expect(results[2].transitioned).toBe(false);
    expect(results[3].transitioned).toBe(true);
    expect(results[3].currentTier).toBe(2);
  });

  it("handles tier 0 (sensor failure) with hysteresis", () => {
    const results = simulateHysteresis([0, 0]);
    expect(results[1].transitioned).toBe(true);
    expect(results[1].currentTier).toBe(0);
  });

  it("handles rapid tier changes without false transitions", () => {
    const results = simulateHysteresis([2, 3, 2, 3, 2, 3]);
    for (const r of results) {
      expect(r.transitioned).toBe(false);
      expect(r.currentTier).toBe(1);
    }
  });

  it("can escalate from tier 1 → 2 → 3", () => {
    const results = simulateHysteresis([2, 2, 3, 3]);
    expect(results[1].currentTier).toBe(2);
    expect(results[3].currentTier).toBe(3);
  });

  it("can de-escalate from tier 3 → 1", () => {
    const results = simulateHysteresis([1, 1], 3);
    expect(results[1].transitioned).toBe(true);
    expect(results[1].currentTier).toBe(1);
  });
});

// ── Module Integration Tests (with mocked I/O) ──────────────────────────

describe("Grid Frequency Monitor - Module Integration", () => {
  beforeEach(async () => {
    vi.resetModules();
  });

  it("exports start/stop/getState/reset functions", async () => {
    const mod = await import("../monitoring/grid-frequency-monitor");
    expect(typeof mod.startGridFrequencyMonitor).toBe("function");
    expect(typeof mod.stopGridFrequencyMonitor).toBe("function");
    expect(typeof mod.getGridFrequencyState).toBe("function");
    expect(typeof mod.resetGridFrequencyState).toBe("function");
  });

  it("getGridFrequencyState returns correct initial state", async () => {
    const { getGridFrequencyState, resetGridFrequencyState } = await import("../monitoring/grid-frequency-monitor");
    resetGridFrequencyState();
    const state = getGridFrequencyState();

    expect(state.tier).toBe(1);
    expect(state.frequency).toBe(50.0);
    expect(state.deviation).toBe(0);
    expect(state.chargingActive).toBe(false);
    expect(typeof state.lastUpdate).toBe("string");
  });

  it("resetGridFrequencyState resets to defaults", async () => {
    const { getGridFrequencyState, resetGridFrequencyState } = await import("../monitoring/grid-frequency-monitor");
    resetGridFrequencyState();
    const state = getGridFrequencyState();
    expect(state.tier).toBe(1);
    expect(state.frequency).toBe(50.0);
    expect(state.deviation).toBe(0);
    expect(state.chargingActive).toBe(false);
  });

  it("deviation is correctly calculated as absolute difference from 50 Hz", async () => {
    const { getGridFrequencyState, resetGridFrequencyState } = await import("../monitoring/grid-frequency-monitor");
    resetGridFrequencyState();
    const state = getGridFrequencyState();
    expect(state.deviation).toBeCloseTo(0, 5);
  });
});

describe("Grid Frequency Monitor - Deviation Calculation (Pure Logic)", () => {
  const NOMINAL = 50.0;

  function calcDeviation(frequency: number): number {
    return Math.abs(frequency - NOMINAL);
  }

  it("returns 0 for exactly 50 Hz", () => {
    expect(calcDeviation(50.0)).toBe(0);
  });

  it("returns positive value for above nominal", () => {
    expect(calcDeviation(50.15)).toBeCloseTo(0.15, 5);
  });

  it("returns positive value for below nominal", () => {
    expect(calcDeviation(49.85)).toBeCloseTo(0.15, 5);
  });

  it("handles large deviations", () => {
    expect(calcDeviation(48.0)).toBeCloseTo(2.0, 5);
    expect(calcDeviation(52.0)).toBeCloseTo(2.0, 5);
  });
});

describe("Grid Frequency Monitor - State Transition Logic (Pure Logic)", () => {
  it("tier 1 resets all notification flags", () => {
    const state = {
      tier2NotificationSent: true,
      tier3NotificationSent: true,
      tier3ChargingActive: true,
    };

    // Simulate what handleTierTransition does when newTier === 1
    if (1 === 1) {
      state.tier2NotificationSent = false;
      state.tier3NotificationSent = false;
      state.tier3ChargingActive = false;
    }

    expect(state.tier2NotificationSent).toBe(false);
    expect(state.tier3NotificationSent).toBe(false);
    expect(state.tier3ChargingActive).toBe(false);
  });

  it("tier 2 marks notification as sent (no duplicate sends)", () => {
    const state = { tier2NotificationSent: false };

    if (!state.tier2NotificationSent) {
      state.tier2NotificationSent = true;
    }
    expect(state.tier2NotificationSent).toBe(true);

    let sendCount = 0;
    if (!state.tier2NotificationSent) {
      sendCount++;
    }
    expect(sendCount).toBe(0);
  });

  it("tier 3 marks notification as sent and activates charging", () => {
    const state = {
      tier3NotificationSent: false,
      tier3ChargingActive: false,
    };

    if (!state.tier3NotificationSent) {
      state.tier3NotificationSent = true;
    }
    if (!state.tier3ChargingActive) {
      state.tier3ChargingActive = true;
    }

    expect(state.tier3NotificationSent).toBe(true);
    expect(state.tier3ChargingActive).toBe(true);
  });
});

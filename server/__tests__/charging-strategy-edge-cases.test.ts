import { DEFAULT_WALLBOX_IP } from "../core/defaults";
import { describe, it, expect, beforeEach, vi } from "vitest";
import { ChargingStrategyController } from "../strategy/charging-strategy-controller";
import { RealPhaseProvider } from "../strategy/phase-provider";
import { deriveState, evaluate } from "../strategy/charging-state-machine";
import type { StateInput, StateConfig } from "../strategy/charging-state-machine";
import type { E3dcLiveData } from "@shared/schema";

// Reuse mocks from charging-strategy.test.ts
vi.mock("../core/storage", () => {
  const defaultContext = {
    strategy: "off" as const,
    isActive: false,
    currentAmpere: 0,
    targetAmpere: 0,
    currentPhases: 1,
    adjustmentCount: 0,
  };
  const defaultSettings = {
    wallboxIp: DEFAULT_WALLBOX_IP,
    chargingStrategy: {
      activeStrategy: "surplus_battery_prio" as const,
      minStartPowerWatt: 1500,
      stopThresholdWatt: 500,
      startDelaySeconds: 60,
      stopDelaySeconds: 120,
      physicalPhaseSwitch: 1 as const,
      minCurrentChangeAmpere: 1,
      minChangeIntervalSeconds: 30,
      inputX1Strategy: "max_without_battery" as const,
    },
  };
  let context = { ...defaultContext };
  let settings = JSON.parse(JSON.stringify(defaultSettings));
  return {
    storage: {
      getSettings: vi.fn(() => settings),
      saveSettings: vi.fn((s: any) => { settings = s; }),
      getChargingContext: vi.fn(() => context),
      updateChargingContext: vi.fn((updates: any) => { context = { ...context, ...updates }; }),
      saveChargingContext: vi.fn((c: any) => { context = c; }),
      getControlState: vi.fn(() => ({ pvSurplus: false, nightCharging: false, batteryLock: false, gridCharging: false })),
      saveControlState: vi.fn(),
      _reset: () => {
        context = { ...defaultContext };
        settings = JSON.parse(JSON.stringify(defaultSettings));
      },
      _setContext: (c: any) => { context = { ...context, ...c }; },
      _setSettings: (s: any) => { settings = s; },
    },
  };
});

vi.mock("../core/logger", () => ({ log: vi.fn() }));
vi.mock("../e3dc/client", () => ({
  e3dcClient: { isConfigured: vi.fn(() => false), configure: vi.fn(), lockDischarge: vi.fn(), unlockDischarge: vi.fn() },
}));
vi.mock("../e3dc/modbus", () => ({ getE3dcLiveDataHub: vi.fn(() => ({ subscribe: vi.fn(() => vi.fn()) })) }));
vi.mock("../monitoring/prowl-notifier", () => ({ triggerProwlEvent: vi.fn() }));

import { storage } from "../core/storage";

function makeLiveData(overrides: Partial<E3dcLiveData> = {}): E3dcLiveData {
  return {
    pvPower: 5000, batteryPower: 1000, batterySoc: 50,
    housePower: 1000, gridPower: 0, wallboxPower: 0,
    autarky: 100, selfConsumption: 100, timestamp: new Date().toISOString(),
    ...overrides,
  };
}

describe("ChargingStrategyController - Edge Cases", () => {
  let controller: ChargingStrategyController;

  beforeEach(() => {
    vi.clearAllMocks();
    (storage as any)._reset();
    controller = new ChargingStrategyController(vi.fn().mockResolvedValue({}), new RealPhaseProvider());
  });

  const callCalculateSurplus = (ctrl: any, strategy: string, data: E3dcLiveData): number => {
    return ctrl.calculateSurplus(strategy, data);
  };

  describe("calculateSurplus boundary conditions", () => {
    it("surplus_battery_prio at exact SOC=95 threshold uses actual battery power", () => {
      const data = makeLiveData({ pvPower: 6000, housePower: 1000, wallboxPower: 0, batterySoc: 95, batteryPower: 1500 });
      // SOC >= 95 → batteryReservation = max(0, 1500) = 1500
      // surplus = (5000 - 1500) * 0.9 = 3150
      const result = callCalculateSurplus(controller, "surplus_battery_prio", data);
      expect(result).toBe(3150);
    });

    it("surplus_battery_prio with battery discharging (negative batteryPower) and high SOC", () => {
      const data = makeLiveData({ pvPower: 3000, housePower: 1000, wallboxPower: 0, batterySoc: 97, batteryPower: -500 });
      // SOC >= 95 → batteryReservation = max(0, -500) = 0
      // surplus = (2000 - 0) * 0.9 = 1800
      const result = callCalculateSurplus(controller, "surplus_battery_prio", data);
      expect(result).toBe(1800);
    });

    it("surplus_battery_prio with zero PV returns 0", () => {
      const data = makeLiveData({ pvPower: 0, housePower: 500, wallboxPower: 0, batterySoc: 50 });
      const result = callCalculateSurplus(controller, "surplus_battery_prio", data);
      expect(result).toBe(0);
    });

    it("surplus_vehicle_prio with large battery discharge still floors at 0", () => {
      const data = makeLiveData({ pvPower: 100, housePower: 5000, wallboxPower: 0, batteryPower: -3000 });
      // rawSurplus = 100 - 5000 + min(0, -3000) = -7900 → 0
      const result = callCalculateSurplus(controller, "surplus_vehicle_prio", data);
      expect(result).toBe(0);
    });

    it("max_with_battery with zero values returns 0", () => {
      const data = makeLiveData({ pvPower: 0, housePower: 0, wallboxPower: 0, batteryPower: 0 });
      const result = callCalculateSurplus(controller, "max_with_battery", data);
      expect(result).toBe(0);
    });

    it("wallboxPower correctly subtracted from housePower in all strategies", () => {
      // If wallboxPower equals housePower, effective house = 0
      const data = makeLiveData({ pvPower: 3000, housePower: 3000, wallboxPower: 3000, batterySoc: 50 });
      // housePowerWithoutWallbox = 0, totalSurplus = 3000
      // batteryReservation = min(3000, 3000) = 3000 (SOC < 95)
      // surplus = (3000 - 3000) * 0.9 = 0
      const result = callCalculateSurplus(controller, "surplus_battery_prio", data);
      expect(result).toBe(0);

      // max_without_battery: 3000 - 0 = 3000
      const result2 = callCalculateSurplus(controller, "max_without_battery", data);
      expect(result2).toBe(3000);
    });

    it("handles wallboxPower greater than housePower (negative effective house)", () => {
      // Edge: wallboxPower > housePower means negative effective house → more surplus
      const data = makeLiveData({ pvPower: 5000, housePower: 1000, wallboxPower: 2000 });
      // housePowerWithoutWallbox = -1000 → surplus = 5000 - (-1000) = 6000
      const result = callCalculateSurplus(controller, "max_without_battery", data);
      expect(result).toBe(6000);
    });
  });

  describe("calculateTargetCurrent edge cases", () => {
    const callCalcTarget = (ctrl: any, config: any, surplus: number, data: E3dcLiveData) => {
      return ctrl.calculateTargetCurrent(config, surplus, data);
    };

    const makeConfig = (overrides: any = {}) => ({
      activeStrategy: "surplus_battery_prio",
      minStartPowerWatt: 1500, stopThresholdWatt: 500,
      startDelaySeconds: 60, stopDelaySeconds: 120,
      physicalPhaseSwitch: 1, minCurrentChangeAmpere: 1,
      minChangeIntervalSeconds: 30, inputX1Strategy: "max_without_battery",
      ...overrides,
    });

    it("returns null for zero surplus", () => {
      (storage as any)._setContext({ isActive: false, currentPhases: 1 });
      const result = callCalcTarget(controller, makeConfig(), 0, makeLiveData());
      expect(result).toBeNull();
    });

    it("returns null for negative surplus", () => {
      (storage as any)._setContext({ isActive: false, currentPhases: 1 });
      // calculateSurplus already floors to 0, but test the target calc directly
      const result = callCalcTarget(controller, makeConfig(), -500, makeLiveData());
      expect(result).toBeNull();
    });

    it("rounds current correctly (1725W / 230V = 7.5 → 8A)", () => {
      (storage as any)._setContext({ isActive: false, currentPhases: 1 });
      const result = callCalcTarget(controller, makeConfig(), 1725, makeLiveData());
      // 1725 / 230 = 7.5 → Math.round = 8
      expect(result).toEqual({ currentMa: 8000 });
    });

    it("floors to 6A minimum when surplus gives less than 6A", () => {
      (storage as any)._setContext({ isActive: false, currentPhases: 1 });
      // 1400W / 230V = 6.08 → 6A (>= minPower 1380 so not null)
      const result = callCalcTarget(controller, makeConfig(), 1400, makeLiveData());
      expect(result).toEqual({ currentMa: 6000 });
    });
  });

  describe("Issue #105: strategy 'off' must never produce START_CHARGING action", () => {
    const makeStateConfig = (): StateConfig => ({
      minStartPowerWatt: 1500,
      stopThresholdWatt: 500,
      startDelaySeconds: 60,
      stopDelaySeconds: 120,
    });

    it("stays IDLE when strategy is 'off' even with high surplus and car connected", () => {
      // Scenario: X1-OFF sets strategy to "off", but surplus is high enough
      // to satisfy surplus start conditions. State machine must NOT produce START_CHARGING.
      const state = deriveState({ isActive: false });
      const input: StateInput = {
        surplus: 5000,
        plug: 7,
        wallboxReallyCharging: false,
        targetCurrentMa: null, // "off" strategy → calculateTargetCurrent returns null
        userLimitAmpere: undefined,
        strategy: "off",
        isMaxPower: false,
      };
      const transition = evaluate(state, input, makeStateConfig(), {
        stabilizationPeriodMs: 20000,
      });
      expect(transition.newState).toBe("IDLE");
      expect(transition.actions.some(a => a.type === "START_CHARGING")).toBe(false);
    });

    it("stays IDLE when strategy is 'off' even with plug=7 and expired delay", () => {
      // Edge case: strategy "off" must not produce START_CHARGING even with expired delay
      const state = deriveState({
        isActive: false,
        startDelayTrackerSince: new Date(Date.now() - 120000).toISOString(),
      });
      const input: StateInput = {
        surplus: 5000,
        plug: 7,
        wallboxReallyCharging: false,
        targetCurrentMa: null, // "off" strategy → calculateTargetCurrent returns null
        userLimitAmpere: undefined,
        strategy: "off",
        isMaxPower: false,
      };
      const transition = evaluate(state, input, makeStateConfig(), {
        startDelayTrackerSince: new Date(Date.now() - 120000).toISOString(),
        stabilizationPeriodMs: 20000,
      });
      // State machine resets to IDLE because surplus < minStartPowerWatt is handled,
      // but more importantly: targetCurrentMa=null means no start possible
      expect(transition.actions.some(a => a.type === "START_CHARGING")).toBe(false);
    });
  });

  describe("Surplus start-delay must not start without car connected (Plug !== 7)", () => {
    const makeStateConfig = (): StateConfig => ({
      minStartPowerWatt: 1500,
      stopThresholdWatt: 500,
      startDelaySeconds: 60,
      stopDelaySeconds: 120,
    });

    const makeSurplusInput = (overrides: Partial<StateInput> = {}): StateInput => ({
      surplus: 5000,
      plug: 1,
      wallboxReallyCharging: false,
      targetCurrentMa: 6000, // Enough surplus for 6A
      userLimitAmpere: undefined,
      strategy: "surplus_battery_prio",
      isMaxPower: false,
      ...overrides,
    });

    it("does NOT produce START_DELAY_BEGIN when no car is connected (Plug=1)", () => {
      // Bug: Frontend shows "Start in Xs" even though no car is plugged in
      const state = deriveState({ isActive: false });
      const transition = evaluate(state, makeSurplusInput({ plug: 1 }), makeStateConfig(), {
        stabilizationPeriodMs: 20000,
      });
      expect(transition.newState).toBe("IDLE");
      expect(transition.actions.some(a => a.type === "START_DELAY_BEGIN")).toBe(false);
    });

    it("resets running delay timer when car is disconnected (Plug=1)", () => {
      // Scenario: Delay was running (car was connected), then car gets unplugged
      const startDelayTrackerSince = new Date(Date.now() - 30000).toISOString();
      const state = deriveState({ isActive: false, startDelayTrackerSince });
      expect(state).toBe("WAIT_START"); // Confirm we start in WAIT_START

      const transition = evaluate(state, makeSurplusInput({ plug: 1 }), makeStateConfig(), {
        startDelayTrackerSince,
        stabilizationPeriodMs: 20000,
      });
      expect(transition.newState).toBe("IDLE");
      expect(transition.actions.some(a => a.type === "START_DELAY_RESET")).toBe(true);
    });

    it("produces START_DELAY_BEGIN when car IS connected (Plug=7)", () => {
      const state = deriveState({ isActive: false });
      const transition = evaluate(state, makeSurplusInput({ plug: 7 }), makeStateConfig(), {
        stabilizationPeriodMs: 20000,
      });
      expect(transition.newState).toBe("WAIT_START");
      expect(transition.actions.some(a => a.type === "START_DELAY_BEGIN")).toBe(true);
    });

    it("works the same for surplus_vehicle_prio strategy", () => {
      const state = deriveState({ isActive: false });
      const transition = evaluate(
        state,
        makeSurplusInput({ plug: 1, strategy: "surplus_vehicle_prio" }),
        makeStateConfig(),
        { stabilizationPeriodMs: 20000 },
      );
      expect(transition.newState).toBe("IDLE");
      expect(transition.actions.some(a => a.type === "START_DELAY_BEGIN")).toBe(false);
    });

    it("produces START_CHARGING when delay expired and car is connected (Plug=7)", () => {
      // Full happy path: car connected, delay expired -> should produce START_CHARGING
      const startDelayTrackerSince = new Date(Date.now() - 120000).toISOString(); // 2min ago (> 60s delay)
      const state = deriveState({ isActive: false, startDelayTrackerSince });
      expect(state).toBe("WAIT_START");

      const transition = evaluate(
        state,
        makeSurplusInput({ plug: 7 }),
        makeStateConfig(),
        { startDelayTrackerSince, stabilizationPeriodMs: 20000 },
      );
      expect(transition.newState).toBe("CHARGING");
      expect(transition.actions.some(a => a.type === "START_CHARGING")).toBe(true);
    });
  });

});

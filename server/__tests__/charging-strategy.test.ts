import { describe, it, expect, beforeEach, vi } from "vitest";
import { ChargingStrategyController } from "../charging-strategy-controller";
import type { E3dcLiveData, ChargingStrategy, ChargingStrategyConfig } from "@shared/schema";

// Mock all external dependencies
vi.mock("../storage", () => {
  const defaultContext = {
    strategy: "off" as const,
    isActive: false,
    currentAmpere: 0,
    targetAmpere: 0,
    currentPhases: 1,
    adjustmentCount: 0,
  };
  const defaultSettings = {
    wallboxIp: "192.168.40.16",
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

vi.mock("../logger", () => ({
  log: vi.fn(),
}));

vi.mock("../e3dc-client", () => ({
  e3dcClient: {
    isConfigured: vi.fn(() => false),
    configure: vi.fn(),
    lockDischarge: vi.fn(),
    unlockDischarge: vi.fn(),
  },
}));

vi.mock("../e3dc-modbus", () => ({
  getE3dcLiveDataHub: vi.fn(() => ({
    subscribe: vi.fn(() => vi.fn()),
  })),
}));

vi.mock("../prowl-notifier", () => ({
  triggerProwlEvent: vi.fn(),
}));

import { storage } from "../storage";

function makeLiveData(overrides: Partial<E3dcLiveData> = {}): E3dcLiveData {
  return {
    pvPower: 5000,
    batteryPower: 1000, // positive = charging
    batterySoc: 50,
    housePower: 1000,
    gridPower: 0,
    wallboxPower: 0,
    autarky: 100,
    selfConsumption: 100,
    timestamp: new Date().toISOString(),
    ...overrides,
  };
}

describe("ChargingStrategyController", () => {
  let controller: ChargingStrategyController;
  let mockSendUdp: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.clearAllMocks();
    (storage as any)._reset();
    mockSendUdp = vi.fn().mockResolvedValue({});
    controller = new ChargingStrategyController(mockSendUdp);
  });

  describe("calculateSurplus", () => {
    // Access private method for unit testing
    const callCalculateSurplus = (ctrl: any, strategy: ChargingStrategy, data: E3dcLiveData): number => {
      return ctrl.calculateSurplus(strategy, data);
    };

    describe("surplus_battery_prio", () => {
      it("reserves battery power when SOC < 95%", () => {
        const data = makeLiveData({ pvPower: 6000, housePower: 1000, wallboxPower: 0, batterySoc: 50, batteryPower: 2000 });
        // totalSurplus = 6000 - 1000 = 5000
        // batteryReservation = min(5000, 3000) = 3000
        // surplusForWallbox = 5000 - 3000 = 2000
        // withMargin = 2000 * 0.9 = 1800
        const result = callCalculateSurplus(controller, "surplus_battery_prio", data);
        expect(result).toBe(1800);
      });

      it("uses actual battery power when SOC >= 95%", () => {
        const data = makeLiveData({ pvPower: 6000, housePower: 1000, wallboxPower: 0, batterySoc: 98, batteryPower: 800 });
        // totalSurplus = 5000, batteryReservation = max(0, 800) = 800
        // surplusForWallbox = 5000 - 800 = 4200, withMargin = 3780
        const result = callCalculateSurplus(controller, "surplus_battery_prio", data);
        expect(result).toBe(3780);
      });

      it("returns 0 when PV < house consumption", () => {
        const data = makeLiveData({ pvPower: 500, housePower: 1000, wallboxPower: 0, batterySoc: 50 });
        const result = callCalculateSurplus(controller, "surplus_battery_prio", data);
        expect(result).toBe(0);
      });

      it("subtracts wallboxPower from housePower", () => {
        // housePower includes wallbox; surplus calc should subtract wallboxPower
        const data = makeLiveData({ pvPower: 6000, housePower: 2500, wallboxPower: 1500, batterySoc: 50 });
        // housePowerWithoutWallbox = 2500 - 1500 = 1000
        // totalSurplus = 6000 - 1000 = 5000
        const result = callCalculateSurplus(controller, "surplus_battery_prio", data);
        expect(result).toBe(1800); // (5000 - 3000) * 0.9
      });

      it("handles battery fully charged (SOC 100%)", () => {
        const data = makeLiveData({ pvPower: 6000, housePower: 1000, wallboxPower: 0, batterySoc: 100, batteryPower: 0 });
        // batteryReservation = max(0, 0) = 0 (SOC >= 95)
        // surplus = (5000 - 0) * 0.9 = 4500
        const result = callCalculateSurplus(controller, "surplus_battery_prio", data);
        expect(result).toBe(4500);
      });
    });

    describe("surplus_vehicle_prio", () => {
      it("calculates surplus including battery discharge", () => {
        const data = makeLiveData({ pvPower: 5000, housePower: 1000, wallboxPower: 0, batteryPower: -500 });
        // rawSurplus = 5000 - 1000 + min(0, -500) = 3500
        const result = callCalculateSurplus(controller, "surplus_vehicle_prio", data);
        expect(result).toBe(3500);
      });

      it("ignores battery charging power (positive batteryPower)", () => {
        const data = makeLiveData({ pvPower: 5000, housePower: 1000, wallboxPower: 0, batteryPower: 2000 });
        // rawSurplus = 5000 - 1000 + min(0, 2000) = 4000
        const result = callCalculateSurplus(controller, "surplus_vehicle_prio", data);
        expect(result).toBe(4000);
      });

      it("returns 0 for negative surplus", () => {
        const data = makeLiveData({ pvPower: 500, housePower: 2000, wallboxPower: 0, batteryPower: -1000 });
        const result = callCalculateSurplus(controller, "surplus_vehicle_prio", data);
        expect(result).toBe(0);
      });
    });

    describe("max_with_battery", () => {
      it("includes battery discharge in surplus", () => {
        const data = makeLiveData({ pvPower: 5000, housePower: 1000, wallboxPower: 0, batteryPower: -2000 });
        // pvPower + abs(min(0, -2000)) - housePowerWithoutWallbox = 5000 + 2000 - 1000 = 6000
        const result = callCalculateSurplus(controller, "max_with_battery", data);
        expect(result).toBe(6000);
      });

      it("ignores battery charging", () => {
        const data = makeLiveData({ pvPower: 5000, housePower: 1000, wallboxPower: 0, batteryPower: 2000 });
        // pvPower + abs(min(0, 2000)) - 1000 = 5000 + 0 - 1000 = 4000
        const result = callCalculateSurplus(controller, "max_with_battery", data);
        expect(result).toBe(4000);
      });
    });

    describe("max_without_battery", () => {
      it("only uses PV minus house consumption", () => {
        const data = makeLiveData({ pvPower: 5000, housePower: 1000, wallboxPower: 0 });
        const result = callCalculateSurplus(controller, "max_without_battery", data);
        expect(result).toBe(4000);
      });

      it("returns 0 when house consumption exceeds PV", () => {
        const data = makeLiveData({ pvPower: 500, housePower: 2000, wallboxPower: 0 });
        const result = callCalculateSurplus(controller, "max_without_battery", data);
        expect(result).toBe(0);
      });
    });

    it("returns 0 for unknown strategy", () => {
      const data = makeLiveData();
      const result = callCalculateSurplus(controller, "off" as any, data);
      expect(result).toBe(0);
    });
  });

  describe("calculateTargetCurrent", () => {
    const callCalcTarget = (ctrl: any, config: ChargingStrategyConfig, surplus: number, data: E3dcLiveData) => {
      return ctrl.calculateTargetCurrent(config, surplus, data);
    };

    const makeConfig = (overrides: Partial<ChargingStrategyConfig> = {}): ChargingStrategyConfig => ({
      activeStrategy: "surplus_battery_prio",
      minStartPowerWatt: 1500,
      stopThresholdWatt: 500,
      startDelaySeconds: 60,
      stopDelaySeconds: 120,
      physicalPhaseSwitch: 1,
      minCurrentChangeAmpere: 1,
      minChangeIntervalSeconds: 30,
      inputX1Strategy: "max_without_battery",
      ...overrides,
    });

    it("returns max current for max_with_battery (1P)", () => {
      (storage as any)._setContext({ isActive: false, currentPhases: 1 });
      const config = makeConfig({ activeStrategy: "max_with_battery", physicalPhaseSwitch: 1 });
      const result = callCalcTarget(controller, config, 10000, makeLiveData());
      expect(result).toEqual({ currentMa: 32000 }); // 32A * 1000
    });

    it("returns max current for max_without_battery (3P)", () => {
      (storage as any)._setContext({ isActive: false, currentPhases: 3 });
      const config = makeConfig({ activeStrategy: "max_without_battery", physicalPhaseSwitch: 3 });
      const result = callCalcTarget(controller, config, 10000, makeLiveData());
      expect(result).toEqual({ currentMa: 16000 }); // 16A * 1000
    });

    it("returns null when surplus below minimum for 1P", () => {
      // Min power for 1P = 6A * 230V * 1 = 1380W
      (storage as any)._setContext({ isActive: false, currentPhases: 1 });
      const config = makeConfig({ activeStrategy: "surplus_battery_prio" });
      const result = callCalcTarget(controller, config, 1300, makeLiveData());
      expect(result).toBeNull();
    });

    it("returns 6A at exact minimum surplus for 1P", () => {
      (storage as any)._setContext({ isActive: false, currentPhases: 1 });
      const config = makeConfig({ activeStrategy: "surplus_battery_prio" });
      // minPower = 6 * 230 * 1 = 1380W
      const result = callCalcTarget(controller, config, 1380, makeLiveData());
      expect(result).toEqual({ currentMa: 6000 });
    });

    it("caps current at 32A for 1P surplus strategy", () => {
      (storage as any)._setContext({ isActive: false, currentPhases: 1 });
      const config = makeConfig({ activeStrategy: "surplus_battery_prio" });
      // 50000W / 230V = ~217A → capped to 32A
      const result = callCalcTarget(controller, config, 50000, makeLiveData());
      expect(result).toEqual({ currentMa: 32000 });
    });

    it("caps current at 16A for 3P surplus strategy", () => {
      (storage as any)._setContext({ isActive: true, currentPhases: 3 });
      const config = makeConfig({ activeStrategy: "surplus_vehicle_prio" });
      const result = callCalcTarget(controller, config, 50000, makeLiveData());
      expect(result).toEqual({ currentMa: 16000 });
    });

    it("returns null when surplus below minimum for 3P", () => {
      // Min power for 3P = 6A * 230V * 3 = 4140W
      (storage as any)._setContext({ isActive: true, currentPhases: 3 });
      const config = makeConfig({ activeStrategy: "surplus_vehicle_prio" });
      const result = callCalcTarget(controller, config, 4000, makeLiveData());
      expect(result).toBeNull();
    });

    it("calculates correct ampere for given surplus 1P", () => {
      (storage as any)._setContext({ isActive: false, currentPhases: 1 });
      const config = makeConfig({ activeStrategy: "surplus_battery_prio" });
      // 2300W / 230V = 10A
      const result = callCalcTarget(controller, config, 2300, makeLiveData());
      expect(result).toEqual({ currentMa: 10000 });
    });

    it("uses context phases when active", () => {
      (storage as any)._setContext({ isActive: true, currentPhases: 3 });
      const config = makeConfig({ activeStrategy: "surplus_vehicle_prio" });
      // 4200W / (230V * 3) = ~6.08 → rounded to 6A
      const result = callCalcTarget(controller, config, 4200, makeLiveData());
      expect(result).toEqual({ currentMa: 6000 });
    });
  });
});

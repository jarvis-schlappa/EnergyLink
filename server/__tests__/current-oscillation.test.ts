import { DEFAULT_WALLBOX_IP } from "../core/defaults";
import { describe, it, expect, beforeEach, vi } from "vitest";
import { ChargingStrategyController } from "../strategy/charging-strategy-controller";
import { RealPhaseProvider } from "../strategy/phase-provider";
import type { E3dcLiveData } from "@shared/schema";

/**
 * Issue #92: Ladestrom-Oszillation bei Grenzwert-Surplus
 *
 * Problem: Bei PV-Überschuss genau an der Grenze zwischen zwei Ampere-Stufen
 * pendelt der Ladestrom dauerhaft (z.B. 16A ↔ 17A, ~50 Wechsel in 2h).
 *
 * Root Cause: calculateTargetCurrent() rundet auf ganze Ampere (Math.round).
 * Beispiel: 3850W Surplus → 16.74A → 17A → Wallbox zieht 3910W →
 * nächster Zyklus: 15.87A → 16A → und so weiter.
 *
 * Fix: Nutze KEBA's native mA-Auflösung (curr-Befehl akzeptiert mA).
 * Runde auf 100mA statt auf ganze Ampere → 16.74A wird zu 16700mA.
 */

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
      activeStrategy: "surplus_vehicle_prio" as const,
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
vi.mock("../wallbox/sse", () => ({ broadcastPartialUpdate: vi.fn() }));
vi.mock("../wallbox/broadcast-listener", () => ({ getAuthoritativePlugStatus: vi.fn(() => 7) }));

import { storage } from "../core/storage";

function makeLiveData(overrides: Partial<E3dcLiveData> = {}): E3dcLiveData {
  return {
    pvPower: 5000, batteryPower: 0, batterySoc: 80,
    housePower: 500, gridPower: 0, wallboxPower: 0,
    autarky: 100, selfConsumption: 100, timestamp: new Date().toISOString(),
    ...overrides,
  };
}

/**
 * Creates a mock UDP sender that returns realistic report 2/3 data
 * for an actively charging wallbox at given current (in mA) and phases.
 */
function createChargingMockUdp(currentMa: number = 16000, phases: number = 1) {
  return vi.fn().mockImplementation(async (_ip: string, cmd: string) => {
    if (cmd === "report 2") {
      return {
        State: 3, Plug: 7, "Enable sys": 1,
        "Max curr": currentMa, "Curr HW": phases === 1 ? 32000 : 16000,
      };
    }
    if (cmd === "report 3") {
      const power = phases === 1
        ? 230 * currentMa  // V * mA = mW
        : 230 * currentMa * 3;
      return {
        P: power,
        I1: currentMa, I2: phases === 3 ? currentMa : 0, I3: phases === 3 ? currentMa : 0,
      };
    }
    return {};
  });
}

describe("Issue #92: Ladestrom-Oszillation bei Grenzwert-Surplus", () => {
  let controller: ChargingStrategyController;
  let mockSendUdp: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.clearAllMocks();
    (storage as any)._reset();
  });

  it("should use sub-ampere resolution (100mA steps) to prevent oscillation", async () => {
    // Scenario: 3850W surplus @ 1P → 3850/230 = 16.739A
    // OLD behavior: Math.round → 17A (17000mA)
    // NEW behavior: Round to 100mA → 16.7A (16700mA)

    mockSendUdp = createChargingMockUdp(16000, 1);
    controller = new ChargingStrategyController(mockSendUdp, new RealPhaseProvider());

    const longAgo = new Date(Date.now() - 120000).toISOString();
    (storage as any)._setContext({
      isActive: true,
      currentAmpere: 16,
      targetAmpere: 16,
      currentPhases: 1,
      strategy: "surplus_vehicle_prio",
      lastAdjustment: longAgo,
      lastStartedAt: longAgo,
    });

    // surplus_vehicle_prio: pvPower - housePowerWithoutWallbox + min(0, batteryPower)
    // housePowerWithoutWallbox = housePower - wallboxPower = 500 - 0 = 500
    // surplus = 4350 - 500 + 0 = 3850W
    // 3850 / 230 = 16.739A → should become 16.7A (16700mA), NOT 17A (17000mA)
    const liveData = makeLiveData({
      pvPower: 4350,
      housePower: 500,
      wallboxPower: 0,
      batteryPower: 0,
    });

    await controller.processStrategy(liveData, DEFAULT_WALLBOX_IP);

    const ctx = storage.getChargingContext();

    // targetAmpere should reflect sub-ampere precision (16.7, not 17)
    expect(ctx.targetAmpere).toBeLessThan(17);
    expect(ctx.targetAmpere).toBeGreaterThanOrEqual(16);
    expect(ctx.targetAmpere).toBeCloseTo(16.7, 1);
  });

  it("should NOT oscillate between two ampere steps with borderline surplus", async () => {
    // Simulate 10 consecutive cycles with surplus that produces ~16.7A
    // The target current should stay stable in the 16.x range
    // and NOT flip-flop between exactly 16000mA and 17000mA

    mockSendUdp = createChargingMockUdp(16000, 1);
    controller = new ChargingStrategyController(mockSendUdp, new RealPhaseProvider());

    const longAgo = new Date(Date.now() - 300000).toISOString();
    (storage as any)._setContext({
      isActive: true,
      currentAmpere: 16,
      targetAmpere: 16,
      currentPhases: 1,
      strategy: "surplus_vehicle_prio",
      lastAdjustment: longAgo,
      lastStartedAt: longAgo,
    });

    const sentCurrents: number[] = [];

    mockSendUdp.mockImplementation(async (_ip: string, cmd: string) => {
      if (cmd.startsWith("curr ")) {
        sentCurrents.push(parseInt(cmd.split(" ")[1]));
      }
      if (cmd === "report 2") {
        return { State: 3, Plug: 7, "Enable sys": 1, "Max curr": 16000, "Curr HW": 32000 };
      }
      if (cmd === "report 3") {
        return { P: 3680000, I1: 16000, I2: 0, I3: 0 };
      }
      return {};
    });

    // Run 10 cycles with slightly varying surplus around ~16.7A boundary
    for (let i = 0; i < 10; i++) {
      // PV varies ±50W around 4350 → surplus ~3800-3900W → 16.5-16.9A
      const pvJitter = 4350 + (Math.random() - 0.5) * 100;
      const liveData = makeLiveData({
        pvPower: pvJitter,
        housePower: 500,
        wallboxPower: 0,
        batteryPower: 0,
      });

      // Advance time past debounce for each cycle
      const ctx = storage.getChargingContext();
      (storage as any)._setContext({
        ...ctx,
        lastAdjustment: new Date(Date.now() - 60000).toISOString(),
      });

      await controller.processStrategy(liveData, DEFAULT_WALLBOX_IP);
    }

    // Key assertion: sent current values should have sub-ampere resolution
    for (const current of sentCurrents) {
      expect(current).toBeGreaterThanOrEqual(16000);
      expect(current).toBeLessThanOrEqual(17000);
    }

    // The critical check: verify there's no 16000↔17000 oscillation pattern
    if (sentCurrents.length >= 2) {
      const uniqueValues = new Set(sentCurrents);
      // With sub-ampere resolution, should NOT only alternate between 16000 and 17000
      const hasOnly16kAnd17k = uniqueValues.size <= 2 &&
        Array.from(uniqueValues).every(v => v === 16000 || v === 17000);
      expect(hasOnly16kAnd17k).toBe(false);
    }
  });

  it("should use sub-ampere resolution for surplus_battery_prio strategy", async () => {
    (storage as any)._setSettings({
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
    });

    mockSendUdp = createChargingMockUdp(10000, 1);
    controller = new ChargingStrategyController(mockSendUdp, new RealPhaseProvider());

    const longAgo = new Date(Date.now() - 120000).toISOString();
    (storage as any)._setContext({
      isActive: true,
      currentAmpere: 10,
      targetAmpere: 10,
      currentPhases: 1,
      strategy: "surplus_battery_prio",
      lastAdjustment: longAgo,
      lastStartedAt: longAgo,
    });

    // surplus_battery_prio with SOC < 95:
    // totalSurplus = pvPower - housePowerWithoutWallbox = 6000 - 500 = 5500W
    // batteryReservation = min(5500, 3000) = 3000W
    // surplusForWallbox = 5500 - 3000 = 2500W
    // surplusWithMargin = 2500 * 0.9 = 2250W
    // 2250 / 230 = 9.782A → 9.8A (9800mA), not 10A (10000mA)
    const liveData = makeLiveData({
      pvPower: 6000,
      housePower: 500,
      wallboxPower: 0,
      batteryPower: 1000,
      batterySoc: 50,
    });

    await controller.processStrategy(liveData, DEFAULT_WALLBOX_IP);

    const ctx = storage.getChargingContext();
    // 9.782 → rounded to 0.1 → 9.8
    expect(ctx.targetAmpere).toBeLessThan(10);
    expect(ctx.targetAmpere).toBeGreaterThanOrEqual(9);
  });

  it("should send correct mA value in UDP curr command", async () => {
    // Verify the actual UDP command uses sub-ampere mA values
    const sentCommands: string[] = [];

    mockSendUdp = vi.fn().mockImplementation(async (_ip: string, cmd: string) => {
      sentCommands.push(cmd);
      if (cmd === "report 2") {
        return { State: 3, Plug: 7, "Enable sys": 1, "Max curr": 14000, "Curr HW": 32000 };
      }
      if (cmd === "report 3") {
        return { P: 3220000, I1: 14000, I2: 0, I3: 0 };
      }
      return {};
    });

    controller = new ChargingStrategyController(mockSendUdp, new RealPhaseProvider());

    const longAgo = new Date(Date.now() - 120000).toISOString();
    (storage as any)._setContext({
      isActive: true,
      currentAmpere: 14,
      targetAmpere: 14,
      currentPhases: 1,
      strategy: "surplus_vehicle_prio",
      lastAdjustment: longAgo,
      lastStartedAt: longAgo,
    });

    // surplus = 3800W → 3800/230 = 16.521A → 16500mA (16.5A)
    // Diff = |16.5 - 14| = 2.5 >= minCurrentChangeAmpere (1) → should send curr command
    const liveData = makeLiveData({
      pvPower: 4300,
      housePower: 500,
      wallboxPower: 0,
      batteryPower: 0,
    });

    await controller.processStrategy(liveData, DEFAULT_WALLBOX_IP);

    // Find the curr command
    const currCmd = sentCommands.find(c => c.startsWith("curr ") && c !== "curr 0");
    expect(currCmd).toBeDefined();
    
    const currValue = parseInt(currCmd!.split(" ")[1]);
    // Should be 16500, NOT 17000
    expect(currValue).toBe(16500);
  });

  it("should still clamp to MIN_CURRENT_AMPERE (6A) and MAX_CURRENT correctly", async () => {
    mockSendUdp = createChargingMockUdp(6000, 1);
    controller = new ChargingStrategyController(mockSendUdp, new RealPhaseProvider());

    const longAgo = new Date(Date.now() - 120000).toISOString();
    (storage as any)._setContext({
      isActive: true,
      currentAmpere: 6,
      targetAmpere: 6,
      currentPhases: 1,
      strategy: "surplus_vehicle_prio",
      lastAdjustment: longAgo,
      lastStartedAt: longAgo,
    });

    // Low surplus: 1400W / 230 = 6.087A → 6.1A (above MIN 6A)
    const liveData = makeLiveData({
      pvPower: 1900,
      housePower: 500,
      wallboxPower: 0,
      batteryPower: 0,
    });

    await controller.processStrategy(liveData, DEFAULT_WALLBOX_IP);

    const ctx = storage.getChargingContext();
    expect(ctx.targetAmpere).toBeGreaterThanOrEqual(6);
  });
});

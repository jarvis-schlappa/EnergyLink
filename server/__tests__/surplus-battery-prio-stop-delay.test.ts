import { DEFAULT_WALLBOX_IP } from "../core/defaults";
import { describe, it, expect, beforeEach, vi } from "vitest";
import { ChargingStrategyController } from "../strategy/charging-strategy-controller";
import { RealPhaseProvider } from "../strategy/phase-provider";
import type { E3dcLiveData } from "@shared/schema";

/**
 * Issue #33: surplus_battery_prio sofort-stopp bei result=null umgeht
 * stopThresholdWatt und stopDelaySeconds, was zu Start-Stop-Loops führt.
 *
 * Root Cause: Bei result=null && isActive wird stopCharging() direkt aufgerufen,
 * anstatt shouldStopCharging() den Stopp-Timer verwalten zu lassen.
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
vi.mock("../wallbox/sse", () => ({ broadcastPartialUpdate: vi.fn() }));
vi.mock("../wallbox/broadcast-listener", () => ({ getAuthoritativePlugStatus: vi.fn(() => 7) }));

import { storage } from "../core/storage";

function makeLiveData(overrides: Partial<E3dcLiveData> = {}): E3dcLiveData {
  return {
    pvPower: 5000, batteryPower: 1000, batterySoc: 50,
    housePower: 1000, gridPower: 0, wallboxPower: 0,
    autarky: 100, selfConsumption: 100, timestamp: new Date().toISOString(),
    ...overrides,
  };
}

describe("Issue #33: surplus_battery_prio stop delay respected on result=null", () => {
  let controller: ChargingStrategyController;
  let mockSendUdp: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.clearAllMocks();
    (storage as any)._reset();
    mockSendUdp = vi.fn().mockResolvedValue({});
    controller = new ChargingStrategyController(mockSendUdp, new RealPhaseProvider());
  });

  it("should NOT immediately stop when surplus is between stopThresholdWatt and minPower (result=null)", async () => {
    // Scenario: Wallbox is actively charging, surplus drops to ~900W
    // - 900W > stopThresholdWatt (500W) -> shouldStopCharging says NO
    // - 900W < minPower for 6A@1P (1380W) -> calculateTargetCurrent returns null
    // BUG: surplus_battery_prio immediately calls stopCharging() here
    // FIX: Should let the wallbox continue running (like surplus_vehicle_prio does)

    // Setup: actively charging, started 60s ago (past stabilization)
    const startedAt = new Date(Date.now() - 60000).toISOString();
    (storage as any)._setContext({
      isActive: true,
      currentAmpere: 6,
      targetAmpere: 6,
      currentPhases: 1,
      strategy: "surplus_battery_prio",
      lastStartedAt: startedAt,
    });

    // Mock reconcile: wallbox is charging (State=3, Power>0)
    mockSendUdp
      .mockResolvedValueOnce({ State: 3, Plug: 7 })   // report 2
      .mockResolvedValueOnce({ P: 1380000, I1: 6000, I2: 0, I3: 0 }); // report 3

    // Live data yielding surplus between stopThresholdWatt (500W) and minPower (1380W):
    // PV=4500W, house=500W -> totalSurplus=4000W
    // batteryReservation = min(4000, 3000) = 3000W (SOC<95)
    // surplusForWallbox = 4000-3000 = 1000W, withMargin = 900W
    // 900W > stopThresholdWatt(500W) but < minPower(1380W) -> result=null
    const liveData = makeLiveData({
      pvPower: 4500,
      housePower: 500,
      wallboxPower: 1380,
      batterySoc: 50,
      batteryPower: 2000,
    });

    await controller.processStrategy(liveData, DEFAULT_WALLBOX_IP);

    // Key assertion: ena 0 should NOT have been called (beyond the reconcile calls)
    const allCalls = mockSendUdp.mock.calls;
    const ena0Calls = allCalls.filter((call: any[]) => call[1] === "ena 0");
    expect(ena0Calls).toHaveLength(0);

    // Wallbox should still be active
    const context = storage.getChargingContext();
    expect(context.isActive).toBe(true);
  });

  it("should stop after stopDelaySeconds when surplus stays below stopThresholdWatt", async () => {
    // Scenario: surplus drops below stopThresholdWatt for longer than stopDelaySeconds
    // This tests that shouldStopCharging path works correctly for surplus_battery_prio

    const startedAt = new Date(Date.now() - 60000).toISOString();
    (storage as any)._setContext({
      isActive: true,
      currentAmpere: 6,
      targetAmpere: 6,
      currentPhases: 1,
      strategy: "surplus_battery_prio",
      lastStartedAt: startedAt,
      // belowThresholdSince set to 130s ago (> stopDelaySeconds of 120s)
      belowThresholdSince: new Date(Date.now() - 130000).toISOString(),
    });

    // Mock reconcile
    mockSendUdp
      .mockResolvedValueOnce({ State: 3, Plug: 7 })
      .mockResolvedValueOnce({ P: 1380000, I1: 6000, I2: 0, I3: 0 });

    // Very low surplus: below stopThresholdWatt (500W)
    // IMPORTANT: wallboxPower is subtracted from housePower in surplus calc!
    // housePowerWithoutWallbox = housePower - wallboxPower
    // For surplus to be truly 0: PV must equal housePowerWithoutWallbox + batteryReservation
    // PV=4000W, house=4000W, wallboxPower=0 (set to 0 to avoid wallbox subtraction confusion)
    // totalSurplus = 4000 - 4000 = 0
    // batteryReservation = min(0, 3000) = 0 (SOC<95, but surplus is 0)
    // surplusForWallbox = 0 -> shouldStopCharging triggers
    const liveData = makeLiveData({
      pvPower: 1000,
      housePower: 1000,
      wallboxPower: 0,
      batterySoc: 50,
      batteryPower: 500,
    });
    // totalSurplus = 1000 - 1000 = 0
    // batteryReservation = min(0, 3000) = 0
    // surplusForWallbox = 0, withMargin = 0
    // shouldStopCharging: 0 < 500 (stopThresholdWatt) AND belowThresholdSince > 120s -> true

    await controller.processStrategy(liveData, DEFAULT_WALLBOX_IP);

    // shouldStopCharging should have triggered (surplus=0 < 500W, belowThresholdSince > 120s)
    const ena0Calls = mockSendUdp.mock.calls.filter((call: any[]) => call[1] === "ena 0");
    expect(ena0Calls).toHaveLength(1);

    const context = storage.getChargingContext();
    expect(context.isActive).toBe(false);
  });

  it("should NOT stop before stopDelaySeconds even when surplus is below stopThresholdWatt", async () => {
    // Surplus just dropped below threshold 10s ago (< stopDelaySeconds 120s)

    const startedAt = new Date(Date.now() - 60000).toISOString();
    (storage as any)._setContext({
      isActive: true,
      currentAmpere: 6,
      targetAmpere: 6,
      currentPhases: 1,
      strategy: "surplus_battery_prio",
      lastStartedAt: startedAt,
      belowThresholdSince: new Date(Date.now() - 10000).toISOString(), // 10s ago
    });

    mockSendUdp
      .mockResolvedValueOnce({ State: 3, Plug: 7 })
      .mockResolvedValueOnce({ P: 1380000, I1: 6000, I2: 0, I3: 0 });

    // surplus = 0 -> below stopThresholdWatt, but timer hasn't expired
    const liveData = makeLiveData({
      pvPower: 3500,
      housePower: 500,
      wallboxPower: 1380,
      batterySoc: 50,
      batteryPower: 2500,
    });

    await controller.processStrategy(liveData, DEFAULT_WALLBOX_IP);

    // Should NOT have stopped
    const ena0Calls = mockSendUdp.mock.calls.filter((call: any[]) => call[1] === "ena 0");
    expect(ena0Calls).toHaveLength(0);
    expect(storage.getChargingContext().isActive).toBe(true);
  });

  it("should work correctly with SOC >= 95% (actual battery power used)", async () => {
    // When SOC >= 95%, batteryReservation = actual batteryPower
    // If battery is nearly full (SOC=99, batteryPower=200W), more surplus for wallbox
    // surplus = (5000-500-200)*0.9 = 3870W -> result is NOT null -> adjust current

    const startedAt = new Date(Date.now() - 60000).toISOString();
    (storage as any)._setContext({
      isActive: true,
      currentAmpere: 6,
      targetAmpere: 6,
      currentPhases: 1,
      strategy: "surplus_battery_prio",
      lastStartedAt: startedAt,
      lastAdjustment: new Date(Date.now() - 60000).toISOString(),
    });

    mockSendUdp
      .mockResolvedValueOnce({ State: 3, Plug: 7 })
      .mockResolvedValueOnce({ P: 1380000, I1: 6000, I2: 0, I3: 0 });

    const liveData = makeLiveData({
      pvPower: 5000,
      housePower: 500,
      wallboxPower: 1380,
      batterySoc: 99,
      batteryPower: 200,
    });

    await controller.processStrategy(liveData, DEFAULT_WALLBOX_IP);

    // Should NOT stop, should adjust current
    const ena0Calls = mockSendUdp.mock.calls.filter((call: any[]) => call[1] === "ena 0");
    expect(ena0Calls).toHaveLength(0);
    expect(storage.getChargingContext().isActive).toBe(true);
  });
});

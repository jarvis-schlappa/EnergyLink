import { DEFAULT_WALLBOX_IP } from "../core/defaults";
import { describe, it, expect, beforeEach, vi } from "vitest";
import { ChargingStrategyController } from "../strategy/charging-strategy-controller";
import { RealPhaseProvider } from "../strategy/phase-provider";
import { deriveState } from "../strategy/charging-state-machine";
import type { E3dcLiveData } from "@shared/schema";

/**
 * Issue #101: vehicleFinishedCharging Race-Condition bei Strategiewechsel
 *
 * Root Cause: API-Route /api/wallbox/start setzt activeStrategy in Settings
 *             und ruft handleStrategyChange() auf, aber NICHT switchStrategy().
 *             Der vehicleFinishedCharging-Reset in switchStrategy() wird daher
 *             bei API-gesteuerten Strategiewechseln NIE ausgeführt.
 *
 * Fix: vehicleFinishedCharging in processStrategy() zurücksetzen wenn
 *      context.strategy !== config.activeStrategy (Strategiewechsel erkannt).
 */

// ─── Mocks (same pattern as car-full-restart-loop.test.ts) ─────────────────
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
      activeStrategy: "off" as const,
      minStartPowerWatt: 1500,
      stopThresholdWatt: 500,
      startDelaySeconds: 0,
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
vi.mock("../wallbox/sse", () => ({ broadcastPartialUpdate: vi.fn(), broadcastWallboxStatus: vi.fn() }));
vi.mock("../wallbox/broadcast-listener", () => ({ getAuthoritativePlugStatus: vi.fn(() => 7) }));

import { storage } from "../core/storage";

function makeLiveData(overrides: Partial<E3dcLiveData> = {}): E3dcLiveData {
  return {
    pvPower: 5000, batteryPower: 0, batterySoc: 80,
    housePower: 1000, gridPower: 0, wallboxPower: 0,
    autarky: 100, selfConsumption: 100, timestamp: new Date().toISOString(),
    ...overrides,
  };
}

// ─── Issue #101: vehicleFinishedCharging bei Strategiewechsel ───────────────
describe("Issue #101: vehicleFinishedCharging race condition on strategy change", () => {
  let controller: ChargingStrategyController;
  let mockSendUdp: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.clearAllMocks();
    (storage as any)._reset();
    mockSendUdp = vi.fn().mockResolvedValue({});
    controller = new ChargingStrategyController(mockSendUdp, new RealPhaseProvider());
  });

  it("off→surplus via API flow: vehicleFinishedCharging must be reset", async () => {
    const ip = DEFAULT_WALLBOX_IP;

    // Setup: Car finished charging previously, strategy=off, vehicleFinishedCharging=true
    (storage as any)._setContext({
      strategy: "off",
      isActive: false,
      currentAmpere: 0,
      targetAmpere: 0,
      currentPhases: 1,
      vehicleFinishedCharging: true,
      vehicleFinishedAt: new Date(Date.now() - 600_000).toISOString(),
    });

    // Simulate API flow: User activates surplus_vehicle_prio via /api/wallbox/start
    // API sets activeStrategy in settings + handleStrategyChange(), but NOT switchStrategy()
    const settings = storage.getSettings()!;
    settings.chargingStrategy!.activeStrategy = "surplus_vehicle_prio";
    storage.saveSettings(settings);
    await controller.handleStrategyChange("surplus_vehicle_prio");

    // processStrategy runs (next E3DC poll) - Wallbox idle, car connected
    mockSendUdp
      .mockResolvedValueOnce({ State: 2, Plug: 7, "Enable sys": 0 })
      .mockResolvedValueOnce({ P: 0, I1: 0, I2: 0, I3: 0 })
      .mockResolvedValue({});

    const liveData = makeLiveData({ pvPower: 5000, housePower: 1000, wallboxPower: 0 });
    await controller.processStrategy(liveData, ip);

    // processStrategy detects strategy mismatch (context.strategy="off" vs config="surplus_vehicle_prio")
    // → vehicleFinishedCharging should be reset
    const context = storage.getChargingContext();
    const state = deriveState({
      isActive: context.isActive,
      vehicleFinishedCharging: context.vehicleFinishedCharging,
      startDelayTrackerSince: context.startDelayTrackerSince,
      belowThresholdSince: context.belowThresholdSince,
    });

    expect(state).not.toBe("CAR_FINISHED");
    expect(context.vehicleFinishedCharging).toBe(false);
    expect(context.strategy).toBe("surplus_vehicle_prio");
  });

  it("off→surplus: charging starts within 2 processStrategy cycles", async () => {
    const ip = DEFAULT_WALLBOX_IP;

    // Setup: vehicleFinishedCharging=true, strategy=off
    (storage as any)._setContext({
      strategy: "off",
      isActive: false,
      currentAmpere: 0,
      targetAmpere: 0,
      currentPhases: 1,
      vehicleFinishedCharging: true,
      vehicleFinishedAt: new Date(Date.now() - 600_000).toISOString(),
    });

    // API activates surplus
    const settings = storage.getSettings()!;
    settings.chargingStrategy!.activeStrategy = "surplus_vehicle_prio";
    storage.saveSettings(settings);
    await controller.handleStrategyChange("surplus_vehicle_prio");

    const liveData = makeLiveData({ pvPower: 5000, housePower: 1000, wallboxPower: 0 });

    // Cycle 1: Reset vehicleFinishedCharging + enter WAIT_START
    mockSendUdp.mockClear();
    mockSendUdp
      .mockResolvedValueOnce({ State: 2, Plug: 7, "Enable sys": 0 })
      .mockResolvedValueOnce({ P: 0, I1: 0, I2: 0, I3: 0 })
      .mockResolvedValue({});
    await controller.processStrategy(liveData, ip);

    // Cycle 2: Start charging (startDelaySeconds=0)
    mockSendUdp.mockClear();
    mockSendUdp
      .mockResolvedValueOnce({ State: 2, Plug: 7, "Enable sys": 0 })
      .mockResolvedValueOnce({ P: 0, I1: 0, I2: 0, I3: 0 })
      .mockResolvedValue({});
    await controller.processStrategy(liveData, ip);

    const ena1Calls = mockSendUdp.mock.calls.filter(
      (call: any[]) => call[1] === "ena 1"
    );
    expect(ena1Calls.length).toBeGreaterThanOrEqual(1);
  });

  it("surplus→off→surplus via API: vehicleFinishedCharging reset on second change", async () => {
    const ip = DEFAULT_WALLBOX_IP;

    // Step 1: Surplus active, car finished charging
    (storage as any)._setContext({
      strategy: "surplus_vehicle_prio",
      isActive: false,
      currentAmpere: 0,
      targetAmpere: 0,
      currentPhases: 1,
      vehicleFinishedCharging: true,
      vehicleFinishedAt: new Date(Date.now() - 600_000).toISOString(),
    });
    (storage as any)._setSettings({
      ...storage.getSettings(),
      chargingStrategy: {
        ...storage.getSettings()!.chargingStrategy,
        activeStrategy: "surplus_vehicle_prio",
      },
    });

    // Step 2: API switches to off → processStrategy returns early (no reconcile)
    const settings2 = storage.getSettings()!;
    settings2.chargingStrategy!.activeStrategy = "off";
    storage.saveSettings(settings2);

    const liveData = makeLiveData({ pvPower: 5000, housePower: 1000, wallboxPower: 0 });
    mockSendUdp.mockResolvedValue({});
    await controller.processStrategy(liveData, ip);

    // Context strategy should be "off" now but vehicleFinishedCharging stays true
    // (switching TO off doesn't reset it - correct behavior)

    // Step 3: API switches back to surplus
    const settings3 = storage.getSettings()!;
    settings3.chargingStrategy!.activeStrategy = "surplus_vehicle_prio";
    storage.saveSettings(settings3);

    // processStrategy runs with strategy mismatch (off→surplus_vehicle_prio)
    mockSendUdp.mockClear();
    mockSendUdp
      .mockResolvedValueOnce({ State: 2, Plug: 7, "Enable sys": 0 })
      .mockResolvedValueOnce({ P: 0, I1: 0, I2: 0, I3: 0 })
      .mockResolvedValue({});
    await controller.processStrategy(liveData, ip);

    const context = storage.getChargingContext();
    expect(context.vehicleFinishedCharging).toBe(false);
    expect(context.strategy).toBe("surplus_vehicle_prio");
  });

  it("same strategy (no change): vehicleFinishedCharging stays true (correct CAR_FINISHED)", async () => {
    const ip = DEFAULT_WALLBOX_IP;

    // Setup: Surplus active, car just finished, same strategy stays
    (storage as any)._setContext({
      strategy: "surplus_vehicle_prio",
      isActive: false,
      currentAmpere: 0,
      targetAmpere: 0,
      currentPhases: 1,
      vehicleFinishedCharging: true,
      vehicleFinishedAt: new Date(Date.now() - 600_000).toISOString(),
    });
    (storage as any)._setSettings({
      ...storage.getSettings(),
      chargingStrategy: {
        ...storage.getSettings()!.chargingStrategy,
        activeStrategy: "surplus_vehicle_prio",
      },
    });

    mockSendUdp
      .mockResolvedValueOnce({ State: 2, Plug: 7, "Enable sys": 0 })
      .mockResolvedValueOnce({ P: 0, I1: 0, I2: 0, I3: 0 })
      .mockResolvedValue({});

    const liveData = makeLiveData({ pvPower: 5000, housePower: 1000, wallboxPower: 0 });
    await controller.processStrategy(liveData, ip);

    // No strategy change → vehicleFinishedCharging should stay (restart-loop prevention)
    const context = storage.getChargingContext();
    expect(context.vehicleFinishedCharging).toBe(true);

    const state = deriveState({
      isActive: context.isActive,
      vehicleFinishedCharging: context.vehicleFinishedCharging,
    });
    expect(state).toBe("CAR_FINISHED");
  });

  it("off→off: no reset (switching TO off preserves vehicleFinishedCharging)", async () => {
    const ip = DEFAULT_WALLBOX_IP;

    (storage as any)._setContext({
      strategy: "surplus_vehicle_prio",
      isActive: false,
      vehicleFinishedCharging: true,
      vehicleFinishedAt: new Date(Date.now() - 600_000).toISOString(),
    });
    (storage as any)._setSettings({
      ...storage.getSettings(),
      chargingStrategy: {
        ...storage.getSettings()!.chargingStrategy,
        activeStrategy: "off",
      },
    });

    mockSendUdp.mockResolvedValue({});
    const liveData = makeLiveData();
    await controller.processStrategy(liveData, ip);

    // Switching to off: vehicleFinishedCharging should not be reset
    // (off returns early before reconcile, but strategy sync happens...
    //  actually off returns early BEFORE the strategy sync!)
    // The off early-return is BEFORE context strategy sync, so context.strategy stays as is
    const context = storage.getChargingContext();
    expect(context.vehicleFinishedCharging).toBe(true);
  });
});

import { DEFAULT_WALLBOX_IP } from "../core/defaults";
import { describe, it, expect, beforeEach, vi } from "vitest";
import { ChargingStrategyController } from "../strategy/charging-strategy-controller";
import { RealPhaseProvider } from "../strategy/phase-provider";
import { deriveState, evaluate } from "../strategy/charging-state-machine";
import type { StateInput, StateConfig } from "../strategy/charging-state-machine";
import type { E3dcLiveData } from "@shared/schema";

// Mock all external dependencies (same pattern as charging-strategy.test.ts)
vi.mock("../core/storage", () => {
  const defaultContext = {
    strategy: "surplus_vehicle_prio" as const,
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
      startDelaySeconds: 0, // No delay for testing
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

describe("Car Full → Restart Loop Prevention", () => {
  let controller: ChargingStrategyController;
  let mockSendUdp: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.clearAllMocks();
    (storage as any)._reset();
    mockSendUdp = vi.fn().mockResolvedValue({});
    controller = new ChargingStrategyController(mockSendUdp, new RealPhaseProvider());
  });

  it("should NOT restart charging after car finishes (vehicle full → loop prevention)", async () => {
    const ip = DEFAULT_WALLBOX_IP;

    // Step 1: Car is actively charging (surplus strategy)
    (storage as any)._setContext({
      strategy: "surplus_vehicle_prio",
      isActive: true,
      currentAmpere: 10,
      targetAmpere: 10,
      currentPhases: 1,
      lastStartedAt: new Date(Date.now() - 60000).toISOString(), // Started 60s ago (past grace period)
    });

    // Step 2: Car becomes full → Wallbox stops (State=2, Power=0)
    // reconcileChargingContext sees: isActive=true but wallbox not charging
    mockSendUdp
      .mockResolvedValueOnce({ State: 2, Plug: 7 })  // report 2: State=2 (ready, not charging)
      .mockResolvedValueOnce({ P: 0, I1: 0, I2: 0, I3: 0 }); // report 3: no power

    // This simulates the reconcile recognizing "wallbox stopped after active charging"
    await (controller as any).reconcileChargingContext(ip);

    // After reconcile: isActive should be false
    const contextAfterReconcile = storage.getChargingContext();
    expect(contextAfterReconcile.isActive).toBe(false);

    // Step 3: processStrategy runs with good surplus - should NOT start charging again
    // Because the car finished charging (vehicleFinishedCharging flag should be set)
    mockSendUdp.mockClear();
    
    // Mock reconcile for processStrategy call (car still full, not charging)
    mockSendUdp
      .mockResolvedValueOnce({ State: 2, Plug: 7 })  // report 2
      .mockResolvedValueOnce({ P: 0, I1: 0, I2: 0, I3: 0 }) // report 3
      .mockResolvedValue({}); // potential ena 1, curr commands

    const liveData = makeLiveData({ pvPower: 5000, housePower: 1000, wallboxPower: 0 });
    await controller.processStrategy(liveData, ip);

    // The bug: without the fix, "ena 1" would be sent here → restart loop
    const ena1Calls = mockSendUdp.mock.calls.filter(
      (call: any[]) => call[1] === "ena 1"
    );
    expect(ena1Calls).toHaveLength(0); // Should NOT try to start charging
  });

  it("should allow charging again after cable is unplugged and replugged", async () => {
    const ip = DEFAULT_WALLBOX_IP;

    // Step 1: Car finished charging → vehicleFinishedCharging=true
    (storage as any)._setContext({
      strategy: "surplus_vehicle_prio",
      isActive: true,
      currentAmpere: 10,
      targetAmpere: 10,
      currentPhases: 1,
      lastStartedAt: new Date(Date.now() - 60000).toISOString(),
    });

    // Reconcile detects car stopped
    mockSendUdp
      .mockResolvedValueOnce({ State: 2, Plug: 7 })
      .mockResolvedValueOnce({ P: 0, I1: 0, I2: 0, I3: 0 });
    await (controller as any).reconcileChargingContext(ip);

    // Step 2: Cable unplugged (Plug changes from 7 to 1)
    mockSendUdp
      .mockResolvedValueOnce({ State: 1, Plug: 1 })
      .mockResolvedValueOnce({ P: 0, I1: 0, I2: 0, I3: 0 });
    await (controller as any).reconcileChargingContext(ip);

    // Step 3: Cable replugged (Plug back to 7)
    mockSendUdp
      .mockResolvedValueOnce({ State: 2, Plug: 7 })
      .mockResolvedValueOnce({ P: 0, I1: 0, I2: 0, I3: 0 });
    await (controller as any).reconcileChargingContext(ip);

    // Step 4: processStrategy should now be able to start charging
    // (vehicleFinishedCharging should have been reset by plug change)
    // Note: startDelaySeconds=0 requires TWO processStrategy calls:
    // 1st sets startDelayTrackerSince, 2nd triggers actual start
    mockSendUdp.mockClear();
    mockSendUdp
      .mockResolvedValueOnce({ State: 2, Plug: 7 })  // reconcile report 2 (1st call)
      .mockResolvedValueOnce({ P: 0, I1: 0, I2: 0, I3: 0 }) // reconcile report 3 (1st call)
      .mockResolvedValueOnce({ State: 2, Plug: 7 })  // reconcile report 2 (2nd call)
      .mockResolvedValueOnce({ P: 0, I1: 0, I2: 0, I3: 0 }) // reconcile report 3 (2nd call)
      .mockResolvedValue({}); // ena 1, curr commands

    const liveData = makeLiveData({ pvPower: 5000, housePower: 1000, wallboxPower: 0 });
    await controller.processStrategy(liveData, ip); // 1st: sets startDelayTracker
    await controller.processStrategy(liveData, ip); // 2nd: delay fulfilled → start

    // After unplug/replug, charging should be allowed again
    const ena1Calls = mockSendUdp.mock.calls.filter(
      (call: any[]) => call[1] === "ena 1"
    );
    expect(ena1Calls).toHaveLength(1); // Should start charging
  });

  it("should allow charging again after strategy change", async () => {
    const ip = DEFAULT_WALLBOX_IP;

    // Step 1: Car finished charging with surplus_vehicle_prio
    (storage as any)._setContext({
      strategy: "surplus_vehicle_prio",
      isActive: true,
      currentAmpere: 10,
      targetAmpere: 10,
      currentPhases: 1,
      lastStartedAt: new Date(Date.now() - 60000).toISOString(),
    });

    // Reconcile detects car stopped
    mockSendUdp
      .mockResolvedValueOnce({ State: 2, Plug: 7 })
      .mockResolvedValueOnce({ P: 0, I1: 0, I2: 0, I3: 0 });
    await (controller as any).reconcileChargingContext(ip);

    // Step 2: User switches strategy (e.g. to surplus_battery_prio and back)
    // switchStrategy should reset vehicleFinishedCharging
    (storage as any)._setSettings({
      ...storage.getSettings(),
      chargingStrategy: {
        ...storage.getSettings()!.chargingStrategy,
        activeStrategy: "surplus_battery_prio",
      },
    });
    await controller.switchStrategy("surplus_battery_prio", ip);

    // Step 3: Switch back to surplus_vehicle_prio
    (storage as any)._setSettings({
      ...storage.getSettings(),
      chargingStrategy: {
        ...storage.getSettings()!.chargingStrategy,
        activeStrategy: "surplus_vehicle_prio",
      },
    });
    await controller.switchStrategy("surplus_vehicle_prio", ip);

    // Step 4: processStrategy should now allow charging again
    // Note: startDelaySeconds=0 requires TWO processStrategy calls:
    // 1st sets startDelayTrackerSince, 2nd triggers actual start
    mockSendUdp.mockClear();
    mockSendUdp
      .mockResolvedValueOnce({ State: 2, Plug: 7 })  // reconcile report 2 (1st call)
      .mockResolvedValueOnce({ P: 0, I1: 0, I2: 0, I3: 0 }) // reconcile report 3 (1st call)
      .mockResolvedValueOnce({ State: 2, Plug: 7 })  // reconcile report 2 (2nd call)
      .mockResolvedValueOnce({ P: 0, I1: 0, I2: 0, I3: 0 }) // reconcile report 3 (2nd call)
      .mockResolvedValue({}); // ena 1, curr commands

    const liveData = makeLiveData({ pvPower: 5000, housePower: 1000, wallboxPower: 0 });
    await controller.processStrategy(liveData, ip); // 1st: sets startDelayTracker
    await controller.processStrategy(liveData, ip); // 2nd: delay fulfilled → start

    const ena1Calls = mockSendUdp.mock.calls.filter(
      (call: any[]) => call[1] === "ena 1"
    );
    expect(ena1Calls).toHaveLength(1); // Should start charging
  });

  it("should set vehicleFinishedCharging when reconcile detects car stopped after active charging", async () => {
    const ip = DEFAULT_WALLBOX_IP;

    // Car was actively charging
    (storage as any)._setContext({
      strategy: "surplus_vehicle_prio",
      isActive: true,
      currentAmpere: 10,
      targetAmpere: 10,
      currentPhases: 1,
      lastStartedAt: new Date(Date.now() - 60000).toISOString(),
    });

    // Wallbox stopped (car full)
    mockSendUdp
      .mockResolvedValueOnce({ State: 2, Plug: 7 })
      .mockResolvedValueOnce({ P: 0, I1: 0, I2: 0, I3: 0 });
    await (controller as any).reconcileChargingContext(ip);

    const context = storage.getChargingContext();
    expect(context.isActive).toBe(false);
    expect(context.vehicleFinishedCharging).toBe(true); // NEW field
  });

  it("state machine stays in CAR_FINISHED when vehicleFinishedCharging is true", () => {
    // State machine replaces shouldStartCharging: CAR_FINISHED state prevents restart
    const state = deriveState({
      isActive: false,
      vehicleFinishedCharging: true,
    });
    expect(state).toBe("CAR_FINISHED");

    const input: StateInput = {
      surplus: 5000,
      plug: 7,
      wallboxReallyCharging: false,
      targetCurrentMa: 6000,
      userLimitAmpere: undefined,
      strategy: "surplus_vehicle_prio",
      isMaxPower: false,
    };
    const config: StateConfig = {
      minStartPowerWatt: 1500,
      stopThresholdWatt: 500,
      startDelaySeconds: 0,
      stopDelaySeconds: 120,
    };
    const transition = evaluate(state, input, config, {
      stabilizationPeriodMs: 20000,
    });
    expect(transition.newState).toBe("CAR_FINISHED");
    expect(transition.actions.some(a => a.type === "START_CHARGING")).toBe(false);
  });
});

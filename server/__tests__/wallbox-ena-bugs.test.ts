/**
 * Tests for Wallbox ENA Bugs (#84, #85, #86)
 *
 * Bug 1 (#84): ena 1 stays active after vehicleFinishedCharging
 * Bug 2 (#85): CAR_FINISHED never auto-resets after 12h
 * Bug 3 (#86): switchStrategy() doesn't reset CAR_FINISHED on same-strategy switch
 *
 * TEST-FIRST: These tests should FAIL before the fix and PASS after.
 */

import { DEFAULT_WALLBOX_IP } from "../core/defaults";
import { describe, it, expect, beforeEach, vi } from "vitest";
import { ChargingStrategyController } from "../strategy/charging-strategy-controller";
import { RealPhaseProvider } from "../strategy/phase-provider";
import type { E3dcLiveData } from "@shared/schema";

// Mock all external dependencies
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
      getPlugStatusTracking: vi.fn(() => ({})),
      savePlugStatusTracking: vi.fn(),
      _reset: () => {
        context = { ...defaultContext };
        settings = JSON.parse(JSON.stringify(defaultSettings));
      },
      _setContext: (c: any) => { context = { ...context, ...c }; },
      _setSettings: (s: any) => { settings = s; },
      _getContext: () => context,
    },
  };
});

vi.mock("../core/logger", () => ({ log: vi.fn() }));
vi.mock("../e3dc/client", () => ({
  e3dcClient: { isConfigured: vi.fn(() => false), configure: vi.fn(), lockDischarge: vi.fn(), unlockDischarge: vi.fn() },
}));
vi.mock("../e3dc/modbus", () => ({ getE3dcLiveDataHub: vi.fn(() => ({ subscribe: vi.fn(() => vi.fn()) })) }));
vi.mock("../monitoring/prowl-notifier", () => ({ triggerProwlEvent: vi.fn(), getProwlNotifier: vi.fn() }));
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

// ─── Bug 1 (#84): ena 1 stays active after vehicleFinishedCharging ──────────

describe("Bug 1 (#84): ensureWallboxDisabled after vehicleFinishedCharging", () => {
  let controller: ChargingStrategyController;
  let mockSendUdp: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.clearAllMocks();
    (storage as any)._reset();
    mockSendUdp = vi.fn().mockResolvedValue({});
    controller = new ChargingStrategyController(mockSendUdp, new RealPhaseProvider());
  });

  it("should send ena 0 when vehicleFinishedCharging is detected (State 3→2, Plug=7, surplus strategy)", async () => {
    const ip = DEFAULT_WALLBOX_IP;

    // Car was charging, then finishes (State 3→2 at Plug=7)
    // After reconcile detects this, vehicleFinishedCharging=true is set
    // and ena 0 MUST be sent to disable the wallbox
    (storage as any)._setContext({
      strategy: "surplus_vehicle_prio",
      isActive: true,
      currentAmpere: 10,
      targetAmpere: 10,
      currentPhases: 1,
      lastStartedAt: new Date(Date.now() - 60000).toISOString(),
    });

    // Wallbox stopped (car full), but Enable sys is still 1
    mockSendUdp
      .mockResolvedValueOnce({ State: 2, Plug: 7, "Enable sys": 1 })  // report 2
      .mockResolvedValueOnce({ P: 0, I1: 0, I2: 0, I3: 0 })          // report 3
      .mockResolvedValue({});  // ena 0 command

    await (controller as any).reconcileChargingContext(ip);

    // ena 0 MUST have been sent
    const ena0Calls = mockSendUdp.mock.calls.filter(
      (call: any[]) => call[1] === "ena 0"
    );
    expect(ena0Calls.length).toBeGreaterThanOrEqual(1);
  });

  it("should send ena 0 in reconcile when !isActive, surplus strategy, and wallbox still enabled", async () => {
    const ip = DEFAULT_WALLBOX_IP;

    // Context: not active, surplus strategy, vehicleFinishedCharging
    (storage as any)._setContext({
      strategy: "surplus_vehicle_prio",
      isActive: false,
      currentAmpere: 0,
      targetAmpere: 0,
      currentPhases: 1,
      vehicleFinishedCharging: true,
    });

    // Wallbox reports: not charging but Enable sys=1
    mockSendUdp
      .mockResolvedValueOnce({ State: 2, Plug: 7, "Enable sys": 1 })  // report 2
      .mockResolvedValueOnce({ P: 0, I1: 0, I2: 0, I3: 0 })          // report 3
      .mockResolvedValue({});  // ena 0

    await (controller as any).reconcileChargingContext(ip);

    const ena0Calls = mockSendUdp.mock.calls.filter(
      (call: any[]) => call[1] === "ena 0"
    );
    expect(ena0Calls.length).toBeGreaterThanOrEqual(1);
  });

  it("should NOT send ena 0 when max_with_battery strategy (wants immediate charging)", async () => {
    const ip = DEFAULT_WALLBOX_IP;

    (storage as any)._setContext({
      strategy: "max_with_battery",
      isActive: false,
      currentAmpere: 0,
      targetAmpere: 0,
      currentPhases: 1,
      vehicleFinishedCharging: true,
    });
    (storage as any)._setSettings({
      ...storage.getSettings(),
      chargingStrategy: {
        ...storage.getSettings()!.chargingStrategy,
        activeStrategy: "max_with_battery",
      },
    });

    mockSendUdp
      .mockResolvedValueOnce({ State: 2, Plug: 7, "Enable sys": 1 })
      .mockResolvedValueOnce({ P: 0, I1: 0, I2: 0, I3: 0 })
      .mockResolvedValue({});

    await (controller as any).reconcileChargingContext(ip);

    const ena0Calls = mockSendUdp.mock.calls.filter(
      (call: any[]) => call[1] === "ena 0"
    );
    expect(ena0Calls).toHaveLength(0);
  });

  it("should NOT send ena 0 when nightCharging is active", async () => {
    const ip = DEFAULT_WALLBOX_IP;

    (storage as any)._setContext({
      strategy: "surplus_vehicle_prio",
      isActive: false,
      currentAmpere: 0,
      targetAmpere: 0,
      currentPhases: 1,
      vehicleFinishedCharging: true,
    });

    // nightCharging active
    vi.mocked(storage.getControlState).mockReturnValue({
      pvSurplus: false,
      nightCharging: true,
      batteryLock: false,
      gridCharging: false,
    });

    mockSendUdp
      .mockResolvedValueOnce({ State: 2, Plug: 7, "Enable sys": 1 })
      .mockResolvedValueOnce({ P: 0, I1: 0, I2: 0, I3: 0 })
      .mockResolvedValue({});

    await (controller as any).reconcileChargingContext(ip);

    const ena0Calls = mockSendUdp.mock.calls.filter(
      (call: any[]) => call[1] === "ena 0"
    );
    expect(ena0Calls).toHaveLength(0);
  });
});

// ─── Bug 2 (#85): CAR_FINISHED never auto-resets ────────────────────────────

describe("Bug 2 (#85): CAR_FINISHED auto-reset after 12h", () => {
  let controller: ChargingStrategyController;
  let mockSendUdp: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.clearAllMocks();
    (storage as any)._reset();
    mockSendUdp = vi.fn().mockResolvedValue({});
    controller = new ChargingStrategyController(mockSendUdp, new RealPhaseProvider());
  });

  it("should auto-reset vehicleFinishedCharging after 12h in reconcile", async () => {
    const ip = DEFAULT_WALLBOX_IP;
    const thirteenHoursAgo = new Date(Date.now() - 13 * 60 * 60 * 1000).toISOString();

    (storage as any)._setContext({
      strategy: "surplus_vehicle_prio",
      isActive: false,
      currentAmpere: 0,
      targetAmpere: 0,
      currentPhases: 1,
      vehicleFinishedCharging: true,
      vehicleFinishedAt: thirteenHoursAgo,
    });

    mockSendUdp
      .mockResolvedValueOnce({ State: 2, Plug: 7 })
      .mockResolvedValueOnce({ P: 0, I1: 0, I2: 0, I3: 0 })
      .mockResolvedValue({});

    await (controller as any).reconcileChargingContext(ip);

    const context = storage.getChargingContext();
    expect(context.vehicleFinishedCharging).toBe(false);
  });

  it("should NOT reset vehicleFinishedCharging if less than 12h", async () => {
    const ip = DEFAULT_WALLBOX_IP;
    const sixHoursAgo = new Date(Date.now() - 6 * 60 * 60 * 1000).toISOString();

    (storage as any)._setContext({
      strategy: "surplus_vehicle_prio",
      isActive: false,
      currentAmpere: 0,
      targetAmpere: 0,
      currentPhases: 1,
      vehicleFinishedCharging: true,
      vehicleFinishedAt: sixHoursAgo,
    });

    mockSendUdp
      .mockResolvedValueOnce({ State: 2, Plug: 7 })
      .mockResolvedValueOnce({ P: 0, I1: 0, I2: 0, I3: 0 })
      .mockResolvedValue({});

    await (controller as any).reconcileChargingContext(ip);

    const context = storage.getChargingContext();
    expect(context.vehicleFinishedCharging).toBe(true);
  });

  it("should set vehicleFinishedAt when vehicleFinishedCharging becomes true", async () => {
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
      .mockResolvedValueOnce({ P: 0, I1: 0, I2: 0, I3: 0 })
      .mockResolvedValue({});

    await (controller as any).reconcileChargingContext(ip);

    const context = storage.getChargingContext();
    expect(context.vehicleFinishedCharging).toBe(true);
    expect(context.vehicleFinishedAt).toBeDefined();
    // vehicleFinishedAt should be a recent timestamp (within last 5s)
    const finishedAt = new Date(context.vehicleFinishedAt!).getTime();
    expect(Date.now() - finishedAt).toBeLessThan(5000);
  });
});

// ─── Bug 3 (#86): switchStrategy doesn't reset CAR_FINISHED for same strategy ─

describe("Bug 3 (#86): switchStrategy reset on same-strategy switch", () => {
  let controller: ChargingStrategyController;
  let mockSendUdp: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.clearAllMocks();
    (storage as any)._reset();
    mockSendUdp = vi.fn().mockResolvedValue({});
    controller = new ChargingStrategyController(mockSendUdp, new RealPhaseProvider());
  });

  it("should reset vehicleFinishedCharging on same-strategy switch (surplus→surplus)", async () => {
    const ip = DEFAULT_WALLBOX_IP;

    // Car finished charging with surplus strategy
    (storage as any)._setContext({
      strategy: "surplus_vehicle_prio",
      isActive: false,
      currentAmpere: 0,
      targetAmpere: 0,
      currentPhases: 1,
      vehicleFinishedCharging: true,
      vehicleFinishedAt: new Date().toISOString(),
    });

    // User switches to same strategy (surplus_vehicle_prio → surplus_vehicle_prio)
    await controller.switchStrategy("surplus_vehicle_prio", ip);

    const context = storage.getChargingContext();
    expect(context.vehicleFinishedCharging).toBe(false);
  });

  it("should NOT reset vehicleFinishedCharging when switching to 'off'", async () => {
    const ip = DEFAULT_WALLBOX_IP;

    (storage as any)._setContext({
      strategy: "surplus_vehicle_prio",
      isActive: false,
      currentAmpere: 0,
      targetAmpere: 0,
      currentPhases: 1,
      vehicleFinishedCharging: true,
      vehicleFinishedAt: new Date().toISOString(),
    });

    await controller.switchStrategy("off", ip);

    const context = storage.getChargingContext();
    // When switching to "off", vehicleFinishedCharging should NOT be reset
    // because off means "don't charge" anyway
    expect(context.vehicleFinishedCharging).toBe(true);
  });

  it("should reset vehicleFinishedCharging on different-strategy switch (surplus→surplus_battery)", async () => {
    const ip = DEFAULT_WALLBOX_IP;

    (storage as any)._setContext({
      strategy: "surplus_vehicle_prio",
      isActive: false,
      currentAmpere: 0,
      targetAmpere: 0,
      currentPhases: 1,
      vehicleFinishedCharging: true,
      vehicleFinishedAt: new Date().toISOString(),
    });

    await controller.switchStrategy("surplus_battery_prio", ip);

    const context = storage.getChargingContext();
    expect(context.vehicleFinishedCharging).toBe(false);
  });
});

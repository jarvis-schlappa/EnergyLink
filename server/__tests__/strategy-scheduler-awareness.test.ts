import { DEFAULT_WALLBOX_IP } from "../core/defaults";
import { describe, it, expect, beforeEach, vi } from "vitest";
import { ChargingStrategyController } from "../strategy/charging-strategy-controller";
import { RealPhaseProvider } from "../strategy/phase-provider";

const mockLog = vi.fn();

vi.mock("../core/logger", () => ({
  log: (...args: any[]) => mockLog(...args),
}));

vi.mock("../core/storage", () => {
  const defaultContext = {
    strategy: "off" as const,
    isActive: false,
    currentAmpere: 0,
    targetAmpere: 0,
    currentPhases: 1,
    adjustmentCount: 0,
  };
  const defaultControlState = {
    pvSurplus: false,
    nightCharging: false,
    batteryLock: false,
    gridCharging: false,
  };
  const defaultSettings = {
    wallboxIp: DEFAULT_WALLBOX_IP,
    chargingStrategy: {
      activeStrategy: "off" as const,
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
  let controlState = { ...defaultControlState };
  let settings = JSON.parse(JSON.stringify(defaultSettings));
  return {
    storage: {
      getSettings: vi.fn(() => settings),
      saveSettings: vi.fn((s: any) => { settings = s; }),
      getChargingContext: vi.fn(() => context),
      updateChargingContext: vi.fn((updates: any) => { context = { ...context, ...updates }; }),
      saveChargingContext: vi.fn((c: any) => { context = c; }),
      getControlState: vi.fn(() => controlState),
      saveControlState: vi.fn((s: any) => { controlState = s; }),
      _reset: () => {
        context = { ...defaultContext };
        controlState = { ...defaultControlState };
        settings = JSON.parse(JSON.stringify(defaultSettings));
      },
      _setControlState: (s: any) => { controlState = { ...controlState, ...s }; },
      _setContext: (c: any) => { context = { ...context, ...c }; },
    },
  };
});

vi.mock("../e3dc/client", () => ({
  e3dcClient: {
    isConfigured: vi.fn(() => false),
    configure: vi.fn(),
    lockDischarge: vi.fn(),
    unlockDischarge: vi.fn(),
  },
}));

vi.mock("../e3dc/modbus", () => ({
  getE3dcLiveDataHub: vi.fn(() => ({
    subscribe: vi.fn(() => vi.fn()),
  })),
}));

vi.mock("../monitoring/prowl-notifier", () => ({
  triggerProwlEvent: vi.fn(),
}));

vi.mock("../wallbox/sse", () => ({
  broadcastWallboxStatus: vi.fn(),
  broadcastPartialUpdate: vi.fn(),
}));

import { storage } from "../core/storage";

describe("Strategy-Controller Scheduler Awareness (Issue #108)", () => {
  let controller: ChargingStrategyController;
  let mockSendUdp: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.clearAllMocks();
    (storage as any)._reset();
    mockSendUdp = vi.fn().mockResolvedValue({});
    controller = new ChargingStrategyController(mockSendUdp, new RealPhaseProvider());
  });

  it("does not interfere when scheduler is actively charging (nightCharging=true)", async () => {
    (storage as any)._setControlState({ nightCharging: true });

    await controller.stopChargingForStrategyOff(DEFAULT_WALLBOX_IP);

    expect(mockSendUdp).not.toHaveBeenCalled();

    const schedulerCalls = mockLog.mock.calls.filter(
      (call: any[]) => call[2]?.includes("Scheduler-Ladung aktiv")
    );
    expect(schedulerCalls.length).toBe(1);
  });

  it("operates normally when scheduler is not active (nightCharging=false)", async () => {
    (storage as any)._setControlState({ nightCharging: false });
    (storage as any)._setContext({ isActive: true, strategy: "surplus_battery_prio" });

    await controller.stopChargingForStrategyOff(DEFAULT_WALLBOX_IP);

    expect(mockSendUdp).toHaveBeenCalledWith(DEFAULT_WALLBOX_IP, "ena 0");

    const stopCalls = mockLog.mock.calls.filter(
      (call: any[]) => call[2]?.includes('Strategie auf "off"')
    );
    expect(stopCalls.length).toBeGreaterThanOrEqual(1);
  });

  it("does not log misleading 'already stopped' when scheduler is charging", async () => {
    (storage as any)._setControlState({ nightCharging: true });
    (storage as any)._setContext({ isActive: false, strategy: "off" });

    await controller.stopChargingForStrategyOff(DEFAULT_WALLBOX_IP);

    const alreadyStoppedCalls = mockLog.mock.calls.filter(
      (call: any[]) => call[2]?.includes("bereits gestoppt")
    );
    expect(alreadyStoppedCalls.length).toBe(0);

    const schedulerCalls = mockLog.mock.calls.filter(
      (call: any[]) => call[2]?.includes("Scheduler-Ladung aktiv")
    );
    expect(schedulerCalls.length).toBe(1);
  });
});

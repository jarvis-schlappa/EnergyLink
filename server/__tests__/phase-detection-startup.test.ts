/**
 * Phase Detection Startup Test (Issue #79, Bug B)
 *
 * When all wallbox currents are <500mA (startup/ramp), detectedPhases
 * should retain the last known value from context.currentPhases instead
 * of defaulting to 3P.
 *
 * Root cause: During startup, KEBA reports low currents (e.g. I1=397mA)
 * before ramping up. The old code defaulted to 3P when activePhases=0,
 * causing incorrect phase flapping.
 */

import { DEFAULT_WALLBOX_IP } from "../core/defaults";
import { describe, it, expect, beforeEach, vi } from "vitest";
import { ChargingStrategyController } from "../strategy/charging-strategy-controller";
import { RealPhaseProvider } from "../strategy/phase-provider";

vi.mock("../core/storage", () => {
  const defaultContext = {
    strategy: "max_without_battery" as const,
    isActive: true,
    currentAmpere: 16,
    targetAmpere: 16,
    currentPhases: 1,
    adjustmentCount: 0,
  };
  const defaultSettings = {
    wallboxIp: DEFAULT_WALLBOX_IP,
    chargingStrategy: {
      activeStrategy: "max_without_battery" as const,
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

describe("Phase detection during wallbox startup (Issue #79)", () => {
  let controller: ChargingStrategyController;
  let mockSendUdp: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.clearAllMocks();
    (storage as any)._reset();
    mockSendUdp = vi.fn().mockResolvedValue({});
    controller = new ChargingStrategyController(mockSendUdp, new RealPhaseProvider());
  });

  it("should retain context.currentPhases=1 when all currents are <500mA (startup ramp)", async () => {
    const ip = DEFAULT_WALLBOX_IP;

    // Context: 1P charging was active before
    (storage as any)._setContext({
      strategy: "max_without_battery",
      isActive: true,
      currentPhases: 1,
      currentAmpere: 16,
      targetAmpere: 16,
      lastStartedAt: new Date(Date.now() - 60000).toISOString(),
    });

    // Wallbox is in startup ramp: State=3 but all currents <500mA
    mockSendUdp
      .mockResolvedValueOnce({ State: 3, Plug: 7 })  // report 2
      .mockResolvedValueOnce({ P: 200000, I1: 397, I2: 0, I3: 0, "E pres": 100, "E total": 5000 });  // report 3

    await (controller as any).reconcileChargingContext(ip);

    const context = storage.getChargingContext();
    // Should keep 1P from context, NOT flip to 3P
    expect(context.currentPhases).toBe(1);
  });

  it("should detect 1P correctly when I1 >500mA", async () => {
    const ip = DEFAULT_WALLBOX_IP;

    (storage as any)._setContext({
      strategy: "max_without_battery",
      isActive: true,
      currentPhases: 1,
      currentAmpere: 16,
      targetAmpere: 16,
      lastStartedAt: new Date(Date.now() - 60000).toISOString(),
    });

    // Wallbox charging on 1 phase: I1=16A, others 0
    mockSendUdp
      .mockResolvedValueOnce({ State: 3, Plug: 7 })  // report 2
      .mockResolvedValueOnce({ P: 3680000, I1: 16000, I2: 0, I3: 0, "E pres": 500, "E total": 10000 });  // report 3

    await (controller as any).reconcileChargingContext(ip);

    const context = storage.getChargingContext();
    expect(context.currentPhases).toBe(1);
  });

  it("should detect 3P correctly when all currents >500mA", async () => {
    const ip = DEFAULT_WALLBOX_IP;

    (storage as any)._setContext({
      strategy: "max_without_battery",
      isActive: true,
      currentPhases: 1,  // was 1P before
      currentAmpere: 16,
      targetAmpere: 16,
      lastStartedAt: new Date(Date.now() - 60000).toISOString(),
    });

    // Wallbox charging on 3 phases
    mockSendUdp
      .mockResolvedValueOnce({ State: 3, Plug: 7 })  // report 2
      .mockResolvedValueOnce({ P: 11040000, I1: 16000, I2: 16000, I3: 16000, "E pres": 2000, "E total": 20000 });  // report 3

    await (controller as any).reconcileChargingContext(ip);

    const context = storage.getChargingContext();
    expect(context.currentPhases).toBe(3);
  });

  it("should retain context.currentPhases=3 when all currents <500mA and last was 3P", async () => {
    const ip = DEFAULT_WALLBOX_IP;

    // Context: 3P charging was active before
    (storage as any)._setContext({
      strategy: "max_without_battery",
      isActive: true,
      currentPhases: 3,
      currentAmpere: 16,
      targetAmpere: 16,
      lastStartedAt: new Date(Date.now() - 60000).toISOString(),
    });

    // Startup ramp: all currents low
    mockSendUdp
      .mockResolvedValueOnce({ State: 3, Plug: 7 })  // report 2
      .mockResolvedValueOnce({ P: 100000, I1: 200, I2: 100, I3: 50, "E pres": 50, "E total": 3000 });  // report 3

    await (controller as any).reconcileChargingContext(ip);

    const context = storage.getChargingContext();
    // Should keep 3P from context, NOT default to something else
    expect(context.currentPhases).toBe(3);
  });
});

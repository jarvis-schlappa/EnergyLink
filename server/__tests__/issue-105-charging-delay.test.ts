/**
 * Issue #105: Verzögerter Ladestart durch falsche Befehlsreihenfolge
 *
 * Problem: After WAIT_START → CHARGING transition, reconcileChargingContext()
 * sends report 2 + report 3 BEFORE the actual start command (ena 1).
 * This causes a ~2s delay before charging begins.
 *
 * Fix: When transitioning from WAIT_START → CHARGING, send ena 1 + curr
 * IMMEDIATELY (before reconcile). Reconcile runs after.
 *
 * Also fixes Ghost-Badge (#104): broadcastPartialUpdate should NOT send
 * state: 3 before the wallbox physically transitions.
 */
import { DEFAULT_WALLBOX_IP } from "../core/defaults";
import { describe, it, expect, beforeEach, vi } from "vitest";
import { ChargingStrategyController } from "../strategy/charging-strategy-controller";
import { RealPhaseProvider } from "../strategy/phase-provider";
import type { E3dcLiveData } from "@shared/schema";

// Track command order globally
let commandLog: string[] = [];

vi.mock("../core/storage", () => {
  const defaultContext = {
    strategy: "surplus_battery_prio" as const,
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
    e3dc: { enabled: false, pollingIntervalSeconds: 10 },
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

vi.mock("../core/logger", () => ({
  log: vi.fn(),
}));

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
  broadcastPartialUpdate: vi.fn(),
  broadcastWallboxStatus: vi.fn(),
}));

vi.mock("../wallbox/broadcast-listener", () => ({
  getAuthoritativePlugStatus: vi.fn(() => 7),
}));

import { storage } from "../core/storage";
import { broadcastPartialUpdate } from "../wallbox/sse";

function makeLiveData(overrides: Partial<E3dcLiveData> = {}): E3dcLiveData {
  return {
    pvPower: 5000,
    batteryPower: 1000,
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

describe("Issue #105: WAIT_START → CHARGING delay fix", () => {
  let controller: ChargingStrategyController;
  let mockSendUdp: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.clearAllMocks();
    (storage as any)._reset();
    commandLog = [];

    // Track ALL UDP commands in order
    mockSendUdp = vi.fn().mockImplementation((_ip: string, command: string) => {
      commandLog.push(command);
      // Return appropriate mock responses
      if (command === "report 2") {
        return Promise.resolve({ ID: 2, State: 2, Plug: 7, "Enable sys": 0, "Curr user": 32000 });
      }
      if (command === "report 3") {
        return Promise.resolve({ ID: 3, P: 0, I1: 0, I2: 0, I3: 0, U1: 230, U2: 0, U3: 0 });
      }
      // ena, curr commands
      return Promise.resolve({ "TCH-OK": "done" });
    });

    controller = new ChargingStrategyController(mockSendUdp, new RealPhaseProvider());
  });

  it("sends ena 1 BEFORE report 2/report 3 on WAIT_START → CHARGING transition", async () => {
    // Setup: We are in WAIT_START with expired timer (60s ago)
    const sixtySecondsAgo = new Date(Date.now() - 61_000).toISOString();
    (storage as any)._setContext({
      strategy: "surplus_battery_prio",
      isActive: false,
      currentAmpere: 0,
      targetAmpere: 0,
      currentPhases: 1,
      startDelayTrackerSince: sixtySecondsAgo, // Timer expired → WAIT_START state
      remainingStartDelay: 0,
    });

    const liveData = makeLiveData({ pvPower: 8000, housePower: 1000, wallboxPower: 0 });

    await controller.processStrategy(liveData, DEFAULT_WALLBOX_IP);

    // Verify ena 1 was sent
    const ena1Index = commandLog.indexOf("ena 1");
    expect(ena1Index).toBeGreaterThanOrEqual(0);

    // Verify reports were also sent (reconcile still runs, just AFTER start)
    const report2Index = commandLog.indexOf("report 2");
    const report3Index = commandLog.indexOf("report 3");

    // CORE ASSERTION: ena 1 must come BEFORE report 2 and report 3
    if (report2Index >= 0) {
      expect(ena1Index).toBeLessThan(report2Index);
    }
    if (report3Index >= 0) {
      expect(ena1Index).toBeLessThan(report3Index);
    }
  });

  it("sends curr command BEFORE report 2/report 3 on WAIT_START → CHARGING", async () => {
    const sixtySecondsAgo = new Date(Date.now() - 61_000).toISOString();
    (storage as any)._setContext({
      strategy: "surplus_battery_prio",
      isActive: false,
      currentAmpere: 0,
      targetAmpere: 0,
      currentPhases: 1,
      startDelayTrackerSince: sixtySecondsAgo,
      remainingStartDelay: 0,
    });

    const liveData = makeLiveData({ pvPower: 8000, housePower: 1000, wallboxPower: 0 });
    await controller.processStrategy(liveData, DEFAULT_WALLBOX_IP);

    // Find the curr command (e.g. "curr 8700" or similar)
    const currIndex = commandLog.findIndex(c => c.startsWith("curr "));
    expect(currIndex).toBeGreaterThanOrEqual(0);

    const report2Index = commandLog.indexOf("report 2");
    const report3Index = commandLog.indexOf("report 3");

    if (report2Index >= 0) {
      expect(currIndex).toBeLessThan(report2Index);
    }
    if (report3Index >= 0) {
      expect(currIndex).toBeLessThan(report3Index);
    }
  });

  it("still runs reconcile after start commands", async () => {
    const sixtySecondsAgo = new Date(Date.now() - 61_000).toISOString();
    (storage as any)._setContext({
      strategy: "surplus_battery_prio",
      isActive: false,
      currentAmpere: 0,
      targetAmpere: 0,
      currentPhases: 1,
      startDelayTrackerSince: sixtySecondsAgo,
      remainingStartDelay: 0,
    });

    const liveData = makeLiveData({ pvPower: 8000, housePower: 1000, wallboxPower: 0 });
    await controller.processStrategy(liveData, DEFAULT_WALLBOX_IP);

    // Reconcile should still have run (report 2 + report 3)
    expect(commandLog).toContain("report 2");
    expect(commandLog).toContain("report 3");
  });

  it("runs reconcile FIRST in non-WAIT_START states (e.g. IDLE)", async () => {
    // Setup: Normal IDLE state (no startDelayTrackerSince)
    (storage as any)._setContext({
      strategy: "surplus_battery_prio",
      isActive: false,
      currentAmpere: 0,
      targetAmpere: 0,
      currentPhases: 1,
    });

    // Low surplus - won't trigger start
    const liveData = makeLiveData({ pvPower: 2000, housePower: 1500, wallboxPower: 0 });
    await controller.processStrategy(liveData, DEFAULT_WALLBOX_IP);

    // Report commands should be first (normal reconcile order)
    expect(commandLog[0]).toBe("report 2");
    expect(commandLog[1]).toBe("report 3");
  });

  it("runs reconcile FIRST during CHARGING state (for phase detection)", async () => {
    // Setup: Already charging
    (storage as any)._setContext({
      strategy: "surplus_battery_prio",
      isActive: true,
      currentAmpere: 10,
      targetAmpere: 10,
      currentPhases: 1,
      lastStartedAt: new Date(Date.now() - 60_000).toISOString(), // started 60s ago
    });

    // Return charging state from wallbox
    mockSendUdp.mockImplementation((_ip: string, command: string) => {
      commandLog.push(command);
      if (command === "report 2") {
        return Promise.resolve({ ID: 2, State: 3, Plug: 7, "Enable sys": 1 });
      }
      if (command === "report 3") {
        return Promise.resolve({ ID: 3, P: 2300000, I1: 10000, I2: 0, I3: 0 });
      }
      return Promise.resolve({ "TCH-OK": "done" });
    });

    const liveData = makeLiveData({ pvPower: 5000, housePower: 1000, wallboxPower: 2300 });
    await controller.processStrategy(liveData, DEFAULT_WALLBOX_IP);

    // In CHARGING state, reconcile should come FIRST (normal order)
    expect(commandLog[0]).toBe("report 2");
    expect(commandLog[1]).toBe("report 3");
  });
});

describe("Issue #104: Ghost-Badge SSE fix", () => {
  let controller: ChargingStrategyController;
  let mockSendUdp: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.clearAllMocks();
    (storage as any)._reset();
    commandLog = [];

    mockSendUdp = vi.fn().mockImplementation((_ip: string, command: string) => {
      commandLog.push(command);
      if (command === "report 2") {
        return Promise.resolve({ ID: 2, State: 2, Plug: 7, "Enable sys": 0 });
      }
      if (command === "report 3") {
        return Promise.resolve({ ID: 3, P: 0, I1: 0, I2: 0, I3: 0 });
      }
      return Promise.resolve({ "TCH-OK": "done" });
    });

    controller = new ChargingStrategyController(mockSendUdp, new RealPhaseProvider());
  });

  it("SSE broadcast does NOT include state: 3 on startCharging", async () => {
    const sixtySecondsAgo = new Date(Date.now() - 61_000).toISOString();
    (storage as any)._setContext({
      strategy: "surplus_battery_prio",
      isActive: false,
      currentAmpere: 0,
      targetAmpere: 0,
      currentPhases: 1,
      startDelayTrackerSince: sixtySecondsAgo,
      remainingStartDelay: 0,
    });

    const liveData = makeLiveData({ pvPower: 8000, housePower: 1000, wallboxPower: 0 });
    await controller.processStrategy(liveData, DEFAULT_WALLBOX_IP);

    // broadcastPartialUpdate should have been called
    expect(broadcastPartialUpdate).toHaveBeenCalled();

    // It should NOT include state: 3 (wallbox hasn't physically transitioned yet)
    const calls = (broadcastPartialUpdate as any).mock.calls;
    for (const call of calls) {
      const payload = call[0];
      expect(payload.state).not.toBe(3);
    }
  });

  it("SSE broadcast includes enableSys: 1 on startCharging", async () => {
    const sixtySecondsAgo = new Date(Date.now() - 61_000).toISOString();
    (storage as any)._setContext({
      strategy: "surplus_battery_prio",
      isActive: false,
      currentAmpere: 0,
      targetAmpere: 0,
      currentPhases: 1,
      startDelayTrackerSince: sixtySecondsAgo,
      remainingStartDelay: 0,
    });

    const liveData = makeLiveData({ pvPower: 8000, housePower: 1000, wallboxPower: 0 });
    await controller.processStrategy(liveData, DEFAULT_WALLBOX_IP);

    // broadcastPartialUpdate should include enableSys: 1
    expect(broadcastPartialUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ enableSys: 1 })
    );
  });
});

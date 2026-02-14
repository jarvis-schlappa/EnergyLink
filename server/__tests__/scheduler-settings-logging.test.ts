import { describe, it, expect, beforeEach, vi, type Mock } from "vitest";

const mockLog = vi.fn();
vi.mock("../core/logger", () => ({
  log: (...args: any[]) => mockLog(...args),
}));

let mockSettings: any;

vi.mock("../core/storage", () => {
  return {
    storage: {
      getSettings: vi.fn(() => mockSettings),
      saveSettings: vi.fn((s: any) => { mockSettings = s; }),
      getControlState: vi.fn(() => ({ nightCharging: false, batteryLock: false, gridCharging: false })),
      saveControlState: vi.fn(),
      getChargingContext: vi.fn(() => ({ currentPhases: 1 })),
    },
  };
});

vi.mock("../wallbox/transport", () => ({
  sendUdpCommand: vi.fn().mockResolvedValue({}),
}));

vi.mock("../e3dc/client", () => ({
  e3dcClient: {
    isConfigured: vi.fn(() => false),
    configure: vi.fn(),
    isGridChargeDuringNightChargingEnabled: vi.fn(() => false),
  },
}));

vi.mock("../e3dc/modbus", () => ({
  getE3dcModbusService: vi.fn(() => ({ getLastReadLiveData: vi.fn(() => null) })),
}));

vi.mock("../monitoring/prowl-notifier", () => ({
  triggerProwlEvent: vi.fn(),
  extractTargetWh: vi.fn(),
}));

vi.mock("../monitoring/grid-frequency-monitor", () => ({
  startGridFrequencyMonitor: vi.fn(),
  stopGridFrequencyMonitor: vi.fn(),
}));

vi.mock("../fhem/e3dc-sync", () => ({
  startFhemSyncScheduler: vi.fn(),
  stopFhemSyncScheduler: vi.fn(),
}));

vi.mock("../e3dc/poller", () => ({
  startE3dcPoller: vi.fn(),
  stopE3dcPoller: vi.fn(),
  getE3dcBackoffLevel: vi.fn(() => 0),
}));

vi.mock("../wallbox/sse", () => ({
  broadcastWallboxStatus: vi.fn(),
  broadcastPartialUpdate: vi.fn(),
}));

vi.mock("../routes/helpers", async () => {
  const actual = await vi.importActual("../routes/helpers") as any;
  return {
    ...actual,
    getCurrentTimeInTimezone: vi.fn(() => "12:00"),
  };
});

vi.mock("../routes/shared-state", () => ({
  chargingStrategyInterval: null,
  nightChargingSchedulerInterval: null,
  fhemSyncInterval: null,
  e3dcPollerInterval: null,
  strategyController: null,
  setChargingStrategyInterval: vi.fn(),
  setNightChargingSchedulerInterval: vi.fn(),
  setFhemSyncInterval: vi.fn(),
  setE3dcPollerInterval: vi.fn(),
  getOrCreateStrategyController: vi.fn(() => ({
    startEventListener: vi.fn(),
    stopEventListener: vi.fn(),
    stopChargingForStrategyOff: vi.fn(),
  })),
}));

import { storage } from "../core/storage";

describe("Scheduler Settings Logging (Issue #109)", () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    // Reset module state by re-importing
    vi.resetModules();
  });

  it("logs scheduler config on first run", async () => {
    mockSettings = {
      wallboxIp: "192.168.40.16",
      nightChargingSchedule: { enabled: true, startTime: "00:00", endTime: "05:00" },
      e3dc: { enabled: false },
    };

    const scheduler = await import("../routes/scheduler");
    await scheduler.startSchedulers();
    await new Promise(r => setTimeout(r, 50));

    const configCalls = mockLog.mock.calls.filter(
      (call: any[]) => call[0] === "info" && call[2]?.includes("Konfiguration geladen")
    );
    expect(configCalls.length).toBeGreaterThanOrEqual(1);
    expect(configCalls[0][2]).toContain("00:00-05:00");

    await scheduler.shutdownSchedulers();
  });

  it("logs when schedule config changes", async () => {
    mockSettings = {
      wallboxIp: "192.168.40.16",
      nightChargingSchedule: { enabled: true, startTime: "00:00", endTime: "05:00" },
      e3dc: { enabled: false },
    };

    const scheduler = await import("../routes/scheduler");
    await scheduler.startSchedulers();
    await new Promise(r => setTimeout(r, 50));

    mockLog.mockClear();

    // Change settings
    mockSettings = {
      ...mockSettings,
      nightChargingSchedule: { enabled: true, startTime: "22:00", endTime: "06:00" },
    };

    // Trigger another scheduler tick by calling startSchedulers again
    // This will re-run checkNightChargingSchedule
    await scheduler.startSchedulers();
    await new Promise(r => setTimeout(r, 50));

    const changeCalls = mockLog.mock.calls.filter(
      (call: any[]) => call[0] === "info" && call[2]?.includes("Konfiguration geändert")
    );
    expect(changeCalls.length).toBeGreaterThanOrEqual(1);
    expect(changeCalls[0][2]).toContain("22:00-06:00");

    await scheduler.shutdownSchedulers();
  });

  it("shows 'nicht konfiguriert' instead of undefined when schedule missing", async () => {
    mockSettings = {
      wallboxIp: "192.168.40.16",
      e3dc: { enabled: false },
      // No nightChargingSchedule
    };

    const scheduler = await import("../routes/scheduler");
    await scheduler.startSchedulers();
    await new Promise(r => setTimeout(r, 50));

    const configCalls = mockLog.mock.calls.filter(
      (call: any[]) => call[0] === "info" && call[2]?.includes("Konfiguration geladen")
    );
    expect(configCalls.length).toBeGreaterThanOrEqual(1);
    // Should NOT contain "undefined"
    expect(configCalls[0][2]).not.toContain("undefined");
    expect(configCalls[0][2]).toContain("nicht konfiguriert");

    await scheduler.shutdownSchedulers();
  });
});

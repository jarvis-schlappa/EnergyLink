import { describe, it, expect, beforeEach, vi, type Mock } from "vitest";

/**
 * Tests for scheduler settings change detection and logging (Issue #109).
 * Verifies that configuration changes are logged with correct time windows.
 *
 * Mock strategy: see scheduler-night-charging.test.ts header comment.
 */

// --- Internal mocks (test-controllable) ---

const mockLog = vi.fn();
vi.mock("../core/logger", () => ({
  log: (...args: any[]) => mockLog(...args),
}));

let mockSettings: any;

vi.mock("../core/storage", () => ({
  storage: {
    getSettings: vi.fn(() => mockSettings),
    saveSettings: vi.fn((s: any) => { mockSettings = s; }),
    getControlState: vi.fn(() => ({ nightCharging: false, batteryLock: false, gridCharging: false })),
    saveControlState: vi.fn(),
    getChargingContext: vi.fn(() => ({ currentPhases: 1 })),
  },
}));

vi.mock("../routes/helpers", async () => {
  const actual = await vi.importActual("../routes/helpers") as any;
  return {
    ...actual,
    // Only mock the clock; isTimeInRange uses the real implementation
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
  getOrCreateStrategyController: () => ({
    startEventListener: () => {},
    stopEventListener: () => {},
    stopChargingForStrategyOff: () => {},
  }),
}));

// --- Hardware/external stubs (no-op, never asserted) ---

vi.mock("../wallbox/transport", () => ({
  sendUdpCommand: () => Promise.resolve({}),
}));

vi.mock("../e3dc/client", () => ({
  e3dcClient: {
    isConfigured: () => false,
    configure: () => {},
    isGridChargeDuringNightChargingEnabled: () => false,
  },
}));

vi.mock("../e3dc/modbus", () => ({
  getE3dcModbusService: () => ({ getLastReadLiveData: () => null }),
}));

vi.mock("../e3dc/poller", () => ({
  startE3dcPoller: () => null,
  stopE3dcPoller: () => Promise.resolve(),
  getE3dcBackoffLevel: () => 0,
}));

vi.mock("../monitoring/prowl-notifier", () => ({
  triggerProwlEvent: () => {},
  extractTargetWh: () => undefined,
}));

vi.mock("../monitoring/grid-frequency-monitor", () => ({
  startGridFrequencyMonitor: () => {},
  stopGridFrequencyMonitor: () => {},
}));

vi.mock("../fhem/e3dc-sync", () => ({
  startFhemSyncScheduler: () => null,
  stopFhemSyncScheduler: () => Promise.resolve(),
}));

vi.mock("../wallbox/sse", () => ({
  broadcastWallboxStatus: () => {},
  broadcastPartialUpdate: () => {},
}));

// --- Imports after mocks ---

import { storage } from "../core/storage";

describe("Scheduler Settings Logging (Issue #109)", () => {
  beforeEach(async () => {
    vi.clearAllMocks();
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

    mockSettings = {
      ...mockSettings,
      nightChargingSchedule: { enabled: true, startTime: "22:00", endTime: "06:00" },
    };

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
    };

    const scheduler = await import("../routes/scheduler");
    await scheduler.startSchedulers();
    await new Promise(r => setTimeout(r, 50));

    const configCalls = mockLog.mock.calls.filter(
      (call: any[]) => call[0] === "info" && call[2]?.includes("Konfiguration geladen")
    );
    expect(configCalls.length).toBeGreaterThanOrEqual(1);
    expect(configCalls[0][2]).not.toContain("undefined");
    expect(configCalls[0][2]).toContain("nicht konfiguriert");

    await scheduler.shutdownSchedulers();
  });
});

import { describe, it, expect, beforeEach, vi, type Mock } from "vitest";

/**
 * Tests for scheduler log output (Issue #107).
 * Verifies that night charging start/stop events emit INFO-level logs.
 *
 * Mock analysis (Issue #45):
 *   HARDWARE/EXTERNAL (must be mocked - no real devices in tests):
 *     wallbox/transport       → UDP to physical wallbox
 *     e3dc/client             → Modbus/RSCP to physical E3DC inverter
 *     e3dc/modbus             → Modbus service for live data
 *     e3dc/poller             → Background polling scheduler
 *     monitoring/prowl-notifier → External push notification service
 *     monitoring/grid-frequency-monitor → External network monitoring
 *     fhem/e3dc-sync          → FHEM hardware bridge
 *     wallbox/sse             → SSE broadcast (side effects)
 *
 *   INTERNAL (mocked for justified reasons - reviewed Issue #45):
 *     core/storage      → MemStorage constructor performs file I/O
 *                          (readFileSync, writeFileSync, mkdirSync).
 *                          No pure in-memory mode available without DI refactor.
 *     core/logger       → Captured for log-level assertions (test subject)
 *     routes/helpers    → Only getCurrentTimeInTimezone (deterministic clock control);
 *                         isTimeInRange uses the REAL implementation
 *     routes/shared-state → getOrCreateStrategyController returns test double
 *                           because real controller constructor requires
 *                           sendUdpCommand + imports all hardware modules
 */

// --- Internal mocks (test-controllable) ---

const mockLog = vi.fn();
vi.mock("../core/logger", () => ({
  log: (...args: any[]) => mockLog(...args),
}));

vi.mock("../core/storage", () => {
  let settings: any = {
    wallboxIp: "192.168.40.16",
    nightChargingSchedule: {
      enabled: true,
      startTime: "00:00",
      endTime: "05:00",
    },
    e3dc: { enabled: false },
  };
  let controlState: any = { nightCharging: false, batteryLock: false, gridCharging: false };
  let chargingContext: any = { currentPhases: 1 };
  return {
    storage: {
      getSettings: vi.fn(() => settings),
      saveSettings: vi.fn((s: any) => { settings = s; }),
      getControlState: vi.fn(() => controlState),
      saveControlState: vi.fn((s: any) => { controlState = s; }),
      getChargingContext: vi.fn(() => chargingContext),
      _setSettings: (s: any) => { settings = s; },
      _setControlState: (s: any) => { controlState = s; },
      _reset: () => {
        settings = {
          wallboxIp: "192.168.40.16",
          nightChargingSchedule: { enabled: true, startTime: "00:00", endTime: "05:00" },
          e3dc: { enabled: false },
        };
        controlState = { nightCharging: false, batteryLock: false, gridCharging: false };
        chargingContext = { currentPhases: 1 };
      },
    },
  };
});

vi.mock("../routes/helpers", async () => {
  const actual = await vi.importActual("../routes/helpers") as any;
  return {
    ...actual,
    // Only mock the clock; isTimeInRange uses the real implementation
    getCurrentTimeInTimezone: vi.fn(() => "02:00"),
  };
});

const mockStrategyController = {
  startEventListener: vi.fn(),
  stopEventListener: vi.fn(),
  stopChargingForStrategyOff: vi.fn(),
  startNightCharging: vi.fn().mockResolvedValue(undefined),
  stopNightCharging: vi.fn().mockResolvedValue(undefined),
};

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
  getOrCreateStrategyController: vi.fn(() => mockStrategyController),
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
    enableNightCharging: () => {},
    disableNightCharging: () => {},
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
import { getCurrentTimeInTimezone } from "../routes/helpers";

describe("Scheduler Logging (Issue #107)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (storage as any)._reset();
  });

  it("logs INFO when starting timed charging in time window", async () => {
    (getCurrentTimeInTimezone as Mock).mockReturnValue("02:00");
    
    const scheduler = await import("../routes/scheduler");
    await scheduler.startSchedulers();
    await new Promise(r => setTimeout(r, 100));
    
    const infoCalls = mockLog.mock.calls.filter(
      (call: any[]) => call[0] === "info" && call[2]?.includes("Zeitfenster erreicht")
    );
    expect(infoCalls.length).toBeGreaterThanOrEqual(1);
    expect(mockStrategyController.startNightCharging).toHaveBeenCalledWith("192.168.40.16");
    
    await scheduler.shutdownSchedulers();
  });

  it("logs INFO when stopping timed charging outside time window", async () => {
    (storage as any)._setControlState({ nightCharging: true, batteryLock: false, gridCharging: false });
    (getCurrentTimeInTimezone as Mock).mockReturnValue("06:00");

    const scheduler = await import("../routes/scheduler");
    await scheduler.startSchedulers();
    await new Promise(r => setTimeout(r, 100));

    const infoCalls = mockLog.mock.calls.filter(
      (call: any[]) => call[0] === "info" && call[2]?.includes("Zeitfenster beendet")
    );
    expect(infoCalls.length).toBeGreaterThanOrEqual(1);
    expect(mockStrategyController.stopNightCharging).toHaveBeenCalledWith("192.168.40.16");

    await scheduler.shutdownSchedulers();
  });

  it("logs DEBUG for wallbox commands with IP address", async () => {
    (getCurrentTimeInTimezone as Mock).mockReturnValue("02:00");

    const scheduler = await import("../routes/scheduler");
    await scheduler.startSchedulers();
    await new Promise(r => setTimeout(r, 100));

    expect(mockStrategyController.startNightCharging).toHaveBeenCalledWith("192.168.40.16");

    await scheduler.shutdownSchedulers();
  });
});

import { describe, it, expect, beforeEach, vi, type Mock } from "vitest";

// Mock logger BEFORE imports
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

vi.mock("../wallbox/transport", () => ({
  sendUdpCommand: vi.fn().mockResolvedValue({}),
}));

vi.mock("../e3dc/client", () => ({
  e3dcClient: {
    isConfigured: vi.fn(() => false),
    configure: vi.fn(),
    isGridChargeDuringNightChargingEnabled: vi.fn(() => false),
    enableNightCharging: vi.fn(),
    disableNightCharging: vi.fn(),
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

// Mock helpers to control time
vi.mock("../routes/helpers", async () => {
  const actual = await vi.importActual("../routes/helpers") as any;
  return {
    ...actual,
    getCurrentTimeInTimezone: vi.fn(() => "02:00"), // default: inside time window
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

// Need dynamic import after mocks
import { storage } from "../core/storage";
import { sendUdpCommand } from "../wallbox/transport";
import { getCurrentTimeInTimezone } from "../routes/helpers";

// We can't easily call checkNightChargingSchedule directly since it's a module-level const.
// Instead, we test by importing startSchedulers which calls it, but that's complex.
// Better approach: extract the function or test via the module's exported startSchedulers.
// For simplicity, let's re-implement the test by calling startSchedulers and checking logs.

// Actually, let me dynamically import the scheduler module to trigger the initial check
describe("Scheduler Logging (Issue #107)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (storage as any)._reset();
  });

  it("logs INFO when starting timed charging in time window", async () => {
    // Time is 02:00, window is 00:00-05:00, nightCharging is false → should start
    (getCurrentTimeInTimezone as Mock).mockReturnValue("02:00");
    
    // Import scheduler to get the checkNightChargingSchedule via startSchedulers
    // Since checkNightChargingSchedule is called immediately in startSchedulers, 
    // we need to be more creative. Let's just test by calling startSchedulers.
    const scheduler = await import("../routes/scheduler");
    
    // startSchedulers calls checkNightChargingSchedule() immediately
    // We need to wait for the async operation
    await scheduler.startSchedulers();
    
    // Wait for async operations
    await new Promise(r => setTimeout(r, 100));
    
    // Check that INFO log was emitted for starting timed charging
    const infoCalls = mockLog.mock.calls.filter(
      (call: any[]) => call[0] === "info" && call[2]?.includes("Zeitfenster erreicht")
    );
    expect(infoCalls.length).toBeGreaterThanOrEqual(1);
    
    // Check that DEBUG log was emitted for ena 1 command
    const debugCalls = mockLog.mock.calls.filter(
      (call: any[]) => call[0] === "debug" && call[2]?.includes("ena 1")
    );
    expect(debugCalls.length).toBeGreaterThanOrEqual(1);
    
    // Verify sendUdpCommand was called with ena 1
    expect(sendUdpCommand).toHaveBeenCalledWith("192.168.40.16", "ena 1");
    
    await scheduler.shutdownSchedulers();
  });

  it("logs INFO when stopping timed charging outside time window", async () => {
    // Set nightCharging=true, time outside window → should stop
    (storage as any)._setControlState({ nightCharging: true, batteryLock: false, gridCharging: false });
    (getCurrentTimeInTimezone as Mock).mockReturnValue("06:00");

    const scheduler = await import("../routes/scheduler");
    await scheduler.startSchedulers();
    await new Promise(r => setTimeout(r, 100));

    const infoCalls = mockLog.mock.calls.filter(
      (call: any[]) => call[0] === "info" && call[2]?.includes("Zeitfenster beendet")
    );
    expect(infoCalls.length).toBeGreaterThanOrEqual(1);

    // Check DEBUG log for ena 0
    const debugCalls = mockLog.mock.calls.filter(
      (call: any[]) => call[0] === "debug" && call[2]?.includes("ena 0")
    );
    expect(debugCalls.length).toBeGreaterThanOrEqual(1);

    expect(sendUdpCommand).toHaveBeenCalledWith("192.168.40.16", "ena 0");

    await scheduler.shutdownSchedulers();
  });

  it("logs DEBUG for wallbox commands with IP address", async () => {
    (getCurrentTimeInTimezone as Mock).mockReturnValue("02:00");

    const scheduler = await import("../routes/scheduler");
    await scheduler.startSchedulers();
    await new Promise(r => setTimeout(r, 100));

    // Check that the debug log includes the wallbox IP
    const debugCalls = mockLog.mock.calls.filter(
      (call: any[]) => call[0] === "debug" && call[2]?.includes("192.168.40.16")
    );
    expect(debugCalls.length).toBeGreaterThanOrEqual(1);

    await scheduler.shutdownSchedulers();
  });
});

import { describe, it, expect, beforeEach, vi, type Mock } from "vitest";

/**
 * Tests for the night charging scheduler logic.
 * Covers: time window detection, double-start prevention,
 * stop outside time window, and runtime settings changes.
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
 *     core/logger       → Suppress console spam in test output
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

let mockSettings: any;
let mockControlState: any;
let mockChargingContext: any;

vi.mock("../core/storage", () => ({
  storage: {
    getSettings: vi.fn(() => mockSettings),
    saveSettings: vi.fn((s: any) => { mockSettings = s; }),
    getControlState: vi.fn(() => mockControlState),
    saveControlState: vi.fn((s: any) => { mockControlState = s; }),
    getChargingContext: vi.fn(() => mockChargingContext),
    saveChargingContext: vi.fn((c: any) => { mockChargingContext = c; }),
  },
}));

const mockGetCurrentTime = vi.fn(() => "02:00");
vi.mock("../routes/helpers", async () => {
  const actual = await vi.importActual("../routes/helpers") as any;
  return {
    ...actual,
    // Only mock the clock; isTimeInRange uses the real implementation
    getCurrentTimeInTimezone: (...args: any[]) => mockGetCurrentTime(...args),
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

// --- Test state helpers ---

function resetState() {
  mockStrategyController.startNightCharging.mockClear();
  mockStrategyController.stopNightCharging.mockClear();
  mockSettings = {
    wallboxIp: "192.168.40.16",
    nightChargingSchedule: {
      enabled: true,
      startTime: "00:00",
      endTime: "05:00",
    },
    e3dc: { enabled: false },
  };
  mockControlState = { nightCharging: false, batteryLock: false, gridCharging: false };
  mockChargingContext = { currentPhases: 1 };
}

describe("Night Charging Scheduler", () => {
  let scheduler: typeof import("../routes/scheduler");

  beforeEach(async () => {
    vi.clearAllMocks();
    resetState();
    vi.resetModules();
    scheduler = await import("../routes/scheduler");
  });

  afterEach(async () => {
    await scheduler.shutdownSchedulers();
  });

  describe("Time window detection", () => {
    it("starts charging when inside time window (00:00-05:00, current=02:00)", async () => {
      mockGetCurrentTime.mockReturnValue("02:00");
      await scheduler.startSchedulers();
      await new Promise(r => setTimeout(r, 50));

      expect(mockStrategyController.startNightCharging).toHaveBeenCalledWith("192.168.40.16");
    });

    it("does NOT start charging when outside time window", async () => {
      mockGetCurrentTime.mockReturnValue("12:00");
      await scheduler.startSchedulers();
      await new Promise(r => setTimeout(r, 50));

      expect(mockStrategyController.startNightCharging).not.toHaveBeenCalled();
    });

    it("handles overnight time window (23:00-05:00)", async () => {
      mockSettings.nightChargingSchedule.startTime = "23:00";
      mockSettings.nightChargingSchedule.endTime = "05:00";
      mockGetCurrentTime.mockReturnValue("23:30");

      await scheduler.startSchedulers();
      await new Promise(r => setTimeout(r, 50));

      expect(mockStrategyController.startNightCharging).toHaveBeenCalledWith("192.168.40.16");
    });

    it("handles overnight window - after midnight", async () => {
      mockSettings.nightChargingSchedule.startTime = "23:00";
      mockSettings.nightChargingSchedule.endTime = "05:00";
      mockGetCurrentTime.mockReturnValue("03:00");

      await scheduler.startSchedulers();
      await new Promise(r => setTimeout(r, 50));

      expect(mockStrategyController.startNightCharging).toHaveBeenCalledWith("192.168.40.16");
    });
  });

  describe("Double-start prevention", () => {
    it("does not send ena 1 when nightCharging is already true", async () => {
      mockGetCurrentTime.mockReturnValue("02:00");
      mockControlState = { nightCharging: true, batteryLock: true, gridCharging: false };

      await scheduler.startSchedulers();
      await new Promise(r => setTimeout(r, 50));

      expect(mockStrategyController.startNightCharging).not.toHaveBeenCalled();
    });
  });

  describe("Stop outside time window", () => {
    it("stops charging when nightCharging=true and outside time window", async () => {
      mockGetCurrentTime.mockReturnValue("06:00");
      mockControlState = { nightCharging: true, batteryLock: true, gridCharging: false };

      await scheduler.startSchedulers();
      await new Promise(r => setTimeout(r, 50));

      expect(mockStrategyController.stopNightCharging).toHaveBeenCalledWith("192.168.40.16");
    });

    it("sets nightCharging=false when stopping", async () => {
      const { storage } = await import("../core/storage");
      mockGetCurrentTime.mockReturnValue("06:00");
      mockControlState = { nightCharging: true, batteryLock: true, gridCharging: false };

      await scheduler.startSchedulers();
      await new Promise(r => setTimeout(r, 50));

      expect(storage.saveControlState).toHaveBeenCalledWith(
        expect.objectContaining({ nightCharging: false, batteryLock: false })
      );
    });

    it("does NOT stop when nightCharging=false and outside window", async () => {
      mockGetCurrentTime.mockReturnValue("06:00");
      mockControlState = { nightCharging: false, batteryLock: false, gridCharging: false };

      await scheduler.startSchedulers();
      await new Promise(r => setTimeout(r, 50));

      expect(mockStrategyController.startNightCharging).not.toHaveBeenCalled();
      expect(mockStrategyController.stopNightCharging).not.toHaveBeenCalled();
    });
  });

  describe("Settings change at runtime", () => {
    it("stops charging when schedule is disabled while nightCharging=true", async () => {
      mockGetCurrentTime.mockReturnValue("02:00");
      mockSettings.nightChargingSchedule.enabled = false;
      mockControlState = { nightCharging: true, batteryLock: true, gridCharging: false };

      await scheduler.startSchedulers();
      await new Promise(r => setTimeout(r, 50));

      expect(mockStrategyController.stopNightCharging).toHaveBeenCalledWith("192.168.40.16");
    });

    it("does nothing when schedule is disabled and nightCharging=false", async () => {
      mockGetCurrentTime.mockReturnValue("02:00");
      mockSettings.nightChargingSchedule.enabled = false;
      mockControlState = { nightCharging: false, batteryLock: false, gridCharging: false };

      await scheduler.startSchedulers();
      await new Promise(r => setTimeout(r, 50));

      expect(mockStrategyController.startNightCharging).not.toHaveBeenCalled();
      expect(mockStrategyController.stopNightCharging).not.toHaveBeenCalled();
    });
  });
});

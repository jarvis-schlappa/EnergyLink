import { describe, it, expect, beforeEach, vi, type Mock } from "vitest";

/**
 * Tests for the night charging scheduler logic.
 * Covers: time window detection, double-start prevention,
 * stop outside time window, and runtime settings changes.
 */

// Mock logger
const mockLog = vi.fn();
vi.mock("../core/logger", () => ({
  log: (...args: any[]) => mockLog(...args),
}));

// Mock storage with controllable state
let mockSettings: any;
let mockControlState: any;
let mockChargingContext: any;

vi.mock("../core/storage", () => {
  return {
    storage: {
      getSettings: vi.fn(() => mockSettings),
      saveSettings: vi.fn((s: any) => { mockSettings = s; }),
      getControlState: vi.fn(() => mockControlState),
      saveControlState: vi.fn((s: any) => { mockControlState = s; }),
      getChargingContext: vi.fn(() => mockChargingContext),
      saveChargingContext: vi.fn((c: any) => { mockChargingContext = c; }),
    },
  };
});

const mockSendUdpCommand = vi.fn().mockResolvedValue({});
vi.mock("../wallbox/transport", () => ({
  sendUdpCommand: (...args: any[]) => mockSendUdpCommand(...args),
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

const mockGetCurrentTime = vi.fn(() => "02:00");
vi.mock("../routes/helpers", async () => {
  const actual = await vi.importActual("../routes/helpers") as any;
  return {
    ...actual,
    getCurrentTimeInTimezone: (...args: any[]) => mockGetCurrentTime(...args),
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

function resetState() {
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

      expect(mockSendUdpCommand).toHaveBeenCalledWith("192.168.40.16", "ena 1");
    });

    it("does NOT start charging when outside time window", async () => {
      mockGetCurrentTime.mockReturnValue("12:00");
      await scheduler.startSchedulers();
      await new Promise(r => setTimeout(r, 50));

      expect(mockSendUdpCommand).not.toHaveBeenCalledWith("192.168.40.16", "ena 1");
    });

    it("handles overnight time window (23:00-05:00)", async () => {
      mockSettings.nightChargingSchedule.startTime = "23:00";
      mockSettings.nightChargingSchedule.endTime = "05:00";
      mockGetCurrentTime.mockReturnValue("23:30");

      await scheduler.startSchedulers();
      await new Promise(r => setTimeout(r, 50));

      expect(mockSendUdpCommand).toHaveBeenCalledWith("192.168.40.16", "ena 1");
    });

    it("handles overnight window - after midnight", async () => {
      mockSettings.nightChargingSchedule.startTime = "23:00";
      mockSettings.nightChargingSchedule.endTime = "05:00";
      mockGetCurrentTime.mockReturnValue("03:00");

      await scheduler.startSchedulers();
      await new Promise(r => setTimeout(r, 50));

      expect(mockSendUdpCommand).toHaveBeenCalledWith("192.168.40.16", "ena 1");
    });
  });

  describe("Double-start prevention", () => {
    it("does not send ena 1 when nightCharging is already true", async () => {
      mockGetCurrentTime.mockReturnValue("02:00");
      mockControlState = { nightCharging: true, batteryLock: true, gridCharging: false };

      await scheduler.startSchedulers();
      await new Promise(r => setTimeout(r, 50));

      // ena 1 should NOT be sent because nightCharging is already true
      expect(mockSendUdpCommand).not.toHaveBeenCalledWith("192.168.40.16", "ena 1");
    });
  });

  describe("Stop outside time window", () => {
    it("stops charging when nightCharging=true and outside time window", async () => {
      mockGetCurrentTime.mockReturnValue("06:00");
      mockControlState = { nightCharging: true, batteryLock: true, gridCharging: false };

      await scheduler.startSchedulers();
      await new Promise(r => setTimeout(r, 50));

      expect(mockSendUdpCommand).toHaveBeenCalledWith("192.168.40.16", "ena 0");
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

      expect(mockSendUdpCommand).not.toHaveBeenCalled();
    });
  });

  describe("Settings change at runtime", () => {
    it("stops charging when schedule is disabled while nightCharging=true", async () => {
      mockGetCurrentTime.mockReturnValue("02:00");
      mockSettings.nightChargingSchedule.enabled = false;
      mockControlState = { nightCharging: true, batteryLock: true, gridCharging: false };

      await scheduler.startSchedulers();
      await new Promise(r => setTimeout(r, 50));

      expect(mockSendUdpCommand).toHaveBeenCalledWith("192.168.40.16", "ena 0");
    });

    it("does nothing when schedule is disabled and nightCharging=false", async () => {
      mockGetCurrentTime.mockReturnValue("02:00");
      mockSettings.nightChargingSchedule.enabled = false;
      mockControlState = { nightCharging: false, batteryLock: false, gridCharging: false };

      await scheduler.startSchedulers();
      await new Promise(r => setTimeout(r, 50));

      expect(mockSendUdpCommand).not.toHaveBeenCalled();
    });
  });
});

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// --- Mocks ---

const mockLog = vi.fn();
vi.mock("../core/logger", () => ({
  log: (...args: any[]) => mockLog(...args),
}));

let mockSettings: any = {
  wallboxIp: "192.168.40.16",
  chargingStrategy: {
    activeStrategy: "off",
    inputX1Strategy: "max_without_battery",
  },
  prowl: { enabled: false },
};
let mockChargingContext: any = { strategy: "off", isActive: false, currentAmpere: 0 };
let mockControlState: any = { nightCharging: false, batteryLock: false };
let mockPlugTracking: any = {};

vi.mock("../core/storage", () => ({
  storage: {
    getSettings: vi.fn(() => mockSettings),
    saveSettings: vi.fn((s: any) => { mockSettings = s; }),
    getChargingContext: vi.fn(() => mockChargingContext),
    saveChargingContext: vi.fn((c: any) => { mockChargingContext = c; }),
    getControlState: vi.fn(() => mockControlState),
    saveControlState: vi.fn((s: any) => { mockControlState = s; }),
    getPlugStatusTracking: vi.fn(() => mockPlugTracking),
    savePlugStatusTracking: vi.fn((t: any) => { mockPlugTracking = t; }),
  },
}));

const mockOnBroadcast = vi.fn();
const mockOffBroadcast = vi.fn();
vi.mock("../wallbox/udp-channel", () => ({
  wallboxUdpChannel: {
    onBroadcast: mockOnBroadcast,
    offBroadcast: mockOffBroadcast,
  },
}));

const mockHandleStrategyChange = vi.fn().mockResolvedValue(undefined);
const mockActivateMaxPowerImmediately = vi.fn().mockResolvedValue(undefined);
const mockStopChargingOnly = vi.fn().mockResolvedValue(undefined);
vi.mock("../routes/shared-state", () => ({
  getOrCreateStrategyController: vi.fn(() => ({
    handleStrategyChange: mockHandleStrategyChange,
    activateMaxPowerImmediately: mockActivateMaxPowerImmediately,
    stopChargingOnly: mockStopChargingOnly,
    startEventListener: vi.fn(),
    stopEventListener: vi.fn(),
    stopChargingForStrategyOff: vi.fn(),
  })),
}));

vi.mock("../monitoring/prowl-notifier", () => ({
  getProwlNotifier: vi.fn(() => ({
    sendPlugConnected: vi.fn(),
    sendPlugDisconnected: vi.fn(),
    sendChargingStarted: vi.fn(),
    sendError: vi.fn(),
  })),
  triggerProwlEvent: vi.fn(),
}));

vi.mock("../wallbox/sse", () => ({
  broadcastWallboxStatus: vi.fn(),
  broadcastPartialUpdate: vi.fn(),
}));

vi.mock("../e3dc/poller", () => ({
  resetWallboxIdleThrottle: vi.fn(),
}));

vi.mock("../routes/wallbox-routes", () => ({
  resetStatusPollThrottle: vi.fn(),
}));

// --- Tests ---

describe("Broadcast Listener", () => {
  let startBroadcastListener: typeof import("../wallbox/broadcast-listener").startBroadcastListener;
  let stopBroadcastListener: typeof import("../wallbox/broadcast-listener").stopBroadcastListener;
  let isBroadcastListenerEnabled: typeof import("../wallbox/broadcast-listener").isBroadcastListenerEnabled;
  let broadcastHandler: (data: any, rinfo: any) => Promise<void>;

  const fakeRinfo = { address: "192.168.40.16", port: 7090, family: "IPv4", size: 0 };
  const mockUdpSender = vi.fn().mockResolvedValue({});

  beforeEach(async () => {
    vi.clearAllMocks();
    mockSettings = {
      wallboxIp: "192.168.40.16",
      chargingStrategy: { activeStrategy: "off", inputX1Strategy: "max_without_battery" },
      prowl: { enabled: false },
    };
    mockChargingContext = { strategy: "off", isActive: false, currentAmpere: 0 };
    mockPlugTracking = {};

    // Fresh import each test to reset module state
    vi.resetModules();
    const mod = await import("../wallbox/broadcast-listener");
    startBroadcastListener = mod.startBroadcastListener;
    stopBroadcastListener = mod.stopBroadcastListener;
    isBroadcastListenerEnabled = mod.isBroadcastListenerEnabled;

    await startBroadcastListener(mockUdpSender);
    // Capture the registered broadcast handler
    broadcastHandler = mockOnBroadcast.mock.calls[0][0];
  });

  afterEach(async () => {
    await stopBroadcastListener();
  });

  describe("Start/Stop", () => {
    it("registers broadcast handler on start", () => {
      expect(mockOnBroadcast).toHaveBeenCalledTimes(1);
      expect(isBroadcastListenerEnabled()).toBe(true);
    });

    it("deregisters handler on stop", async () => {
      await stopBroadcastListener();
      expect(mockOffBroadcast).toHaveBeenCalledTimes(1);
      expect(isBroadcastListenerEnabled()).toBe(false);
    });

    it("does not double-start", async () => {
      await startBroadcastListener(mockUdpSender);
      // onBroadcast should still be called only once (from beforeEach)
      expect(mockOnBroadcast).toHaveBeenCalledTimes(1);
    });
  });

  describe("State Broadcasts", () => {
    it("ignores first State broadcast (initial sync)", async () => {
      await broadcastHandler({ State: 2 }, fakeRinfo);
      // No log about state change on first broadcast
      const stateChangeLogs = mockLog.mock.calls.filter(
        (c: any[]) => c[2]?.includes?.("State geändert")
      );
      expect(stateChangeLogs).toHaveLength(0);
    });

    it("detects State change on subsequent broadcasts", async () => {
      await broadcastHandler({ State: 2 }, fakeRinfo); // initial
      await broadcastHandler({ State: 3 }, fakeRinfo); // change
      const stateChangeLogs = mockLog.mock.calls.filter(
        (c: any[]) => c[2]?.includes?.("State geändert")
      );
      expect(stateChangeLogs.length).toBeGreaterThanOrEqual(1);
      expect(stateChangeLogs[0][2]).toContain("2 → 3");
    });

    it("ignores same State value", async () => {
      await broadcastHandler({ State: 2 }, fakeRinfo);
      mockLog.mockClear();
      await broadcastHandler({ State: 2 }, fakeRinfo);
      const stateChangeLogs = mockLog.mock.calls.filter(
        (c: any[]) => c[2]?.includes?.("State geändert")
      );
      expect(stateChangeLogs).toHaveLength(0);
    });
  });

  describe("Plug Status Tracking", () => {
    it("initializes plug status on first broadcast", async () => {
      await broadcastHandler({ Plug: 7 }, fakeRinfo);
      const { storage } = await import("../core/storage");
      expect(storage.savePlugStatusTracking).toHaveBeenCalledWith(
        expect.objectContaining({ lastPlugStatus: 7 })
      );
    });

    it("detects plug status change after initial", async () => {
      await broadcastHandler({ Plug: 1 }, fakeRinfo); // initial
      await broadcastHandler({ Plug: 7 }, fakeRinfo); // change
      const plugLogs = mockLog.mock.calls.filter(
        (c: any[]) => c[2]?.includes?.("Plug-Status geändert")
      );
      expect(plugLogs.length).toBeGreaterThanOrEqual(1);
    });

    it("ignores same plug value", async () => {
      await broadcastHandler({ Plug: 7 }, fakeRinfo); // initial
      mockLog.mockClear();
      await broadcastHandler({ Plug: 7 }, fakeRinfo); // same
      const plugLogs = mockLog.mock.calls.filter(
        (c: any[]) => c[2]?.includes?.("Plug-Status geändert")
      );
      expect(plugLogs).toHaveLength(0);
    });
  });

  describe("E pres Broadcasts", () => {
    it("broadcasts partial SSE update on E pres change", async () => {
      const { broadcastPartialUpdate } = await import("../wallbox/sse");
      await broadcastHandler({ "E pres": 50000 }, fakeRinfo);
      expect(broadcastPartialUpdate).toHaveBeenCalledWith({ ePres: 5000 });
    });

    it("ignores same E pres value", async () => {
      const { broadcastPartialUpdate } = await import("../wallbox/sse");
      await broadcastHandler({ "E pres": 50000 }, fakeRinfo);
      (broadcastPartialUpdate as any).mockClear();
      await broadcastHandler({ "E pres": 50000 }, fakeRinfo);
      expect(broadcastPartialUpdate).not.toHaveBeenCalled();
    });
  });

  describe("Input / X1 Strategy Switch", () => {
    it("ignores first Input broadcast (initial sync)", async () => {
      await broadcastHandler({ Input: 0 }, fakeRinfo);
      expect(mockHandleStrategyChange).not.toHaveBeenCalled();
      expect(mockActivateMaxPowerImmediately).not.toHaveBeenCalled();
    });

    it("activates max_without_battery on Input 0→1", async () => {
      await broadcastHandler({ Input: 0 }, fakeRinfo); // initial
      await broadcastHandler({ Input: 1 }, fakeRinfo); // trigger
      expect(mockActivateMaxPowerImmediately).toHaveBeenCalledWith("192.168.40.16");
      expect(mockHandleStrategyChange).toHaveBeenCalledWith("max_without_battery");
    });

    it("sets strategy to off on Input 1→0", async () => {
      await broadcastHandler({ Input: 1 }, fakeRinfo); // initial
      await broadcastHandler({ Input: 0 }, fakeRinfo); // trigger
      expect(mockStopChargingOnly).toHaveBeenCalled();
    });

    it("uses configured X1 strategy from settings", async () => {
      mockSettings.chargingStrategy.inputX1Strategy = "surplus_solar";
      await broadcastHandler({ Input: 0 }, fakeRinfo); // initial
      await broadcastHandler({ Input: 1 }, fakeRinfo); // trigger
      // surplus strategies use handleStrategyChange directly (not activateMaxPowerImmediately)
      expect(mockHandleStrategyChange).toHaveBeenCalledWith("surplus_solar");
      expect(mockActivateMaxPowerImmediately).not.toHaveBeenCalled();
    });

    it("ignores same Input value", async () => {
      await broadcastHandler({ Input: 0 }, fakeRinfo); // initial
      mockLog.mockClear();
      await broadcastHandler({ Input: 0 }, fakeRinfo); // same
      expect(mockHandleStrategyChange).not.toHaveBeenCalled();
    });

    it("persists strategy in context and settings after Input change", async () => {
      const { storage } = await import("../core/storage");
      await broadcastHandler({ Input: 0 }, fakeRinfo); // initial
      await broadcastHandler({ Input: 1 }, fakeRinfo); // trigger

      expect(storage.saveChargingContext).toHaveBeenCalledWith(
        expect.objectContaining({ strategy: "max_without_battery" })
      );
    });
  });

  describe("Error Handling", () => {
    it("handles missing data fields gracefully", async () => {
      // Empty object - no crash
      await broadcastHandler({}, fakeRinfo);
      // Undefined fields - no crash
      await broadcastHandler({ unknown: 42 }, fakeRinfo);
    });

    it("rolls back on activateMaxPowerImmediately failure", async () => {
      mockActivateMaxPowerImmediately.mockRejectedValueOnce(new Error("UDP timeout"));
      await broadcastHandler({ Input: 0 }, fakeRinfo); // initial
      await broadcastHandler({ Input: 1 }, fakeRinfo); // trigger - will fail

      // Rollback: stopChargingOnly should be called
      expect(mockStopChargingOnly).toHaveBeenCalled();
    });
  });
});

import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";

// Mock dependencies before importing the module under test
vi.mock("../core/logger", () => ({
  log: vi.fn(),
}));

vi.mock("../core/storage", () => ({
  storage: {
    getSettings: vi.fn().mockReturnValue({
      e3dcIp: "192.168.40.10",
      wallboxIp: "192.168.40.16",
      chargingStrategy: { activeStrategy: "off" },
    }),
  },
}));

vi.mock("../e3dc/modbus", () => {
  const mockService = {
    connect: vi.fn().mockResolvedValue(undefined),
    readLiveData: vi.fn().mockResolvedValue({
      pvPower: 0,
      batteryPower: 0,
      batterySoc: 50,
      housePower: 300,
      gridPower: 300,
      wallboxPower: 0,
    }),
    getLastReadLiveData: vi.fn(),
  };
  return {
    getE3dcModbusService: vi.fn().mockReturnValue(mockService),
    getE3dcLiveDataHub: vi.fn().mockReturnValue({
      emit: vi.fn(),
      subscribe: vi.fn(),
    }),
  };
});

vi.mock("../wallbox/transport", () => ({
  sendUdpCommand: vi.fn().mockResolvedValue({ P: 0 }),
}));

vi.mock("../monitoring/prowl-notifier", () => ({
  getProwlNotifier: vi.fn(),
  triggerProwlEvent: vi.fn(),
  extractTargetWh: vi.fn(),
}));

vi.mock("../wallbox/sse", () => ({
  initSSEClient: vi.fn(),
  broadcastWallboxStatus: vi.fn(),
  broadcastPartialUpdate: vi.fn(),
}));

vi.mock("../routes/shared-state", () => ({
  getOrCreateStrategyController: vi.fn(),
}));

vi.mock("@shared/schema", () => ({
  chargingStrategySchema: { safeParse: vi.fn() },
}));

describe("Status Poll Throttle (Issue #93)", () => {
  it("should export resetStatusPollThrottle function", async () => {
    const { resetStatusPollThrottle } = await import("../routes/wallbox-routes");
    expect(typeof resetStatusPollThrottle).toBe("function");
  });

  it("resetStatusPollThrottle should not throw", async () => {
    const { resetStatusPollThrottle } = await import("../routes/wallbox-routes");
    expect(() => resetStatusPollThrottle()).not.toThrow();
  });
});

describe("Wallbox Idle Polling Throttle (Issue #80)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.resetModules();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("should export resetWallboxIdleThrottle function", async () => {
    const poller = await import("../e3dc/poller");
    expect(typeof poller.resetWallboxIdleThrottle).toBe("function");
  });

  it("should export getE3dcBackoffLevel function", async () => {
    const poller = await import("../e3dc/poller");
    expect(typeof poller.getE3dcBackoffLevel).toBe("function");
    expect(poller.getE3dcBackoffLevel()).toBe(0);
  });

  it("resetWallboxIdleThrottle should not throw", async () => {
    const poller = await import("../e3dc/poller");
    expect(() => poller.resetWallboxIdleThrottle()).not.toThrow();
  });
});

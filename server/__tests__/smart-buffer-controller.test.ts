import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";

const mockBroadcastSmartBufferStatus = vi.fn();
const mockLog = vi.fn();

let mockSettings: any;
let mockControlState: any;

const mockSetMaxChargePower = vi.fn(async () => {});
const mockSetAutomaticMode = vi.fn(async () => {});
const mockIsConfigured = vi.fn(() => true);

vi.mock("../wallbox/sse", () => ({
  broadcastSmartBufferStatus: (...args: any[]) => mockBroadcastSmartBufferStatus(...args),
}));

vi.mock("../core/logger", () => ({
  log: (...args: any[]) => mockLog(...args),
}));

vi.mock("../core/storage", () => ({
  storage: {
    getSettings: vi.fn(() => mockSettings),
    getControlState: vi.fn(() => mockControlState),
  },
}));

vi.mock("../e3dc/client", () => ({
  e3dcClient: {
    setMaxChargePower: (...args: any[]) => mockSetMaxChargePower(...args),
    setAutomaticMode: (...args: any[]) => mockSetAutomaticMode(...args),
    isConfigured: (...args: any[]) => mockIsConfigured(...args),
  },
}));

vi.mock("../e3dc/modbus", () => ({
  getE3dcLiveDataHub: () => ({
    subscribe: () => () => {},
  }),
}));

describe("SmartBufferController", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-07T10:00:00.000Z"));

    mockSettings = {
      chargingStrategy: { activeStrategy: "smart_buffer" },
      smartBuffer: {
        latitude: 48.4,
        longitude: 10.0,
        pvArrays: [{ name: "Test", azimuthDeg: 180, tiltDeg: 30, kwp: 1 }],
        pvPeakKwp: 1,
        batteryCapacityKwh: 10,
        clippingGuardEntryWatt: 4300,
        clippingGuardExitWatt: 3800,
        clippingGuardTargetWatt: 4500,
        feedInLimitWatt: 4960,
        maxBatteryChargePower: 3000,
        targetSocEvening: 100,
        forecastRefreshIntervalMin: 15,
        winterRuleEndTimeUtc: "12:45",
        summerRuleEndTimeUtc: "15:00",
      },
      e3dc: {
        enabled: true,
      },
    };

    mockControlState = {
      nightCharging: false,
    };
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("sums forecast only for current Berlin day", async () => {
    const todayTs = Math.floor(new Date("2026-03-07T12:00:00.000Z").getTime() / 1000);
    const tomorrowTs = Math.floor(new Date("2026-03-08T12:15:00.000Z").getTime() / 1000);

    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        json: async () => ({
          minutely_15: {
            time: [todayTs, tomorrowTs],
            global_tilted_irradiance_instant: [1000, 1000],
          },
        }),
      })),
    );

    const { SmartBufferController } = await import("../strategy/smart-buffer-controller");
    const controller = new SmartBufferController();

    await controller.processLiveData({
      pvPower: 1500,
      batteryPower: 0,
      batterySoc: 70,
      housePower: 500,
      gridPower: -500,
      wallboxPower: 0,
      autarky: 90,
      selfConsumption: 80,
      timestamp: new Date().toISOString(),
    });

    const status = controller.getStatus();
    expect(status.forecastKwh).toBe(0.25);
    expect(mockBroadcastSmartBufferStatus).toHaveBeenCalled();
  });

  it("uses fallback timer only when stream is stale", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        json: async () => ({
          minutely_15: {
            time: [Math.floor(new Date("2026-03-07T10:00:00.000Z").getTime() / 1000)],
            global_tilted_irradiance_instant: [0],
          },
        }),
      })),
    );

    const { SmartBufferController } = await import("../strategy/smart-buffer-controller");
    const controller = new SmartBufferController();

    await controller.processLiveData({
      pvPower: 0,
      batteryPower: 0,
      batterySoc: 80,
      housePower: 400,
      gridPower: 100,
      wallboxPower: 0,
      autarky: 0,
      selfConsumption: 0,
      timestamp: new Date().toISOString(),
    });

    expect(controller.shouldRunFallback()).toBe(false);

    vi.advanceTimersByTime(21_000);
    expect(controller.shouldRunFallback()).toBe(true);
  });

  it("restores automatic mode when switching away from smart_buffer", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        json: async () => ({
          minutely_15: {
            time: [Math.floor(new Date("2026-03-07T10:00:00.000Z").getTime() / 1000)],
            global_tilted_irradiance_instant: [1000],
          },
        }),
      })),
    );

    const { SmartBufferController } = await import("../strategy/smart-buffer-controller");
    const controller = new SmartBufferController();

    await controller.processLiveData({
      pvPower: 7000,
      batteryPower: 0,
      batterySoc: 60,
      housePower: 500,
      gridPower: -6000,
      wallboxPower: 0,
      autarky: 100,
      selfConsumption: 80,
      timestamp: new Date().toISOString(),
    });

    expect(mockSetMaxChargePower).toHaveBeenCalled();

    await controller.handleStrategySwitch("smart_buffer", "off");

    expect(mockSetAutomaticMode).toHaveBeenCalled();
    expect(controller.getStatus().enabled).toBe(false);
  });
});

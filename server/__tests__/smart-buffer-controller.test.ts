import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";

const mockBroadcastSmartBufferStatus = vi.fn();
const mockLog = vi.fn();
let mockPlugStatus: number | null = 1;

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

vi.mock("../wallbox/broadcast-listener", () => ({
  getAuthoritativePlugStatus: () => mockPlugStatus,
}));

describe("SmartBufferController", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-07T10:00:00.000Z"));
    mockPlugStatus = 1;

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
      batterySoc: 20,
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

  it("writes structured debug cycle log with all analysis fields", async () => {
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
      pvPower: 2200,
      batteryPower: 0,
      batterySoc: 70,
      housePower: 500,
      gridPower: -600,
      wallboxPower: 0,
      autarky: 0,
      selfConsumption: 0,
      timestamp: new Date().toISOString(),
    });

    const debugCycleCall = mockLog.mock.calls.find((call: any[]) => call[0] === "debug" && call[2] === "Smart Buffer Zyklus");
    expect(debugCycleCall).toBeTruthy();

    const details = String(debugCycleCall?.[3] ?? "");
    expect(details).toContain("timestamp=");
    expect(details).toContain("phase=");
    expect(details).toContain("soc=");
    expect(details).toContain("soc_ziel=");
    expect(details).toContain("pv_leistung=");
    expect(details).toContain("hauslast=");
    expect(details).toContain("einspeisung=");
    expect(details).toContain("ladeleistung_soll=");
    expect(details).toContain("akku_limit_ist=");
    expect(details).toContain("wallbox_strom=");
    expect(details).toContain("wallbox_leistung=");
    expect(details).toContain("auto_anwesend=");
    expect(details).toContain("regelzeit_ende=");
    expect(details).toContain("phase_change=true");
    expect(details).toContain("phase_change_grund=");
  });

  it("logs battery limit adjustment only outside deadband", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        json: async () => ({
          minutely_15: {
            time: [Math.floor(new Date("2026-03-07T10:00:00.000Z").getTime() / 1000)],
            global_tilted_irradiance_instant: [500],
          },
        }),
      })),
    );

    const { SmartBufferController } = await import("../strategy/smart-buffer-controller");
    const controller = new SmartBufferController();

    await controller.processLiveData({
      pvPower: 1300,
      batteryPower: 0,
      batterySoc: 90,
      housePower: 200,
      gridPower: -300,
      wallboxPower: 0,
      autarky: 0,
      selfConsumption: 0,
      timestamp: new Date().toISOString(),
    });

    vi.advanceTimersByTime(10_000);

    await controller.processLiveData({
      pvPower: 1300,
      batteryPower: 0,
      batterySoc: 90,
      housePower: 200,
      gridPower: -300,
      wallboxPower: 0,
      autarky: 0,
      selfConsumption: 0,
      timestamp: new Date().toISOString(),
    });

    const batteryLimitLogs = mockLog.mock.calls.filter(
      (call: any[]) => call[0] === "info" && String(call[2]).includes("Akku-Limit angepasst"),
    );
    expect(batteryLimitLogs).toHaveLength(1);
  });

  it("treats Plug=7 as connected car even when wallboxPower is 0", async () => {
    mockPlugStatus = 7;
    vi.setSystemTime(new Date("2026-03-07T13:30:00.000Z"));
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

    // Bei erkanntem Auto wird die Soll-Leistung auf den real verfügbaren Anteil begrenzt.
    expect(controller.getStatus().targetChargePowerWatt).toBe(1000);
  });

  it("applies grid import activation and recovery delays before toggling fill-up power", async () => {
    mockPlugStatus = 7;
    vi.setSystemTime(new Date("2026-03-07T13:30:00.000Z"));
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
    expect(controller.getStatus().targetChargePowerWatt).toBe(1000);

    await controller.processLiveData({
      pvPower: 1500,
      batteryPower: 0,
      batterySoc: 70,
      housePower: 500,
      gridPower: 50,
      wallboxPower: 0,
      autarky: 90,
      selfConsumption: 80,
      timestamp: new Date().toISOString(),
    });
    expect(controller.getStatus().targetChargePowerWatt).toBe(1000);

    vi.advanceTimersByTime(21_000);
    await controller.processLiveData({
      pvPower: 1500,
      batteryPower: 0,
      batterySoc: 70,
      housePower: 500,
      gridPower: 50,
      wallboxPower: 0,
      autarky: 90,
      selfConsumption: 80,
      timestamp: new Date().toISOString(),
    });
    expect(controller.getStatus().targetChargePowerWatt).toBe(0);

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
    expect(controller.getStatus().targetChargePowerWatt).toBe(0);

    vi.advanceTimersByTime(46_000);
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
    expect(controller.getStatus().targetChargePowerWatt).toBe(1000);
  });
});

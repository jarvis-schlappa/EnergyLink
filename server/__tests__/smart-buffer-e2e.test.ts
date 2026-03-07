import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import type { E3dcLiveData } from "@shared/schema";
import { DEFAULT_WALLBOX_IP } from "../core/defaults";

const mockBroadcastSmartBufferStatus = vi.fn();
const mockBroadcastPartialUpdate = vi.fn();
const mockLog = vi.fn();
const mockTriggerProwlEvent = vi.fn();

let mockSettings: any;
let mockControlState: any;
let mockChargingContext: any;

const mockSetMaxChargePower = vi.fn(async () => {});
const mockSetAutomaticMode = vi.fn(async () => {});
const mockIsConfigured = vi.fn(() => true);

vi.mock("../wallbox/sse", () => ({
  broadcastSmartBufferStatus: (...args: any[]) => mockBroadcastSmartBufferStatus(...args),
  broadcastPartialUpdate: (...args: any[]) => mockBroadcastPartialUpdate(...args),
}));

vi.mock("../core/logger", () => ({
  log: (...args: any[]) => mockLog(...args),
}));

vi.mock("../core/storage", () => ({
  storage: {
    getSettings: vi.fn(() => mockSettings),
    saveSettings: vi.fn((next: any) => { mockSettings = next; }),
    getControlState: vi.fn(() => mockControlState),
    saveControlState: vi.fn((next: any) => { mockControlState = next; }),
    getChargingContext: vi.fn(() => mockChargingContext),
    updateChargingContext: vi.fn((updates: any) => { mockChargingContext = { ...mockChargingContext, ...updates }; }),
    saveChargingContext: vi.fn((next: any) => { mockChargingContext = next; }),
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
  getAuthoritativePlugStatus: vi.fn(() => 7),
}));

vi.mock("../monitoring/prowl-notifier", () => ({
  triggerProwlEvent: (...args: any[]) => mockTriggerProwlEvent(...args),
}));

function makeLiveData(overrides: Partial<E3dcLiveData> = {}): E3dcLiveData {
  return {
    pvPower: 0,
    batteryPower: 0,
    batterySoc: 50,
    housePower: 500,
    gridPower: 0,
    wallboxPower: 0,
    autarky: 0,
    selfConsumption: 0,
    timestamp: new Date().toISOString(),
    ...overrides,
  };
}

function setNow(iso: string): void {
  vi.setSystemTime(new Date(iso));
}

function stubForecastOk(irradiance = 1000): void {
  const ts = Math.floor(new Date("2026-03-07T12:00:00.000Z").getTime() / 1000);
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({
      ok: true,
      json: async () => ({
        minutely_15: {
          time: [ts],
          global_tilted_irradiance_instant: [irradiance],
        },
      }),
    })),
  );
}

describe("SmartBufferController E2E scenarios (Issue #109)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
    vi.useFakeTimers();
    setNow("2026-03-07T10:00:00.000Z");

    mockSettings = {
      chargingStrategy: {
        activeStrategy: "smart_buffer",
        minStartPowerWatt: 1400,
        stopThresholdWatt: 500,
        startDelaySeconds: 60,
        stopDelaySeconds: 60,
        physicalPhaseSwitch: 1,
        minCurrentChangeAmpere: 1,
        minChangeIntervalSeconds: 30,
        inputX1Strategy: "max_without_battery",
      },
      smartBuffer: {
        latitude: 48.4,
        longitude: 10.0,
        pvArrays: [{ name: "Test", azimuthDeg: 180, tiltDeg: 30, kwp: 1 }],
        pvPeakKwp: 9.92,
        batteryCapacityKwh: 13.8,
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
      e3dc: { enabled: true },
    };

    mockControlState = { nightCharging: false, batteryLock: false, gridCharging: false };
    mockChargingContext = {
      strategy: "smart_buffer",
      isActive: false,
      currentAmpere: 0,
      targetAmpere: 0,
      currentPhases: 1,
      userCurrentLimitAmpere: 32,
      adjustmentCount: 0,
    };
    stubForecastOk();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("1) Sonniger Tag mit Auto: MORNING_HOLD -> CLIPPING_GUARD bei >4300W, SOC-Regelung aktiv", async () => {
    const { SmartBufferController } = await import("../strategy/smart-buffer-controller");
    const controller = new SmartBufferController();

    await controller.processLiveData(makeLiveData({ pvPower: 0, housePower: 1200, gridPower: 600, wallboxPower: 200, batterySoc: 30 }));
    await controller.processLiveData(makeLiveData({ pvPower: 7000, housePower: 1200, gridPower: -4500, wallboxPower: 2500, batterySoc: 31 }));

    const status = controller.getStatus();
    expect(status.phase).toBe("CLIPPING_GUARD");
    expect(status.targetChargePowerWatt).toBeGreaterThan(0);
    expect(status.phaseChanges.some((p) => p.from === "MORNING_HOLD" && p.to === "CLIPPING_GUARD")).toBe(true);
  });

  it("2) Bewölkter Tag ohne Auto: dynamische Ladeleistung steigt bei sinkender Restzeit", async () => {
    const { SmartBufferController } = await import("../strategy/smart-buffer-controller");
    const controller = new SmartBufferController();

    setNow("2026-03-07T10:00:00.000Z");
    await controller.processLiveData(makeLiveData({ pvPower: 1800, housePower: 700, gridPower: -500, wallboxPower: 0, batterySoc: 40 }));
    const earlyTarget = controller.getStatus().targetChargePowerWatt;

    // Beide Zeitpunkte liegen vor Regelzeitende, damit die Dynamik in FILL_UP vergleichbar bleibt.
    setNow("2026-03-07T12:00:00.000Z");
    await controller.processLiveData(makeLiveData({ pvPower: 1500, housePower: 700, gridPower: -300, wallboxPower: 0, batterySoc: 40 }));
    const lateTarget = controller.getStatus().targetChargePowerWatt;

    expect(lateTarget).toBeGreaterThan(earlyTarget);
  });

  it("3) Wolkendurchgang in CLIPPING_GUARD: Rückkehr nach 60s unter 3800W", async () => {
    const { SmartBufferController } = await import("../strategy/smart-buffer-controller");
    const controller = new SmartBufferController();

    await controller.processLiveData(makeLiveData({ pvPower: 7000, housePower: 1000, gridPower: -5000, batterySoc: 50 }));
    expect(controller.getStatus().phase).toBe("CLIPPING_GUARD");

    await controller.processLiveData(makeLiveData({ pvPower: 3500, housePower: 1200, gridPower: -3000, batterySoc: 50 }));
    expect(controller.getStatus().phase).toBe("CLIPPING_GUARD");

    vi.advanceTimersByTime(61_000);
    await controller.processLiveData(makeLiveData({ pvPower: 3300, housePower: 1100, gridPower: -2900, batterySoc: 50 }));

    expect(controller.getStatus().phase).toBe("MORNING_HOLD");
  });

  it("4) Abregelschutz: Akku-Limit schrittweise (max 500W/Zyklus)", async () => {
    const { SmartBufferController } = await import("../strategy/smart-buffer-controller");
    const controller = new SmartBufferController();

    await controller.processLiveData(makeLiveData({ pvPower: 6800, housePower: 1200, gridPower: -4600, batterySoc: 60 }));
    await controller.processLiveData(makeLiveData({ pvPower: 6900, housePower: 1200, gridPower: -4700, batterySoc: 60 }));
    await controller.processLiveData(makeLiveData({ pvPower: 7000, housePower: 1200, gridPower: -4790, batterySoc: 60 }));

    const setCalls = mockSetMaxChargePower.mock.calls.map((c) => c[0]);
    expect(setCalls.length).toBeGreaterThan(1);

    for (let i = 1; i < setCalls.length; i++) {
      expect(Math.abs(setCalls[i] - setCalls[i - 1])).toBeLessThanOrEqual(500);
    }
  });

  it("5) PV-Einbruch am Nachmittag: targetChargePower steigt automatisch", async () => {
    const { SmartBufferController } = await import("../strategy/smart-buffer-controller");
    const controller = new SmartBufferController();

    setNow("2026-03-07T11:00:00.000Z");
    await controller.processLiveData(makeLiveData({ pvPower: 6000, housePower: 900, gridPower: -2000, batterySoc: 50 }));
    const morningTarget = controller.getStatus().targetChargePowerWatt;

    setNow("2026-03-07T13:00:00.000Z");
    await controller.processLiveData(makeLiveData({ pvPower: 2500, housePower: 900, gridPower: -200, batterySoc: 50 }));
    const afterDropTarget = controller.getStatus().targetChargePowerWatt;

    expect(afterDropTarget).toBeGreaterThan(morningTarget);
  });

  it("6) Nach Regelzeitende: STANDBY ohne irreführende Soll-Ladeleistung", async () => {
    const { SmartBufferController } = await import("../strategy/smart-buffer-controller");
    const controller = new SmartBufferController();

    setNow("2026-03-07T15:00:00.000Z");
    await controller.processLiveData(makeLiveData({ pvPower: 2500, housePower: 800, gridPower: -300, wallboxPower: 0, batterySoc: 40 }));

    const status = controller.getStatus();
    expect(status.phase).toBe("STANDBY");
    expect(status.targetChargePowerWatt).toBe(0);
    expect(status.batteryChargeLimitWatt).toBe(0);
  });

  it("7) FILL_UP bei Netzbezug: Ladeleistung geht auf 0W", async () => {
    const { SmartBufferController } = await import("../strategy/smart-buffer-controller");
    const controller = new SmartBufferController();

    await controller.processLiveData(makeLiveData({ pvPower: 4000, housePower: 1000, gridPower: -500, batterySoc: 45 }));
    expect(controller.getStatus().phase).toBe("FILL_UP");

    await controller.processLiveData(makeLiveData({ pvPower: 800, housePower: 1400, gridPower: 600, batterySoc: 45 }));

    expect(controller.getStatus().targetChargePowerWatt).toBe(0);
  });

  it("8) Open-Meteo offline: SOC-Regelung läuft weiter, Warnung wird geloggt", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("network down"); }));

    const { SmartBufferController } = await import("../strategy/smart-buffer-controller");
    const controller = new SmartBufferController();

    await controller.processLiveData(makeLiveData({ pvPower: 2000, housePower: 900, gridPower: -200, batterySoc: 35 }));

    const warningCalls = mockLog.mock.calls.filter((c: any[]) => c[0] === "warning" && String(c[2]).includes("Open-Meteo Forecast fehlgeschlagen"));
    expect(warningCalls.length).toBeGreaterThanOrEqual(1);
    expect(controller.getStatus().targetChargePowerWatt).toBeGreaterThan(0);
  });

  it("9) Strategiewechsel: aktiv -> off setzt Automatik und deaktiviert", async () => {
    const { SmartBufferController } = await import("../strategy/smart-buffer-controller");
    const controller = new SmartBufferController();

    await controller.processLiveData(makeLiveData({ pvPower: 6900, housePower: 1200, gridPower: -4700, batterySoc: 55 }));
    expect(controller.getStatus().enabled).toBe(true);

    await controller.handleStrategySwitch("smart_buffer", "off");

    expect(mockSetAutomaticMode).toHaveBeenCalled();
    expect(controller.getStatus().enabled).toBe(false);
  });

  it.skip("10) Crash-Recovery wird in server/index.ts getestet (hier bewusst übersprungen)", () => {
    // bewusst leer
  });

  it("11) Night-Charging Koexistenz: bei nightCharging=true deaktiviert sich smart_buffer", async () => {
    const { SmartBufferController } = await import("../strategy/smart-buffer-controller");
    const controller = new SmartBufferController();

    await controller.processLiveData(makeLiveData({ pvPower: 6500, housePower: 1000, gridPower: -4500, batterySoc: 50 }));
    expect(controller.getStatus().enabled).toBe(true);

    mockControlState = { nightCharging: true };
    await controller.processLiveData(makeLiveData({ pvPower: 6500, housePower: 1000, gridPower: -4500, batterySoc: 50 }));

    expect(controller.getStatus().enabled).toBe(false);
  });

  it("12) Smart Buffer startet Wallbox über Surplus-Logik (ena 1 + curr)", async () => {
    const { ChargingStrategyController } = await import("../strategy/charging-strategy-controller");
    const { RealPhaseProvider } = await import("../strategy/phase-provider");
    const sendUdp = vi.fn(async (_ip: string, command: string) => {
      if (command === "report 2") {
        return { ID: 2, State: 2, Plug: 7, "Enable sys": 0, "Curr user": 32000 };
      }
      if (command === "report 3") {
        return { ID: 3, P: 0, I1: 0, I2: 0, I3: 0, U1: 230, U2: 0, U3: 0 };
      }
      return { "TCH-OK": "done" };
    });

    const controller = new ChargingStrategyController(sendUdp, new RealPhaseProvider());
    mockChargingContext = {
      ...mockChargingContext,
      isActive: false,
      startDelayTrackerSince: new Date(Date.now() - 61_000).toISOString(),
      remainingStartDelay: 0,
    };

    await controller.processStrategy(
      makeLiveData({ pvPower: 6200, housePower: 1200, wallboxPower: 0, gridPower: -2500 }),
      DEFAULT_WALLBOX_IP,
    );

    const commands = sendUdp.mock.calls.map((call) => call[1]);
    expect(commands).toContain("ena 1");
    expect(commands.some((cmd: string) => cmd.startsWith("curr "))).toBe(true);
  });

  it("13) Smart Buffer stoppt Wallbox bei zu wenig Überschuss (ena 0)", async () => {
    const { ChargingStrategyController } = await import("../strategy/charging-strategy-controller");
    const { RealPhaseProvider } = await import("../strategy/phase-provider");
    const sendUdp = vi.fn(async (_ip: string, command: string) => {
      if (command === "report 2") {
        return { ID: 2, State: 3, Plug: 7, "Enable sys": 1, "Curr user": 8000 };
      }
      if (command === "report 3") {
        return { ID: 3, P: 1800000, I1: 8000, I2: 0, I3: 0, U1: 230, U2: 0, U3: 0 };
      }
      return { "TCH-OK": "done" };
    });

    const controller = new ChargingStrategyController(sendUdp, new RealPhaseProvider());
    mockChargingContext = {
      ...mockChargingContext,
      isActive: true,
      currentAmpere: 8,
      targetAmpere: 8,
      currentPhases: 1,
      belowThresholdSince: new Date(Date.now() - 120_000).toISOString(),
      lastStartedAt: new Date(Date.now() - 120_000).toISOString(),
    };

    await controller.processStrategy(
      makeLiveData({ pvPower: 1200, housePower: 3000, wallboxPower: 1800, gridPower: 900 }),
      DEFAULT_WALLBOX_IP,
    );

    const commands = sendUdp.mock.calls.map((call) => call[1]);
    expect(commands).toContain("ena 0");
  });
});

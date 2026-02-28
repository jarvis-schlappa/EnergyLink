/**
 * Bug-Reproduktions-Tests: Wallbox-Ladeleistung aktualisiert sich nicht live
 *
 * Problem: Wenn die Überschuss-Ladestrategie die Wallbox startet, wird
 * `power` nie über SSE-Partial-Events gesendet. Der Client sieht 0 kW
 * bis ein voller Status-Event kommt (was selten passiert).
 *
 * Diese Tests verifizieren:
 * 1. E-pres-Events während Ladung lösen keinen vollen Status aus (Bug-Nachweis)
 * 2. Nach dem Fix: Periodischer voller Status während Ladung
 */

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
let mockPlugTracking: any = {};

vi.mock("../core/storage", () => ({
  storage: {
    getSettings: vi.fn(() => mockSettings),
    saveSettings: vi.fn((s: any) => { mockSettings = s; }),
    getChargingContext: vi.fn(() => mockChargingContext),
    saveChargingContext: vi.fn((c: any) => { mockChargingContext = c; }),
    getControlState: vi.fn(() => ({ nightCharging: false, batteryLock: false })),
    saveControlState: vi.fn(),
    getPlugStatusTracking: vi.fn(() => mockPlugTracking),
    savePlugStatusTracking: vi.fn((t: any) => { mockPlugTracking = t; }),
  },
}));

vi.mock("../wallbox/udp-channel", () => ({
  wallboxUdpChannel: {
    onBroadcast: vi.fn(),
    offBroadcast: vi.fn(),
  },
}));

vi.mock("../routes/shared-state", () => ({
  getOrCreateStrategyController: vi.fn(() => ({
    handleStrategyChange: vi.fn().mockResolvedValue(undefined),
    activateMaxPowerImmediately: vi.fn().mockResolvedValue(undefined),
    stopChargingOnly: vi.fn().mockResolvedValue(undefined),
    startEventListener: vi.fn(),
    stopEventListener: vi.fn(),
    stopChargingForStrategyOff: vi.fn(),
  })),
}));

vi.mock("../monitoring/prowl-notifier", () => ({
  getProwlNotifier: vi.fn(() => ({
    sendPlugConnected: vi.fn(),
    sendPlugDisconnected: vi.fn(),
  })),
  triggerProwlEvent: vi.fn(),
}));

const mockBroadcastWallboxStatus = vi.fn();
const mockBroadcastPartialUpdate = vi.fn();
vi.mock("../wallbox/sse", () => ({
  broadcastWallboxStatus: (...args: any[]) => mockBroadcastWallboxStatus(...args),
  broadcastPartialUpdate: (...args: any[]) => mockBroadcastPartialUpdate(...args),
}));

vi.mock("../e3dc/poller", () => ({
  resetWallboxIdleThrottle: vi.fn(),
}));

vi.mock("../routes/wallbox-routes", () => ({
  resetStatusPollThrottle: vi.fn(),
}));

vi.mock("../wallbox/cache-invalidation", () => ({
  invalidateWallboxCaches: vi.fn(),
}));

vi.mock("../routes/garage-routes", () => ({
  autoCloseGarageIfNeeded: vi.fn().mockResolvedValue(undefined),
}));

describe("Bug: Wallbox-Ladeleistung aktualisiert sich nicht live", () => {
  let broadcastHandler: (data: any, rinfo: any) => Promise<void>;
  const fakeRinfo = { address: "192.168.40.16", port: 7090, family: "IPv4", size: 0 };

  // UDP-Sender simuliert eine Wallbox die mit power=3.68kW lädt
  const mockUdpSender = vi.fn().mockImplementation(async (_ip: string, cmd: string) => {
    if (cmd === "report 1") return { Product: "KC-P20", Serial: "12345" };
    if (cmd === "report 2") return { State: 3, Plug: 7, Input: 0, "Enable sys": 1, "Max curr": 16000 };
    if (cmd === "report 3") return { "E pres": 50000, "E total": 1000000, P: 3680000, I1: 16000, I2: 0, I3: 0 };
    return {};
  });

  beforeEach(async () => {
    vi.clearAllMocks();
    vi.resetModules();
    mockSettings = {
      wallboxIp: "192.168.40.16",
      chargingStrategy: { activeStrategy: "surplus_solar", inputX1Strategy: "max_without_battery" },
      prowl: { enabled: false },
    };
    mockChargingContext = { strategy: "surplus_solar", isActive: true, currentAmpere: 16 };
    mockPlugTracking = {};

    const { wallboxUdpChannel } = await import("../wallbox/udp-channel");
    const mod = await import("../wallbox/broadcast-listener");
    await mod.startBroadcastListener(mockUdpSender);
    broadcastHandler = (wallboxUdpChannel.onBroadcast as any).mock.calls[0][0];
  });

  afterEach(async () => {
    const mod = await import("../wallbox/broadcast-listener");
    await mod.stopBroadcastListener();
  });

  describe("Bug-Nachweis: power fehlt in SSE-Events während Ladung", () => {
    it("E-pres-Events während Ladung lösen vollen Status-Broadcast mit power aus", async () => {
      // Initiale State/Plug-Broadcasts für den Listener
      await broadcastHandler({ State: 3 }, fakeRinfo); // initial sync
      await broadcastHandler({ Plug: 7 }, fakeRinfo);  // initial sync

      mockBroadcastPartialUpdate.mockClear();
      mockBroadcastWallboxStatus.mockClear();

      // Simuliere 5 E-pres-Events während aktiver Ladung (wie im Realbetrieb alle 1-2s)
      for (let i = 0; i < 5; i++) {
        await broadcastHandler({ "E pres": 50000 + i * 100 }, fakeRinfo);
      }

      // fetchAndBroadcastStatus wird mit `void` aufgerufen (fire-and-forget)
      // → Warte auf Micro-Tasks damit der async-Aufruf abgeschlossen wird
      await new Promise((r) => setTimeout(r, 10));

      // ERWARTUNG (nach Fix): Mindestens ein voller Status-Broadcast mit power
      // sollte während der E-pres-Events gesendet werden
      const fullStatusCalls = mockBroadcastWallboxStatus.mock.calls;
      expect(fullStatusCalls.length).toBeGreaterThan(0);

      // Prüfe dass mindestens ein Event power > 0 enthält
      const hasPowerUpdate = fullStatusCalls.some(
        (call: any[]) => call[0]?.power > 0
      );
      expect(hasPowerUpdate).toBe(true);
    });

    it("nach 10+ E-pres-Events kommt mindestens ein voller Status mit power", async () => {
      // Initiale Syncs
      await broadcastHandler({ State: 3 }, fakeRinfo);
      await broadcastHandler({ Plug: 7 }, fakeRinfo);

      mockBroadcastWallboxStatus.mockClear();

      // Simuliere 15 E-pres-Events (ca. 15-30s Echtzeit)
      for (let i = 0; i < 15; i++) {
        await broadcastHandler({ "E pres": 50000 + i * 100 }, fakeRinfo);
      }

      // Warte auf fire-and-forget async calls
      await new Promise((r) => setTimeout(r, 10));

      // Nach dem Fix: Es muss mindestens ein broadcastWallboxStatus mit power gekommen sein
      const fullStatusCalls = mockBroadcastWallboxStatus.mock.calls;
      expect(fullStatusCalls.length).toBeGreaterThan(0);
    });
  });
});

/**
 * Bug Reproduction Tests: AutoClose Cooldown & Plug-Status Flicker
 *
 * Bug Report: docs/bug-report-2026-02-26-test3.md
 *
 * Bug 1: Manueller Garage-Toggle blockiert AutoClose durch gemeinsamen Cooldown.
 *   Workflow: Garage manuell öffnen → Kabel einstecken (<60s) → AutoClose wird blockiert.
 *   Ursache: `lastToggleTime` wird von manuellem Toggle UND AutoClose geschrieben/gelesen.
 *
 * Bug 2: Plug-Status-Flicker in der UI nach Kabel einstecken.
 *   broadcastPartialUpdate({ state }) sendet kein `plug`-Feld → Frontend könnte Plug auf Default setzen.
 *
 * Mock analysis (Issue #45):
 *   HARDWARE/EXTERNAL (must be mocked - no real devices in tests):
 *     global.fetch            → HTTP calls to FHEM hardware (garage status/toggle)
 *     wallbox/udp-channel     → UDP broadcast from physical wallbox (integration section)
 *     routes/shared-state     → getOrCreateStrategyController pulls in all hardware deps
 *     monitoring/prowl-notifier → External push notification service
 *     wallbox/sse             → SSE broadcast (side effects)
 *     e3dc/poller             → Background polling scheduler
 *     routes/wallbox-routes   → Depends on UDP transport
 *
 *   INTERNAL (mocked for justified reasons - reviewed Issue #45):
 *     core/storage      → MemStorage constructor performs file I/O
 *                          (readFileSync, writeFileSync, mkdirSync).
 *                          No pure in-memory mode available without DI refactor.
 *                          Integration section uses vi.doMock for isolated state.
 *     core/logger       → Suppress console spam in test output
 *
 *   LOCAL TEST DOUBLES (not module mocks, standard test practice):
 *     mockApp (Express app)   → Captures registered route handlers
 *     mockRes (Express response) → Captures HTTP response
 *     These are local vi.fn() objects, not vi.mock() module replacements.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// --- Mocks ---

const mockFetch = vi.fn();
global.fetch = mockFetch;

const mockStorage = {
  getSettings: vi.fn(),
  getPlugStatusTracking: vi.fn().mockReturnValue({}),
  savePlugStatusTracking: vi.fn(),
};

vi.mock("../core/storage", () => ({
  storage: mockStorage,
}));

vi.mock("../core/logger", () => ({
  log: () => {},
}));

// ===================================================================
// Bug 1: AutoClose blockiert durch manuellen Cooldown
// ===================================================================

describe("Bug 1: AutoClose blocked by manual toggle cooldown", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
    vi.useFakeTimers();
    mockFetch.mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  /**
   * Reproduziert den exakten Ablauf aus dem Bug-Report:
   * 13:00:14 – Manueller Toggle (Öffnen)
   * 13:01:10 – Kabel eingesteckt → autoCloseGarageIfNeeded() aufgerufen (56s nach manuellem Toggle)
   *
   * Erwartet: AutoClose SOLLTE feuern (Garage ist offen, Kabel eingesteckt)
   * Aktuell: AutoClose wird übersprungen weil lastToggleTime < 60s her ist
   */
  it("should auto-close garage after manual open + cable plug-in within 60s (FAILS: shared cooldown)", async () => {
    mockStorage.getSettings.mockReturnValue({
      fhemSync: { host: "192.168.40.11", autoCloseGarageOnPlug: true },
    });

    const { registerGarageRoutes, autoCloseGarageIfNeeded } = await import(
      "../routes/garage-routes"
    );

    const mockApp = {
      get: vi.fn(),
      post: vi.fn(),
    };
    registerGarageRoutes(mockApp as any);

    const toggleRoute = mockApp.post.mock.calls.find(
      (call: any[]) => call[0] === "/api/garage/toggle"
    );
    expect(toggleRoute).toBeDefined();
    const toggleHandler = toggleRoute![1];

    const mockRes = {
      status: vi.fn().mockReturnThis(),
      json: vi.fn(),
    };

    mockFetch.mockResolvedValueOnce({ ok: true });

    await toggleHandler({}, mockRes);
    expect(mockRes.json).toHaveBeenCalledWith({ success: true });

    vi.advanceTimersByTime(56_000);

    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        Results: [
          {
            Readings: {
              state: { Value: "open", Time: "2026-02-26T13:00:14" },
            },
          },
        ],
      }),
    });
    mockFetch.mockResolvedValueOnce({ ok: true });

    await autoCloseGarageIfNeeded();

    const fetchCallsAfterToggle = mockFetch.mock.calls.length - 1;
    expect(fetchCallsAfterToggle).toBe(2);
  });

  it("auto-close works when >60s have passed since manual toggle", async () => {
    mockStorage.getSettings.mockReturnValue({
      fhemSync: { host: "192.168.40.11", autoCloseGarageOnPlug: true },
    });

    const { registerGarageRoutes, autoCloseGarageIfNeeded } = await import(
      "../routes/garage-routes"
    );

    const mockApp = { get: vi.fn(), post: vi.fn() };
    registerGarageRoutes(mockApp as any);
    const toggleHandler = mockApp.post.mock.calls.find(
      (call: any[]) => call[0] === "/api/garage/toggle"
    )![1];

    mockFetch.mockResolvedValueOnce({ ok: true });
    await toggleHandler({}, { status: vi.fn().mockReturnThis(), json: vi.fn() });

    vi.advanceTimersByTime(61_000);

    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        Results: [
          {
            Readings: {
              state: { Value: "open", Time: "2026-02-26T13:00:14" },
            },
          },
        ],
      }),
    });
    mockFetch.mockResolvedValueOnce({ ok: true });

    await autoCloseGarageIfNeeded();

    const fetchCallsAfterToggle = mockFetch.mock.calls.length - 1;
    expect(fetchCallsAfterToggle).toBe(2);
  });

  it("auto-close has its own cooldown preventing rapid re-trigger", async () => {
    mockStorage.getSettings.mockReturnValue({
      fhemSync: { host: "192.168.40.11", autoCloseGarageOnPlug: true },
    });

    const { autoCloseGarageIfNeeded } = await import("../routes/garage-routes");

    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        Results: [
          {
            Readings: { state: { Value: "open", Time: "2026-02-26T13:00:00" } },
          },
        ],
      }),
    });
    mockFetch.mockResolvedValueOnce({ ok: true });

    await autoCloseGarageIfNeeded();
    expect(mockFetch).toHaveBeenCalledTimes(2);

    vi.advanceTimersByTime(30_000);
    mockFetch.mockClear();

    await autoCloseGarageIfNeeded();
    expect(mockFetch).toHaveBeenCalledTimes(0);
  });
});

// ===================================================================
// Bug 2: Plug-Status Flicker in der UI
// ===================================================================

describe("Bug 2: Plug-Status flicker from partial SSE updates", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
  });

  it("broadcastPartialUpdate for state change does NOT include plug value", async () => {
    const { broadcastPartialUpdate, initSSEClient } = await import(
      "../wallbox/sse"
    );

    const writtenData: string[] = [];
    const mockRes = {
      setHeader: vi.fn(),
      write: vi.fn((data: string) => writtenData.push(data)),
      on: vi.fn(),
      end: vi.fn(),
    };
    initSSEClient(mockRes as any);

    broadcastPartialUpdate({ state: 3 });

    const dataEvents = writtenData.filter((d) => d.startsWith("data:"));
    expect(dataEvents).toHaveLength(1);

    const parsed = JSON.parse(dataEvents[0].replace("data: ", "").trim());
    expect(parsed.type).toBe("wallbox-partial");
    expect(parsed.data.state).toBe(3);
    expect(parsed.data.plug).toBeUndefined();
  });

  it("demonstrates the flicker scenario: plug broadcast → state broadcast → wrong plug in UI", async () => {
    let frontendState: Record<string, any> = {
      state: 2,
      plug: 3,
      power: 0,
      lastUpdated: "",
    };

    function handleSSE(event: { type: string; data: Record<string, any> }) {
      if (event.type === "wallbox-status") {
        frontendState = { ...frontendState, ...event.data };
      } else if (event.type === "wallbox-partial") {
        frontendState = { ...frontendState, ...event.data };
      }
    }

    handleSSE({
      type: "wallbox-status",
      data: { state: 2, plug: 7, power: 0, lastUpdated: "2026-02-26T13:01:10" },
    });
    expect(frontendState.plug).toBe(7);

    handleSSE({
      type: "wallbox-partial",
      data: { state: 3, lastUpdated: "2026-02-26T13:01:11" },
    });
    expect(frontendState.plug).toBe(7);

    const brokenMerge = {
      state: 0, plug: 0, power: 0, lastUpdated: "",
      ...{ state: 3, lastUpdated: "2026-02-26T13:01:11" },
    };
    expect(brokenMerge.plug).toBe(0);
  });
});

// ===================================================================
// Integration: Broadcast-Listener → AutoClose Timing
// ===================================================================

describe("Integration: Broadcast-Listener triggers autoClose with correct timing", () => {
  let broadcastHandler: (data: any, rinfo: any) => Promise<void>;
  const fakeRinfo = {
    address: "192.168.40.16",
    port: 7090,
    family: "IPv4",
    size: 0,
  };
  const mockUdpSender = vi.fn().mockResolvedValue({});

  const mockOnBroadcast = vi.fn();

  let mockSettings: any;
  let mockChargingContext: any;
  let mockPlugTracking: any;

  beforeEach(async () => {
    vi.clearAllMocks();
    vi.resetModules();
    vi.useFakeTimers();
    mockFetch.mockReset();

    mockSettings = {
      wallboxIp: "192.168.40.16",
      fhemSync: { host: "192.168.40.11", autoCloseGarageOnPlug: true },
      chargingStrategy: {
        activeStrategy: "off",
        inputX1Strategy: "max_without_battery",
      },
      prowl: { enabled: false },
    };
    mockChargingContext = {
      strategy: "off",
      isActive: false,
      currentAmpere: 0,
    };
    mockPlugTracking = {};

    // Storage mock: vi.fn() needed because broadcast-listener reads/writes state
    vi.doMock("../core/storage", () => ({
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

    // UDP channel: mockOnBroadcast is asserted (captures the handler)
    vi.doMock("../wallbox/udp-channel", () => ({
      wallboxUdpChannel: {
        onBroadcast: mockOnBroadcast,
        offBroadcast: () => {},
      },
    }));

    // Hardware/external stubs (no-op, never asserted)
    vi.doMock("../routes/shared-state", () => ({
      getOrCreateStrategyController: () => ({
        handleStrategyChange: () => Promise.resolve(),
        activateMaxPowerImmediately: () => Promise.resolve(),
        stopChargingOnly: () => Promise.resolve(),
        startEventListener: () => {},
        stopEventListener: () => {},
        stopChargingForStrategyOff: () => {},
      }),
    }));

    vi.doMock("../monitoring/prowl-notifier", () => ({
      getProwlNotifier: () => ({
        sendPlugConnected: () => {},
        sendPlugDisconnected: () => {},
      }),
      triggerProwlEvent: () => {},
    }));

    vi.doMock("../wallbox/sse", () => ({
      broadcastWallboxStatus: () => {},
      broadcastPartialUpdate: () => {},
    }));

    vi.doMock("../e3dc/poller", () => ({
      resetWallboxIdleThrottle: () => {},
    }));

    vi.doMock("../routes/wallbox-routes", () => ({
      resetStatusPollThrottle: () => {},
    }));

    const blMod = await import("../wallbox/broadcast-listener");
    await blMod.startBroadcastListener(mockUdpSender);
    broadcastHandler = mockOnBroadcast.mock.calls[0][0];
  });

  afterEach(async () => {
    vi.useRealTimers();
    const blMod = await import("../wallbox/broadcast-listener");
    await blMod.stopBroadcastListener();
  });

  it("broadcast-listener calls autoClose on plug transition 3→7", async () => {
    await broadcastHandler({ Plug: 3 }, fakeRinfo);

    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        Results: [
          {
            Readings: {
              state: { Value: "open", Time: "2026-02-26T13:01:10" },
            },
          },
        ],
      }),
    });
    mockFetch.mockResolvedValueOnce({ ok: true });

    await broadcastHandler({ Plug: 7 }, fakeRinfo);
    await vi.advanceTimersByTimeAsync(100);

    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it("broadcast-listener does NOT call autoClose on plug transition 5→7 (already ≥5)", async () => {
    await broadcastHandler({ Plug: 5 }, fakeRinfo);
    mockFetch.mockClear();

    await broadcastHandler({ Plug: 7 }, fakeRinfo);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("broadcast-listener does NOT call autoClose on plug transition 7→3 (disconnecting)", async () => {
    await broadcastHandler({ Plug: 7 }, fakeRinfo);
    mockFetch.mockClear();

    await broadcastHandler({ Plug: 3 }, fakeRinfo);
    expect(mockFetch).not.toHaveBeenCalled();
  });
});

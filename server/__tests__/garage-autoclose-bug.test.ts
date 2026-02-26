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
  log: vi.fn(),
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

    // Simuliere manuellen Toggle (Garage öffnen)
    // Wir brauchen den Express-Route-Handler – simulieren wir den direkten Aufruf.
    // Der Toggle-Endpunkt setzt `lastToggleTime = Date.now()`.
    // Dafür nutzen wir den HTTP-Endpoint-Aufruf über einen Mock-Express.
    const mockApp = {
      get: vi.fn(),
      post: vi.fn(),
    };
    registerGarageRoutes(mockApp as any);

    // Finde den POST /api/garage/toggle Handler
    const toggleRoute = mockApp.post.mock.calls.find(
      (call: any[]) => call[0] === "/api/garage/toggle"
    );
    expect(toggleRoute).toBeDefined();
    const toggleHandler = toggleRoute![1];

    // Mock Request/Response für den manuellen Toggle
    const mockReq = {};
    const mockRes = {
      status: vi.fn().mockReturnThis(),
      json: vi.fn(),
    };

    // FHEM antwortet OK auf den Toggle
    mockFetch.mockResolvedValueOnce({ ok: true });

    // Führe manuellen Toggle aus (Garage öffnen)
    await toggleHandler(mockReq, mockRes);
    expect(mockRes.json).toHaveBeenCalledWith({ success: true });

    // 56 Sekunden vergehen (wie im Bug-Report)
    vi.advanceTimersByTime(56_000);

    // Jetzt wird Kabel eingesteckt → autoCloseGarageIfNeeded() wird aufgerufen
    // FHEM sagt: Garage ist offen
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
    // Erwarte: Toggle-Befehl an FHEM (AutoClose)
    mockFetch.mockResolvedValueOnce({ ok: true });

    await autoCloseGarageIfNeeded();

    // BUG: AutoClose sollte getGarageStatus + toggleGarage aufgerufen haben (2 fetch-calls)
    // Aber wegen des gemeinsamen Cooldowns wird es übersprungen (0 neue fetch-calls)
    const fetchCallsAfterToggle = mockFetch.mock.calls.length - 1; // minus den manuellen Toggle
    
    // Dieser Test DOKUMENTIERT den Bug: er sollte 2 sein (getStatus + toggle),
    // ist aber 0 weil der Cooldown aktiv ist.
    // Wenn der Fix implementiert ist, wird dieser Test grün.
    expect(fetchCallsAfterToggle).toBe(2); // getGarageStatus + toggleGarage
  });

  /**
   * Gegenprobe: AutoClose funktioniert wenn genug Zeit seit dem manuellen Toggle vergangen ist (>60s)
   */
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

    // Manueller Toggle
    mockFetch.mockResolvedValueOnce({ ok: true });
    await toggleHandler({}, { status: vi.fn().mockReturnThis(), json: vi.fn() });

    // 61 Sekunden warten (> 60s Cooldown)
    vi.advanceTimersByTime(61_000);

    // AutoClose: Garage ist offen
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
    mockFetch.mockResolvedValueOnce({ ok: true }); // toggleGarage

    await autoCloseGarageIfNeeded();

    // Sollte funktionieren: 2 calls (getStatus + toggle)
    const fetchCallsAfterToggle = mockFetch.mock.calls.length - 1;
    expect(fetchCallsAfterToggle).toBe(2);
  });

  /**
   * AutoClose-eigener Cooldown: Zwei AutoClose-Events hintereinander sollten geblockt werden.
   */
  it("auto-close has its own cooldown preventing rapid re-trigger", async () => {
    mockStorage.getSettings.mockReturnValue({
      fhemSync: { host: "192.168.40.11", autoCloseGarageOnPlug: true },
    });

    const { autoCloseGarageIfNeeded } = await import("../routes/garage-routes");

    // Erstes AutoClose: Garage offen → Toggle
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

    // 30 Sekunden später: Zweites AutoClose sollte blockiert werden
    vi.advanceTimersByTime(30_000);
    mockFetch.mockClear();

    await autoCloseGarageIfNeeded();

    // Sollte 0 Calls haben (Cooldown aktiv)
    expect(mockFetch).toHaveBeenCalledTimes(0);
  });
});

// ===================================================================
// Bug 2: Plug-Status Flicker in der UI
// ===================================================================

describe("Bug 2: Plug-Status flicker from partial SSE updates", () => {
  /**
   * broadcastPartialUpdate wird bei State-Änderungen aufgerufen:
   *   broadcastPartialUpdate({ state })
   *
   * Das sendet ein SSE-Event vom Typ "wallbox-partial" mit nur dem state-Feld.
   * Wenn das Frontend das partial-Update mit dem vorherigen Vollstatus mergt
   * und dabei fehlende Felder auf Defaults setzt, wird plug=0 (getrennt) angezeigt.
   */
  beforeEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
  });

  it("broadcastPartialUpdate for state change does NOT include plug value", async () => {
    // Importiere SSE-Modul direkt um das Verhalten zu verifizieren
    const { broadcastPartialUpdate, initSSEClient } = await import(
      "../wallbox/sse"
    );

    // Simuliere einen verbundenen SSE-Client
    const writtenData: string[] = [];
    const mockRes = {
      setHeader: vi.fn(),
      write: vi.fn((data: string) => writtenData.push(data)),
      on: vi.fn(),
      end: vi.fn(),
    };
    initSSEClient(mockRes as any);

    // State-Änderung broadcasten (wie im broadcast-listener.ts)
    broadcastPartialUpdate({ state: 3 });

    // Finde das SSE-data-Event (nicht den :ok Ping)
    const dataEvents = writtenData.filter((d) => d.startsWith("data:"));
    expect(dataEvents).toHaveLength(1);

    const parsed = JSON.parse(dataEvents[0].replace("data: ", "").trim());
    expect(parsed.type).toBe("wallbox-partial");

    // BUG-NACHWEIS: Das partial-Update enthält KEIN plug-Feld.
    // Ein naives Frontend-Merge (Object.assign oder spread) mit Default plug=0
    // würde den Plug-Status fälschlich auf 0 ("getrennt") setzen.
    expect(parsed.data.state).toBe(3);
    expect(parsed.data.plug).toBeUndefined();
    // Das ist der Kern des Problems: state-Updates tragen keinen plug-Wert mit.
  });

  it("demonstrates the flicker scenario: plug broadcast → state broadcast → wrong plug in UI", async () => {
    /**
     * Szenario aus dem Bug-Report:
     * 1. Broadcast: Plug=7 (Kabel eingesteckt) → SSE mit vollständigem Status
     * 2. Broadcast: State=3 (Laden) → SSE mit partiellem Status (NUR state, KEIN plug)
     * 3. Frontend mergt partial → wenn es plug auf Default setzt → kurz plug=0 angezeigt
     * 4. Nächster voller Poll → plug=7 wieder korrekt
     *
     * Dieser Test simuliert die Frontend-Perspektive.
     */

    // Simuliere den Frontend-State-Manager
    let frontendState: Record<string, any> = {
      state: 2,
      plug: 3, // getrennt
      power: 0,
      lastUpdated: "",
    };

    // Simulated SSE event handler (naiver Merge – so wie es ein typisches Frontend macht)
    function handleSSE(event: { type: string; data: Record<string, any> }) {
      if (event.type === "wallbox-status") {
        // Vollständiger Status → alles überschreiben
        frontendState = { ...frontendState, ...event.data };
      } else if (event.type === "wallbox-partial") {
        // Partieller Status → nur vorhandene Felder mergen
        frontendState = { ...frontendState, ...event.data };
      }
    }

    // Schritt 1: Vollständiger Status via SSE (nach Plug-Broadcast → fetchAndBroadcastStatus)
    handleSSE({
      type: "wallbox-status",
      data: {
        state: 2,
        plug: 7, // Kabel eingesteckt!
        power: 0,
        lastUpdated: "2026-02-26T13:01:10",
      },
    });
    expect(frontendState.plug).toBe(7); // ✅ Korrekt

    // Schritt 2: State-Änderung (Wallbox beginnt zu laden) → broadcastPartialUpdate({ state: 3 })
    // Dieses Event kommt VOR dem vollständigen fetchAndBroadcastStatus für den State
    handleSSE({
      type: "wallbox-partial",
      data: {
        state: 3,
        lastUpdated: "2026-02-26T13:01:11",
      },
    });

    // Nach partiellem Update: plug sollte IMMER NOCH 7 sein
    // Mit korrektem Object.assign/spread bleibt plug=7 erhalten, weil data.plug === undefined
    expect(frontendState.plug).toBe(7); // ✅ spread preserviert fehlende Keys

    // ABER: Wenn das Frontend stattdessen den gesamten Status ersetzt ODER
    // ein Default-Objekt verwendet { state: 0, plug: 0, ... }, dann:
    const brokenMerge = {
      state: 0,
      plug: 0,
      power: 0,
      lastUpdated: "",
      // spread mit partial-data (hat kein plug-Feld → plug bleibt 0!)
      ...{ state: 3, lastUpdated: "2026-02-26T13:01:11" },
    };
    expect(brokenMerge.plug).toBe(0); // 🐛 BUG: Plug fällt auf 0 zurück!

    // Die Lösung: Partial-Updates sollten ENTWEDER:
    // a) Immer den aktuellen plug-Wert mitsenden (Server-seitig), ODER
    // b) Das Frontend muss partial-Updates korrekt mergen (nur vorhandene Keys überschreiben)
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

  // Separate mocks for the full integration scenario
  const mockOnBroadcast = vi.fn();
  const mockOffBroadcast = vi.fn();

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

    // Re-mock modules for integration test
    vi.doMock("../core/storage", () => ({
      storage: {
        getSettings: vi.fn(() => mockSettings),
        saveSettings: vi.fn((s: any) => {
          mockSettings = s;
        }),
        getChargingContext: vi.fn(() => mockChargingContext),
        saveChargingContext: vi.fn((c: any) => {
          mockChargingContext = c;
        }),
        getControlState: vi.fn(() => ({ nightCharging: false, batteryLock: false })),
        saveControlState: vi.fn(),
        getPlugStatusTracking: vi.fn(() => mockPlugTracking),
        savePlugStatusTracking: vi.fn((t: any) => {
          mockPlugTracking = t;
        }),
      },
    }));

    vi.doMock("../wallbox/udp-channel", () => ({
      wallboxUdpChannel: {
        onBroadcast: mockOnBroadcast,
        offBroadcast: mockOffBroadcast,
      },
    }));

    vi.doMock("../routes/shared-state", () => ({
      getOrCreateStrategyController: vi.fn(() => ({
        handleStrategyChange: vi.fn().mockResolvedValue(undefined),
        activateMaxPowerImmediately: vi.fn().mockResolvedValue(undefined),
        stopChargingOnly: vi.fn().mockResolvedValue(undefined),
        startEventListener: vi.fn(),
        stopEventListener: vi.fn(),
        stopChargingForStrategyOff: vi.fn(),
      })),
    }));

    vi.doMock("../monitoring/prowl-notifier", () => ({
      getProwlNotifier: vi.fn(() => ({
        sendPlugConnected: vi.fn(),
        sendPlugDisconnected: vi.fn(),
      })),
      triggerProwlEvent: vi.fn(),
    }));

    vi.doMock("../wallbox/sse", () => ({
      broadcastWallboxStatus: vi.fn(),
      broadcastPartialUpdate: vi.fn(),
    }));

    vi.doMock("../e3dc/poller", () => ({
      resetWallboxIdleThrottle: vi.fn(),
    }));

    vi.doMock("../routes/wallbox-routes", () => ({
      resetStatusPollThrottle: vi.fn(),
    }));

    // Import fresh modules
    const blMod = await import("../wallbox/broadcast-listener");
    await blMod.startBroadcastListener(mockUdpSender);
    broadcastHandler = mockOnBroadcast.mock.calls[0][0];
  });

  afterEach(async () => {
    vi.useRealTimers();
    const blMod = await import("../wallbox/broadcast-listener");
    await blMod.stopBroadcastListener();
  });

  /**
   * End-to-End-Szenario aus dem Bug-Report:
   * 1. User öffnet Garage manuell (über UI/Toggle-Route)
   * 2. 34s später: Kabel abgesteckt (Plug 7→3)
   * 3. Weitere 34s: Kabel eingesteckt (Plug 3→7)
   * 4. AutoClose sollte feuern → tut es aber nicht (Cooldown vom manuellen Toggle)
   *
   * Hinweis: Der Broadcast-Listener ruft autoCloseGarageIfNeeded() aus garage-routes.ts auf.
   * Dort sitzt der gemeinsame Cooldown. In diesem Test prüfen wir, ob der Broadcast-Listener
   * korrekt autoCloseGarageIfNeeded() aufruft bei Plug <5 → ≥5 Transition.
   */
  it("broadcast-listener calls autoClose on plug transition 3→7", async () => {
    // Initialisiere Plug-Status
    await broadcastHandler({ Plug: 3 }, fakeRinfo); // initial (Kabel ohne Auto)

    // FHEM: Garage ist offen (für den autoClose-Check)
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
    mockFetch.mockResolvedValueOnce({ ok: true }); // toggleGarage

    // Plug 3→7 (Auto angesteckt)
    await broadcastHandler({ Plug: 7 }, fakeRinfo);

    // autoCloseGarageIfNeeded wird async (.catch(() => {})) aufgerufen im Broadcast-Listener.
    // Wir müssen der Micro-Task-Queue Zeit geben, die Promise abzuarbeiten.
    await vi.advanceTimersByTimeAsync(100);

    // autoCloseGarageIfNeeded sollte aufgerufen worden sein → fetch für getGarageStatus + toggleGarage
    // Ohne vorherigen manuellen Toggle: sollte 2 Calls sein.
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it("broadcast-listener does NOT call autoClose on plug transition 5→7 (already ≥5)", async () => {
    // Plug=5 → Plug=7: Beide ≥5 → kein AutoClose-Trigger
    await broadcastHandler({ Plug: 5 }, fakeRinfo); // initial
    mockFetch.mockClear();

    await broadcastHandler({ Plug: 7 }, fakeRinfo);

    // Kein autoClose weil Transition nicht von <5 auf ≥5 ist
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("broadcast-listener does NOT call autoClose on plug transition 7→3 (disconnecting)", async () => {
    // Plug=7 → Plug=3: Abgesteckt → kein AutoClose
    await broadcastHandler({ Plug: 7 }, fakeRinfo); // initial
    mockFetch.mockClear();

    await broadcastHandler({ Plug: 3 }, fakeRinfo);

    // Kein autoClose weil Richtung falsch (≥5 → <5)
    expect(mockFetch).not.toHaveBeenCalled();
  });
});

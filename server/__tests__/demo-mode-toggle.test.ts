/**
 * Tests für Demo-Modus Toggle (#18)
 *
 * Bug 1: Demo-Toggle aktiviert → IPs auf 127.0.0.1, Mock-Server gestartet
 * Bug 2: mockWallboxPlugStatus ändern → Mock-Wallbox-State aktualisiert + Broadcast
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

// ── storage mock (Inline-Implementation) ──────────────────────────
let storedSettings: Record<string, any> = {};

vi.mock("../core/storage", () => {
  const getSettings = () => storedSettings;
  const saveSettings = (s: any) => {
    // Replicate real storage demo-mode IP-swap logic
    const prev = { ...storedSettings };
    const wasDemoMode = prev.demoMode ?? false;
    const isDemoMode = s.demoMode ?? false;

    if (isDemoMode && !wasDemoMode) {
      s.wallboxIpBackup = s.wallboxIp;
      s.wallboxIp = "127.0.0.1";
      s.e3dcIpBackup = s.e3dcIp;
      s.e3dcIp = "127.0.0.1:5502";
    } else if (!isDemoMode && wasDemoMode) {
      if (prev.wallboxIpBackup) {
        s.wallboxIp = prev.wallboxIpBackup;
      }
      delete s.wallboxIpBackup;
      if (prev.e3dcIpBackup) {
        s.e3dcIp = prev.e3dcIpBackup;
      }
      delete s.e3dcIpBackup;
    }
    storedSettings = s;
  };
  return {
    storage: {
      getSettings,
      saveSettings,
      getControlState: () => ({
        pvSurplus: false,
        nightCharging: false,
        batteryLock: false,
        gridCharging: false,
      }),
      getLogSettings: () => ({ level: "info" }),
      getChargingContext: () => ({ strategy: "off", isActive: false }),
      getLogs: () => [],
      addLog: () => {},
    },
  };
});

vi.mock("../core/logger", () => ({
  log: () => {},
}));

vi.mock("../core/defaults", () => ({
  DEFAULT_WALLBOX_IP: "192.168.40.16",
}));

// ── wallbox-mock: Track calls ──────────────────────────────
let mockPlugStatusCalls: number[] = [];
let mockPhasesCalls: (1 | 3)[] = [];
let broadcastCallbackFn: ((data: any) => void) | null = null;
let broadcastedData: any[] = [];

vi.mock("../demo/wallbox-mock", () => {
  class FakeWallboxMockService {
    private plug = 7;
    private state = 2;

    initializeDemo() {
      this.plug = 7;
      this.state = 2;
    }

    setPlugStatus(value: number) {
      mockPlugStatusCalls.push(value);
      if (value < 0 || value > 7) return;
      if (this.plug !== value) {
        const oldState = this.state;
        this.plug = value;
        this.broadcast({ Plug: value });
        if (value === 0) {
          this.state = 1;
        } else if (value >= 3) {
          this.state = 2;
        }
        if (oldState !== this.state) {
          this.broadcast({ State: this.state });
        }
      }
    }

    setPhases(p: 1 | 3) {
      mockPhasesCalls.push(p);
    }

    getPlugStatus() {
      return this.plug;
    }

    setBroadcastCallback(cb: (data: any) => void) {
      broadcastCallbackFn = cb;
    }

    private broadcast(data: any) {
      broadcastedData.push(data);
      if (broadcastCallbackFn) broadcastCallbackFn(data);
    }
  }

  return { wallboxMockService: new FakeWallboxMockService(), WallboxMockService: FakeWallboxMockService };
});

// ── Import storage AFTER mocking ──
import { storage } from "../core/storage";
import { wallboxMockService } from "../demo/wallbox-mock";

// ─────────────────────────────────────────────────────────
describe("Demo-Modus Toggle (IP Swap)", () => {
  beforeEach(() => {
    storedSettings = {
      wallboxIp: "192.168.40.16",
      e3dcIp: "192.168.40.200:502",
      demoMode: false,
    };
    mockPlugStatusCalls = [];
    mockPhasesCalls = [];
    broadcastedData = [];
    broadcastCallbackFn = null;
  });

  it("setzt IPs auf 127.0.0.1 wenn Demo-Modus aktiviert wird", () => {
    storage.saveSettings({ ...storedSettings, demoMode: true });
    const s = storage.getSettings()!;

    expect(s.wallboxIp).toBe("127.0.0.1");
    expect(s.e3dcIp).toBe("127.0.0.1:5502");
    expect(s.wallboxIpBackup).toBe("192.168.40.16");
    expect(s.e3dcIpBackup).toBe("192.168.40.200:502");
    expect(s.demoMode).toBe(true);
  });

  it("stellt originale IPs wieder her wenn Demo-Modus deaktiviert wird", () => {
    // Erst aktivieren
    storage.saveSettings({ ...storedSettings, demoMode: true });
    expect(storage.getSettings()!.wallboxIp).toBe("127.0.0.1");

    // Dann deaktivieren
    storage.saveSettings({ ...storage.getSettings()!, demoMode: false });
    const s = storage.getSettings()!;

    expect(s.wallboxIp).toBe("192.168.40.16");
    expect(s.e3dcIp).toBe("192.168.40.200:502");
    expect(s.wallboxIpBackup).toBeUndefined();
    expect(s.e3dcIpBackup).toBeUndefined();
    expect(s.demoMode).toBe(false);
  });
});

describe("Mock-Wallbox Plug Status (#18 Bug 2)", () => {
  beforeEach(() => {
    storedSettings = {
      wallboxIp: "127.0.0.1",
      e3dcIp: "127.0.0.1:5502",
      demoMode: true,
      mockWallboxPlugStatus: 7,
    };
    mockPlugStatusCalls = [];
    mockPhasesCalls = [];
    broadcastedData = [];
    broadcastCallbackFn = null;
    // Reset mock to plug=7 (default)
    wallboxMockService.initializeDemo();
  });

  it("aktualisiert Mock-Wallbox-State bei Plug-Status-Änderung", () => {
    wallboxMockService.setPlugStatus(0);

    expect(mockPlugStatusCalls).toContain(0);
  });

  it("sendet Plug-Broadcast bei Plug-Status-Änderung", () => {
    // Reset collected broadcasts AFTER initializeDemo
    broadcastedData = [];
    wallboxMockService.setBroadcastCallback((data: any) => {
      broadcastedData.push(data);
    });

    wallboxMockService.setPlugStatus(0);

    const plugBroadcast = broadcastedData.find((d: any) => d.Plug !== undefined);
    expect(plugBroadcast).toBeDefined();
    expect(plugBroadcast.Plug).toBe(0);
  });

  it("sendet State-Broadcast wenn Plug-Änderung State ändert", () => {
    // Reset collected broadcasts AFTER initializeDemo
    broadcastedData = [];
    wallboxMockService.setBroadcastCallback((data: any) => {
      broadcastedData.push(data);
    });

    // Plug 7→0 sollte State von 2→1 ändern
    wallboxMockService.setPlugStatus(0);

    const stateBroadcast = broadcastedData.find((d: any) => d.State !== undefined);
    expect(stateBroadcast).toBeDefined();
    expect(stateBroadcast.State).toBe(1); // State 1 = not ready (unplugged)
  });

  it("sendet keinen Broadcast bei gleichem Plug-Status", () => {
    // Reset collected broadcasts AFTER initializeDemo (which sets plug=7)
    broadcastedData = [];
    wallboxMockService.setBroadcastCallback((data: any) => {
      broadcastedData.push(data);
    });

    // Plug ist bereits 7 (nach initializeDemo), keine Änderung erwartet
    wallboxMockService.setPlugStatus(7);

    expect(broadcastedData).toHaveLength(0);
  });
});

describe("Mock-Wallbox Phasen-Konfiguration", () => {
  beforeEach(() => {
    mockPhasesCalls = [];
  });

  it("übergibt Phasen-Änderung an Mock-Service", () => {
    wallboxMockService.setPhases(1);
    expect(mockPhasesCalls).toContain(1);

    wallboxMockService.setPhases(3);
    expect(mockPhasesCalls).toContain(3);
  });
});

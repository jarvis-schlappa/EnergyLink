import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

/**
 * Tests for FHEM E3DC Sync logic.
 * Tests validation, command formatting, sync flow, and scheduler lifecycle
 * without needing real FHEM/TCP connections.
 */

// Mock external I/O only
vi.mock("../core/logger", () => ({
  log: vi.fn(),
}));

const mockGetSettings = vi.fn();
vi.mock("../core/storage", () => ({
  storage: {
    getSettings: (...args: any[]) => mockGetSettings(...args),
  },
}));

const mockGetLastReadLiveData = vi.fn();
vi.mock("../e3dc/modbus", () => {
  const subscribers: Array<(data: any) => void> = [];
  return {
    getE3dcModbusService: vi.fn(() => ({
      getLastReadLiveData: () => mockGetLastReadLiveData(),
    })),
    getE3dcLiveDataHub: vi.fn(() => ({
      subscribe: vi.fn((cb: (data: any) => void) => {
        subscribers.push(cb);
        return () => {
          const idx = subscribers.indexOf(cb);
          if (idx >= 0) subscribers.splice(idx, 1);
        };
      }),
    })),
    __subscribers: subscribers,
  };
});

vi.mock("../e3dc/poller", () => ({
  getE3dcBackoffLevel: vi.fn(() => 0),
}));

// Mock net.Socket to avoid real TCP connections
vi.mock("net", () => {
  const EventEmitter = require("events");
  class MockSocket extends EventEmitter {
    bytesWritten = 0;
    connect(port: number, host: string) {
      // Simulate successful connection
      setTimeout(() => this.emit("connect"), 0);
    }
    write(data: string) {
      this.bytesWritten = Buffer.byteLength(data);
      return true; // buffer not full
    }
    end() {
      setTimeout(() => {
        this.emit("finish");
        this.emit("close");
      }, 0);
    }
    destroy() {
      this.emit("close");
    }
    once(event: string, cb: Function) {
      return super.once(event, cb);
    }
  }
  return { Socket: MockSocket };
});

// ── Pure Logic Tests (no module imports needed) ──────────────────────────

describe("FHEM E3DC Sync - Host Validation (Pure Logic)", () => {
  function validateFhemHost(host: string): void {
    if (!host || host.trim() === "") {
      throw new Error("FHEM Host ist nicht konfiguriert - bitte IP-Adresse in Settings angeben");
    }
  }

  it("accepts valid IP address", () => {
    expect(() => validateFhemHost("192.168.40.11")).not.toThrow();
  });

  it("accepts valid hostname", () => {
    expect(() => validateFhemHost("fhem.local")).not.toThrow();
  });

  it("rejects empty string", () => {
    expect(() => validateFhemHost("")).toThrow("FHEM Host ist nicht konfiguriert");
  });

  it("rejects whitespace-only string", () => {
    expect(() => validateFhemHost("   ")).toThrow("FHEM Host ist nicht konfiguriert");
  });
});

describe("FHEM E3DC Sync - Port Validation (Pure Logic)", () => {
  function validateFhemPort(port: number): void {
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      throw new Error(`Ungültiger FHEM Port: ${port}`);
    }
  }

  it("accepts port 7072 (default FHEM telnet)", () => {
    expect(() => validateFhemPort(7072)).not.toThrow();
  });

  it("accepts port 1 (minimum)", () => {
    expect(() => validateFhemPort(1)).not.toThrow();
  });

  it("accepts port 65535 (maximum)", () => {
    expect(() => validateFhemPort(65535)).not.toThrow();
  });

  it("rejects port 0", () => {
    expect(() => validateFhemPort(0)).toThrow("Ungültiger FHEM Port: 0");
  });

  it("rejects negative port", () => {
    expect(() => validateFhemPort(-1)).toThrow("Ungültiger FHEM Port: -1");
  });

  it("rejects port above 65535", () => {
    expect(() => validateFhemPort(70000)).toThrow("Ungültiger FHEM Port: 70000");
  });

  it("rejects float port", () => {
    expect(() => validateFhemPort(7072.5)).toThrow("Ungültiger FHEM Port: 7072.5");
  });

  it("rejects NaN", () => {
    expect(() => validateFhemPort(NaN)).toThrow("Ungültiger FHEM Port: NaN");
  });
});

describe("FHEM E3DC Sync - Command Formatting (Pure Logic)", () => {
  /**
   * Mirrors the FHEM command building logic from syncE3dcToFhem
   */
  function buildFhemCommands(liveData: {
    pvPower: number;
    housePower: number;
    batterySoc: number;
    gridPower: number;
    batteryPower: number;
  }): string {
    return [
      `setreading S10 sonne ${Math.round(liveData.pvPower)}`,
      `setreading S10 haus ${Math.round(liveData.housePower)}`,
      `setreading S10 soc ${Math.round(liveData.batterySoc)}`,
      `setreading S10 netz ${Math.round(liveData.gridPower)}`,
      `setreading S10 speicher ${Math.round(liveData.batteryPower)}`,
    ].join("\n");
  }

  it("formats typical solar production values", () => {
    const cmds = buildFhemCommands({
      pvPower: 5432,
      housePower: 1234,
      batterySoc: 85,
      gridPower: -3198,
      batteryPower: 1000,
    });

    expect(cmds).toContain("setreading S10 sonne 5432");
    expect(cmds).toContain("setreading S10 haus 1234");
    expect(cmds).toContain("setreading S10 soc 85");
    expect(cmds).toContain("setreading S10 netz -3198");
    expect(cmds).toContain("setreading S10 speicher 1000");
  });

  it("rounds decimal values correctly", () => {
    const cmds = buildFhemCommands({
      pvPower: 5432.7,
      housePower: 1234.3,
      batterySoc: 85.5,
      gridPower: -3198.9,
      batteryPower: 999.4,
    });

    expect(cmds).toContain("setreading S10 sonne 5433");
    expect(cmds).toContain("setreading S10 haus 1234");
    expect(cmds).toContain("setreading S10 soc 86");
    expect(cmds).toContain("setreading S10 netz -3199");
    expect(cmds).toContain("setreading S10 speicher 999");
  });

  it("handles zero values (night time)", () => {
    const cmds = buildFhemCommands({
      pvPower: 0,
      housePower: 450,
      batterySoc: 100,
      gridPower: 0,
      batteryPower: -450,
    });

    expect(cmds).toContain("setreading S10 sonne 0");
    expect(cmds).toContain("setreading S10 haus 450");
    expect(cmds).toContain("setreading S10 soc 100");
    expect(cmds).toContain("setreading S10 netz 0");
    expect(cmds).toContain("setreading S10 speicher -450");
  });

  it("handles negative battery power (discharging)", () => {
    const cmds = buildFhemCommands({
      pvPower: 0,
      housePower: 3000,
      batterySoc: 50,
      gridPower: 1000,
      batteryPower: -2000,
    });

    expect(cmds).toContain("setreading S10 speicher -2000");
  });

  it("produces exactly 5 commands separated by newlines", () => {
    const cmds = buildFhemCommands({
      pvPower: 1000,
      housePower: 500,
      batterySoc: 75,
      gridPower: -500,
      batteryPower: 0,
    });

    const lines = cmds.split("\n");
    expect(lines).toHaveLength(5);
    for (const line of lines) {
      expect(line).toMatch(/^setreading S10 \w+ -?\d+$/);
    }
  });

  it("uses device name S10 for all readings", () => {
    const cmds = buildFhemCommands({
      pvPower: 100,
      housePower: 200,
      batterySoc: 50,
      gridPower: 300,
      batteryPower: 400,
    });

    const lines = cmds.split("\n");
    for (const line of lines) {
      expect(line).toMatch(/^setreading S10 /);
    }
  });
});

// ── Module Integration Tests (with mocked I/O) ──────────────────────────

describe("FHEM E3DC Sync - syncE3dcToFhem Integration", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.useFakeTimers();
    mockGetSettings.mockReset();
    mockGetLastReadLiveData.mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("skips sync when fhemSync is disabled", async () => {
    mockGetSettings.mockReturnValue({
      fhemSync: { enabled: false, host: "192.168.40.11", port: 7072 },
    });

    const { syncE3dcToFhem } = await import("../fhem/e3dc-sync");
    // Should return without error
    await syncE3dcToFhem();
    // No liveData fetch should happen
    expect(mockGetLastReadLiveData).not.toHaveBeenCalled();
  });

  it("skips sync when fhemSync config is missing", async () => {
    mockGetSettings.mockReturnValue({});

    const { syncE3dcToFhem } = await import("../fhem/e3dc-sync");
    await syncE3dcToFhem();
    expect(mockGetLastReadLiveData).not.toHaveBeenCalled();
  });

  it("skips sync when no cached E3DC data available", async () => {
    mockGetSettings.mockReturnValue({
      fhemSync: { enabled: true, host: "192.168.40.11", port: 7072 },
    });
    mockGetLastReadLiveData.mockReturnValue(null);

    const { log } = await import("../core/logger");
    const { syncE3dcToFhem } = await import("../fhem/e3dc-sync");
    await syncE3dcToFhem();

    // Should log warning about missing data
    expect(log).toHaveBeenCalledWith(
      "warning",
      "fhem",
      expect.stringContaining("Keine E3DC-Daten"),
      expect.any(String),
    );
  });

  it("sends data via socket when config and data available", async () => {
    mockGetSettings.mockReturnValue({
      fhemSync: { enabled: true, host: "192.168.40.11", port: 7072 },
    });
    mockGetLastReadLiveData.mockReturnValue({
      pvPower: 5000,
      housePower: 1200,
      batterySoc: 80,
      gridPower: -2800,
      batteryPower: 1000,
      wallboxPower: 0,
      autarky: 95,
      selfConsumption: 88,
      gridFrequency: 50.01,
      timestamp: new Date().toISOString(),
    });

    const { syncE3dcToFhem } = await import("../fhem/e3dc-sync");

    // Run and advance timers for socket events
    const syncPromise = syncE3dcToFhem();
    await vi.advanceTimersByTimeAsync(100);
    await syncPromise;

    // Should not throw = success
    const { log } = await import("../core/logger");
    expect(log).toHaveBeenCalledWith(
      "debug",
      "fhem",
      expect.stringContaining("erfolgreich"),
      expect.any(String),
    );
  });
});

describe("FHEM E3DC Sync - Scheduler Lifecycle", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.useFakeTimers();
    mockGetSettings.mockReturnValue({
      fhemSync: { enabled: true, host: "192.168.40.11", port: 7072 },
    });
    mockGetLastReadLiveData.mockReturnValue(null);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("startFhemSyncScheduler returns an interval handle", async () => {
    const { startFhemSyncScheduler, stopFhemSyncScheduler } = await import("../fhem/e3dc-sync");
    const interval = startFhemSyncScheduler();
    expect(interval).toBeDefined();

    // Clean up
    await stopFhemSyncScheduler(interval);
  });

  it("stopFhemSyncScheduler can be called safely with null", async () => {
    const { stopFhemSyncScheduler } = await import("../fhem/e3dc-sync");
    // Should not throw
    await stopFhemSyncScheduler(null);
  });

  it("exports syncE3dcToFhem, startFhemSyncScheduler, stopFhemSyncScheduler", async () => {
    const mod = await import("../fhem/e3dc-sync");
    expect(typeof mod.syncE3dcToFhem).toBe("function");
    expect(typeof mod.startFhemSyncScheduler).toBe("function");
    expect(typeof mod.stopFhemSyncScheduler).toBe("function");
  });
});

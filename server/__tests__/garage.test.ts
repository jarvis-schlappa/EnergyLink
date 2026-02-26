import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Mock storage
const mockStorage = {
  getSettings: vi.fn(),
  getPlugStatusTracking: vi.fn().mockReturnValue({}),
  savePlugStatusTracking: vi.fn(),
};

vi.mock("../core/storage", () => ({
  storage: mockStorage,
}));

// Mock logger
vi.mock("../core/logger", () => ({
  log: vi.fn(),
}));

// Mock fetch globally
const mockFetch = vi.fn();
global.fetch = mockFetch;

describe("server/fhem/garage.ts", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockFetch.mockReset();
  });

  describe("getGarageStatus", () => {
    it("returns open state from FHEM jsonlist2", async () => {
      const { getGarageStatus } = await import("../fhem/garage");

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          Results: [{
            Readings: {
              state: { Value: "open", Time: "2026-02-26T10:30:00" },
            },
          }],
        }),
      });

      const status = await getGarageStatus("192.168.40.11");
      expect(status.state).toBe("open");
      expect(status.lastChanged).toBe("2026-02-26T10:30:00");
    });

    it("returns closed state from FHEM jsonlist2", async () => {
      const { getGarageStatus } = await import("../fhem/garage");

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          Results: [{
            Readings: {
              state: { Value: "closed", Time: "2026-02-26T08:00:00" },
            },
          }],
        }),
      });

      const status = await getGarageStatus("192.168.40.11");
      expect(status.state).toBe("closed");
    });

    it("returns unknown on HTTP error", async () => {
      const { getGarageStatus } = await import("../fhem/garage");

      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 500,
      });

      const status = await getGarageStatus("192.168.40.11");
      expect(status.state).toBe("unknown");
    });

    it("returns unknown on network error", async () => {
      const { getGarageStatus } = await import("../fhem/garage");

      mockFetch.mockRejectedValueOnce(new Error("ECONNREFUSED"));

      const status = await getGarageStatus("192.168.40.11");
      expect(status.state).toBe("unknown");
    });

    it("returns unknown for unexpected state value", async () => {
      const { getGarageStatus } = await import("../fhem/garage");

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          Results: [{
            Readings: {
              state: { Value: "half-open", Time: "2026-02-26T10:30:00" },
            },
          }],
        }),
      });

      const status = await getGarageStatus("192.168.40.11");
      expect(status.state).toBe("unknown");
    });
  });

  describe("toggleGarage", () => {
    it("sends on-for-timer command to FHEM", async () => {
      const { toggleGarage } = await import("../fhem/garage");

      mockFetch.mockResolvedValueOnce({ ok: true });

      await toggleGarage("192.168.40.11");

      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining("set%20aktor_garagentor%20on-for-timer%201"),
        expect.objectContaining({ method: "GET" }),
      );
    });

    it("throws on HTTP error", async () => {
      const { toggleGarage } = await import("../fhem/garage");

      mockFetch.mockResolvedValueOnce({ ok: false, status: 500 });

      await expect(toggleGarage("192.168.40.11")).rejects.toThrow(
        "FHEM-Befehl fehlgeschlagen",
      );
    });
  });
});

describe("server/routes/garage-routes.ts - autoCloseGarageIfNeeded", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockFetch.mockReset();
    // Reset module state (cooldown timers)
    vi.resetModules();
  });

  it("does nothing when autoCloseGarageOnPlug is false", async () => {
    mockStorage.getSettings.mockReturnValue({
      fhemSync: { host: "192.168.40.11", autoCloseGarageOnPlug: false },
    });

    const { autoCloseGarageIfNeeded } = await import("../routes/garage-routes");
    await autoCloseGarageIfNeeded();

    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("does nothing when no FHEM host configured", async () => {
    mockStorage.getSettings.mockReturnValue({
      fhemSync: { host: "", autoCloseGarageOnPlug: true },
    });

    const { autoCloseGarageIfNeeded } = await import("../routes/garage-routes");
    await autoCloseGarageIfNeeded();

    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("toggles garage when garage is open and cable plugged in", async () => {
    mockStorage.getSettings.mockReturnValue({
      fhemSync: { host: "192.168.40.11", autoCloseGarageOnPlug: true },
    });

    // First call: getGarageStatus (returns open)
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        Results: [{
          Readings: { state: { Value: "open", Time: "2026-02-26T10:30:00" } },
        }],
      }),
    });
    // Second call: toggleGarage
    mockFetch.mockResolvedValueOnce({ ok: true });

    const { autoCloseGarageIfNeeded } = await import("../routes/garage-routes");
    await autoCloseGarageIfNeeded();

    expect(mockFetch).toHaveBeenCalledTimes(2);
    expect(mockFetch.mock.calls[1][0]).toContain("aktor_garagentor");
  });

  it("skips toggle when garage is already closed", async () => {
    mockStorage.getSettings.mockReturnValue({
      fhemSync: { host: "192.168.40.11", autoCloseGarageOnPlug: true },
    });

    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        Results: [{
          Readings: { state: { Value: "closed", Time: "2026-02-26T10:30:00" } },
        }],
      }),
    });

    const { autoCloseGarageIfNeeded } = await import("../routes/garage-routes");
    await autoCloseGarageIfNeeded();

    // Only the status check, no toggle
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });
});

/**
 * Tests für Demo-Modus Isolation (Issues #64 und #67)
 *
 * #64: Wallbox-Mock darf keine echten Gerätewerte enthalten (E total)
 * #67: Nach Demo-Toggle muss sofort ein E3DC-Poll getriggert werden
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

// ══════════════════════════════════════════════════════════════════════════════
// Issue #64: Demo wallbox mock must not expose real device's total energy value
// ══════════════════════════════════════════════════════════════════════════════

describe("Issue #64 – Demo wallbox: no real device energy values", () => {
  it("WallboxMockService default totalEnergy must not be the real KEBA P20 value (31166830 Wh)", async () => {
    // The real KEBA P20 at the production site had exactly 31166830 Wh total energy.
    // Demo mode must NOT leak this real hardware value.
    const { WallboxMockService } = await import("../demo/wallbox-mock");
    const instance = new WallboxMockService();

    const report3 = instance.getReport3();
    // "E total" in KEBA protocol is in 0.1 Wh units: real value 31166830 Wh → 311668300
    const REAL_KEBA_E_TOTAL_TENTHS_WH = 31166830 * 10;
    expect(report3["E total"]).not.toBe(REAL_KEBA_E_TOTAL_TENTHS_WH);
  });

  it("WallboxMockService default totalEnergy must be an obviously simulated value", async () => {
    const { WallboxMockService } = await import("../demo/wallbox-mock");
    const instance = new WallboxMockService();

    const report3 = instance.getReport3();
    // E total in 0.1 Wh units. Expected demo value: 4_823_500 Wh → 48_235_000 tenths.
    // Must differ clearly from real value (31166830 Wh → 311668300 tenths).
    expect(report3["E total"]).not.toBe(311668300); // not real value
    // Demo value should be plausible and non-zero
    expect(report3["E total"]).toBeGreaterThan(0);
    expect(report3["E total"]).toBeLessThan(100_000_000); // < 10 MWh in 0.1Wh units
  });

  it("initializeDemo() must reset totalEnergy to demo value, not real device value", async () => {
    const { WallboxMockService } = await import("../demo/wallbox-mock");
    const instance = new WallboxMockService();

    // Manually corrupt the total energy to the real device value
    (instance as any).totalEnergy = 31166830;

    // Now reset via initializeDemo()
    instance.initializeDemo();

    const report3 = instance.getReport3();
    const REAL_KEBA_E_TOTAL_TENTHS_WH = 31166830 * 10;
    expect(report3["E total"]).not.toBe(REAL_KEBA_E_TOTAL_TENTHS_WH);
  });

  it("initializeDemo() must set totalEnergy to the expected demo value (~4.8 MWh)", async () => {
    const { WallboxMockService } = await import("../demo/wallbox-mock");
    const instance = new WallboxMockService();

    instance.initializeDemo();

    // Internal totalEnergy must be the demo value (4_823_500 Wh)
    const internalTotal = (instance as any).totalEnergy;
    expect(internalTotal).toBe(4_823_500);
  });

  it("wallboxMockService singleton also uses demo value after initializeDemo()", async () => {
    const { wallboxMockService } = await import("../demo/wallbox-mock");

    wallboxMockService.initializeDemo();
    const report3 = wallboxMockService.getReport3();

    // Must not be 31166830 Wh (= 311668300 in 0.1 Wh units)
    expect(report3["E total"]).not.toBe(311668300);
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// Issue #67: Immediate E3DC poll after demo mode toggle
// ══════════════════════════════════════════════════════════════════════════════

describe("Issue #67 – triggerImmediateE3dcPoll is exported from e3dc/poller", () => {
  it("triggerImmediateE3dcPoll function is exported", async () => {
    // Dynamic import to avoid hoisting issues with vi.mock
    // We need the real module (not mocked) to check the export shape
    const pollerModule = await import("../e3dc/poller");
    expect(typeof pollerModule.triggerImmediateE3dcPoll).toBe("function");
  });
});

describe("Issue #67 – triggerImmediateE3dcPoll cancels pending timer and fires poll", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.resetModules();
    vi.restoreAllMocks();
  });

  it("clears the pending initialPollerTimeout when called", async () => {
    // Mock storage to return null settings → pollE3dcData exits early (no E3DC IP)
    vi.doMock("../core/storage", () => ({
      storage: {
        getSettings: vi.fn(() => null),
        getControlState: vi.fn(() => ({})),
        getLogs: vi.fn(() => []),
        addLog: vi.fn(),
      },
    }));
    vi.doMock("../core/logger", () => ({ log: vi.fn() }));
    vi.doMock("../e3dc/modbus", () => ({
      getE3dcModbusService: vi.fn(),
      getE3dcLiveDataHub: vi.fn(),
    }));
    vi.doMock("../wallbox/transport", () => ({ sendUdpCommand: vi.fn(async () => ({})) }));
    vi.doMock("../monitoring/prowl-notifier", () => ({
      getProwlNotifier: vi.fn(() => ({
        sendE3dcConnectionRestored: vi.fn(async () => {}),
        sendE3dcConnectionLost: vi.fn(async () => {}),
      })),
    }));

    const clearTimeoutSpy = vi.spyOn(global, "clearTimeout");

    const { triggerImmediateE3dcPoll, startE3dcPoller } = await import("../e3dc/poller");

    // Start the poller — this sets initialPollerTimeout to a 2s timeout
    startE3dcPoller();

    // Verify clearTimeout is called when we trigger an immediate poll
    // (it should cancel the pending 2s initial timeout)
    triggerImmediateE3dcPoll();

    expect(clearTimeoutSpy).toHaveBeenCalled();
  });
});

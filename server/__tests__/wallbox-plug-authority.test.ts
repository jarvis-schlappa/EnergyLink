/**
 * Broadcast-Listener: Authoritative Plug State Tests
 *
 * Tests the in-memory plug status tracking in the broadcast-listener.
 * The broadcast-listener is the single source of truth for plug status –
 * its value overrides report 2 responses from the wallbox.
 *
 * Mock strategy:
 *   - wallbox/sse: vi.fn() — asserted (broadcastWallboxStatus checked for plug value)
 *   - wallbox/udp-channel: vi.fn() — onBroadcast captures the handler reference
 *   - core/storage: vi.fn() — broadcast-listener reads settings/state per event
 *   - All others: plain stubs (never asserted, just satisfy imports)
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

describe("Broadcast-listener authoritative plug state", () => {
  let broadcastHandler: (data: any, rinfo: any) => Promise<void>;
  let blModule: typeof import("../wallbox/broadcast-listener");
  let sseMock: {
    broadcastWallboxStatus: ReturnType<typeof vi.fn>;
    broadcastPartialUpdate: ReturnType<typeof vi.fn>;
  };
  const fakeRinfo = {
    address: "192.168.40.16",
    port: 7090,
    family: "IPv4",
    size: 0,
  };
  const mockUdpSender = vi.fn().mockResolvedValue({});

  function setupMocks() {
    sseMock = {
      broadcastWallboxStatus: vi.fn(),
      broadcastPartialUpdate: vi.fn(),
    };

    // Storage: vi.fn() needed — broadcast-listener reads settings per broadcast event
    vi.doMock("../core/storage", () => ({
      storage: {
        getSettings: vi.fn(() => ({
          wallboxIp: "192.168.40.16",
          fhemSync: { host: "", autoCloseGarageOnPlug: false },
          chargingStrategy: {
            activeStrategy: "off",
            inputX1Strategy: "max_without_battery",
          },
          prowl: { enabled: false },
        })),
        saveSettings: vi.fn(),
        getChargingContext: vi.fn(() => ({
          strategy: "off",
          isActive: false,
        })),
        saveChargingContext: vi.fn(),
        getControlState: vi.fn(() => ({
          nightCharging: false,
          batteryLock: false,
        })),
        saveControlState: vi.fn(),
        getPlugStatusTracking: vi.fn(() => ({})),
        savePlugStatusTracking: vi.fn(),
      },
    }));

    vi.doMock("../core/logger", () => ({ log: () => {} }));

    // UDP channel: mockOnBroadcast is asserted (captures broadcast handler)
    const mockOnBroadcast = vi.fn();
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
      }),
    }));

    vi.doMock("../monitoring/prowl-notifier", () => ({
      getProwlNotifier: () => ({
        sendPlugConnected: () => {},
        sendPlugDisconnected: () => {},
      }),
      triggerProwlEvent: () => {},
    }));

    vi.doMock("../wallbox/sse", () => sseMock);

    vi.doMock("../e3dc/poller", () => ({
      resetWallboxIdleThrottle: () => {},
    }));

    vi.doMock("../routes/wallbox-routes", () => ({
      resetStatusPollThrottle: () => {},
    }));

    vi.doMock("../routes/garage-routes", () => ({
      autoCloseGarageIfNeeded: () => Promise.resolve(),
    }));

    return mockOnBroadcast;
  }

  /** Minimal mock setup for tests that don't call startBroadcastListener */
  function setupMinimalMocks() {
    vi.doMock("../core/storage", () => ({
      storage: {
        getSettings: () => ({}),
        getPlugStatusTracking: () => ({}),
        savePlugStatusTracking: () => {},
      },
    }));
    vi.doMock("../core/logger", () => ({ log: () => {} }));
    vi.doMock("../wallbox/udp-channel", () => ({
      wallboxUdpChannel: { onBroadcast: () => {}, offBroadcast: () => {} },
    }));
    vi.doMock("../monitoring/prowl-notifier", () => ({
      getProwlNotifier: () => null,
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
    vi.doMock("../routes/shared-state", () => ({
      getOrCreateStrategyController: () => null,
    }));
    vi.doMock("../routes/garage-routes", () => ({
      autoCloseGarageIfNeeded: () => Promise.resolve(),
    }));
  }

  beforeEach(async () => {
    vi.clearAllMocks();
    vi.resetModules();

    const mockOnBroadcast = setupMocks();

    blModule = await import("../wallbox/broadcast-listener");
    await blModule.startBroadcastListener(mockUdpSender);
    broadcastHandler = mockOnBroadcast.mock.calls[0][0];
  });

  it("getAuthoritativePlugStatus returns null before any broadcast", async () => {
    vi.resetModules();
    setupMinimalMocks();

    const freshModule = await import("../wallbox/broadcast-listener");
    expect(freshModule.getAuthoritativePlugStatus()).toBeNull();
  });

  it("getAuthoritativePlugStatus returns correct value after initial broadcast", async () => {
    await broadcastHandler({ Plug: 7 }, fakeRinfo);
    expect(blModule.getAuthoritativePlugStatus()).toBe(7);
  });

  it("getAuthoritativePlugStatus updates on plug change", async () => {
    await broadcastHandler({ Plug: 3 }, fakeRinfo);
    await broadcastHandler({ Plug: 7 }, fakeRinfo);
    expect(blModule.getAuthoritativePlugStatus()).toBe(7);
  });

  it("getAuthoritativePlugStatus tracks multiple transitions", async () => {
    await broadcastHandler({ Plug: 1 }, fakeRinfo);
    expect(blModule.getAuthoritativePlugStatus()).toBe(1);

    await broadcastHandler({ Plug: 3 }, fakeRinfo);
    expect(blModule.getAuthoritativePlugStatus()).toBe(3);

    await broadcastHandler({ Plug: 5 }, fakeRinfo);
    expect(blModule.getAuthoritativePlugStatus()).toBe(5);

    await broadcastHandler({ Plug: 7 }, fakeRinfo);
    expect(blModule.getAuthoritativePlugStatus()).toBe(7);

    await broadcastHandler({ Plug: 3 }, fakeRinfo);
    expect(blModule.getAuthoritativePlugStatus()).toBe(3);
  });

  it("fetchAndBroadcastStatus uses in-memory plug over stale report 2", async () => {
    await broadcastHandler({ Plug: 7 }, fakeRinfo);

    await broadcastHandler({ State: 2 }, fakeRinfo);
    sseMock.broadcastWallboxStatus.mockClear();

    mockUdpSender
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({
        State: 3,
        Plug: 3,
        "Enable sys": 1,
        "Max curr": 16000,
      })
      .mockResolvedValueOnce({
        "E pres": 0,
        "E total": 0,
        P: 0,
        I1: 0,
        I2: 0,
        I3: 0,
      });

    await broadcastHandler({ State: 3 }, fakeRinfo);
    await new Promise((r) => setTimeout(r, 50));

    expect(sseMock.broadcastWallboxStatus).toHaveBeenCalled();
    const lastBroadcast = sseMock.broadcastWallboxStatus.mock.calls[0][0];
    expect(lastBroadcast.plug).toBe(7);
  });

  it("same plug value does not trigger a change broadcast", async () => {
    await broadcastHandler({ Plug: 7 }, fakeRinfo);
    sseMock.broadcastWallboxStatus.mockClear();

    await broadcastHandler({ Plug: 7 }, fakeRinfo);
    expect(sseMock.broadcastWallboxStatus).not.toHaveBeenCalled();
  });
});

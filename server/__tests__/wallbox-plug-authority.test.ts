/**
 * Broadcast-Listener: Authoritative Plug State Tests
 *
 * Tests the in-memory plug status tracking in the broadcast-listener.
 * The broadcast-listener is the single source of truth for plug status –
 * its value overrides report 2 responses from the wallbox.
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
    vi.doMock("../core/logger", () => ({ log: vi.fn() }));

    const mockOnBroadcast = vi.fn();
    vi.doMock("../wallbox/udp-channel", () => ({
      wallboxUdpChannel: {
        onBroadcast: mockOnBroadcast,
        offBroadcast: vi.fn(),
      },
    }));
    vi.doMock("../routes/shared-state", () => ({
      getOrCreateStrategyController: vi.fn(() => ({
        handleStrategyChange: vi.fn().mockResolvedValue(undefined),
        activateMaxPowerImmediately: vi.fn().mockResolvedValue(undefined),
        stopChargingOnly: vi.fn().mockResolvedValue(undefined),
      })),
    }));
    vi.doMock("../monitoring/prowl-notifier", () => ({
      getProwlNotifier: vi.fn(() => ({
        sendPlugConnected: vi.fn(),
        sendPlugDisconnected: vi.fn(),
      })),
      triggerProwlEvent: vi.fn(),
    }));
    vi.doMock("../wallbox/sse", () => sseMock);
    vi.doMock("../e3dc/poller", () => ({
      resetWallboxIdleThrottle: vi.fn(),
    }));
    vi.doMock("../routes/wallbox-routes", () => ({
      resetStatusPollThrottle: vi.fn(),
    }));
    vi.doMock("../routes/garage-routes", () => ({
      autoCloseGarageIfNeeded: vi.fn().mockResolvedValue(undefined),
    }));

    return mockOnBroadcast;
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
    // Need a fresh module without startBroadcastListener
    vi.resetModules();

    vi.doMock("../core/storage", () => ({
      storage: {
        getSettings: vi.fn(() => ({})),
        getPlugStatusTracking: vi.fn(() => ({})),
        savePlugStatusTracking: vi.fn(),
      },
    }));
    vi.doMock("../core/logger", () => ({ log: vi.fn() }));
    vi.doMock("../wallbox/udp-channel", () => ({
      wallboxUdpChannel: { onBroadcast: vi.fn(), offBroadcast: vi.fn() },
    }));
    vi.doMock("../monitoring/prowl-notifier", () => ({
      getProwlNotifier: vi.fn(),
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
    vi.doMock("../routes/shared-state", () => ({
      getOrCreateStrategyController: vi.fn(),
    }));
    vi.doMock("../routes/garage-routes", () => ({
      autoCloseGarageIfNeeded: vi.fn(),
    }));

    const freshModule = await import("../wallbox/broadcast-listener");
    expect(freshModule.getAuthoritativePlugStatus()).toBeNull();
  });

  it("getAuthoritativePlugStatus returns correct value after initial broadcast", async () => {
    await broadcastHandler({ Plug: 7 }, fakeRinfo);
    expect(blModule.getAuthoritativePlugStatus()).toBe(7);
  });

  it("getAuthoritativePlugStatus updates on plug change", async () => {
    await broadcastHandler({ Plug: 3 }, fakeRinfo); // initial
    await broadcastHandler({ Plug: 7 }, fakeRinfo); // change
    expect(blModule.getAuthoritativePlugStatus()).toBe(7);
  });

  it("getAuthoritativePlugStatus tracks multiple transitions", async () => {
    await broadcastHandler({ Plug: 1 }, fakeRinfo); // initial: no cable
    expect(blModule.getAuthoritativePlugStatus()).toBe(1);

    await broadcastHandler({ Plug: 3 }, fakeRinfo); // cable plugged, no car
    expect(blModule.getAuthoritativePlugStatus()).toBe(3);

    await broadcastHandler({ Plug: 5 }, fakeRinfo); // cable + car, not locked
    expect(blModule.getAuthoritativePlugStatus()).toBe(5);

    await broadcastHandler({ Plug: 7 }, fakeRinfo); // cable + car, locked
    expect(blModule.getAuthoritativePlugStatus()).toBe(7);

    await broadcastHandler({ Plug: 3 }, fakeRinfo); // car unplugged
    expect(blModule.getAuthoritativePlugStatus()).toBe(3);
  });

  it("fetchAndBroadcastStatus uses in-memory plug over stale report 2", async () => {
    // Set plug to 7 via broadcast
    await broadcastHandler({ Plug: 7 }, fakeRinfo);

    // Initialize state (first state broadcast is ignored)
    await broadcastHandler({ State: 2 }, fakeRinfo);
    sseMock.broadcastWallboxStatus.mockClear();

    // Mock UDP responses: report 2 says Plug=3 (stale!)
    mockUdpSender
      .mockResolvedValueOnce({}) // report 1
      .mockResolvedValueOnce({
        State: 3,
        Plug: 3, // ← STALE value from wallbox
        "Enable sys": 1,
        "Max curr": 16000,
      }) // report 2
      .mockResolvedValueOnce({
        "E pres": 0,
        "E total": 0,
        P: 0,
        I1: 0,
        I2: 0,
        I3: 0,
      }); // report 3

    // State change triggers fetchAndBroadcastStatus
    await broadcastHandler({ State: 3 }, fakeRinfo);

    // Give async fetchAndBroadcastStatus time to resolve
    await new Promise((r) => setTimeout(r, 50));

    // The broadcasted status should use plug=7 (in-memory), NOT plug=3 (report 2)
    expect(sseMock.broadcastWallboxStatus).toHaveBeenCalled();
    const lastBroadcast = sseMock.broadcastWallboxStatus.mock.calls[0][0];
    expect(lastBroadcast.plug).toBe(7);
  });

  it("same plug value does not trigger a change broadcast", async () => {
    await broadcastHandler({ Plug: 7 }, fakeRinfo); // initial
    sseMock.broadcastWallboxStatus.mockClear();

    await broadcastHandler({ Plug: 7 }, fakeRinfo); // same value

    // No fetchAndBroadcastStatus should have been triggered
    expect(sseMock.broadcastWallboxStatus).not.toHaveBeenCalled();
  });
});

/**
 * Tests for Wallbox Stop Issues (#73, #74, #75)
 * 
 * Issue #73: triggerImmediateE3dcPoll after stopCharging
 * Issue #74: resetStatusPollThrottle should not null the cache
 * Issue #75: Badge shows "Unterbrochen" instead of "Gestoppt" after user-initiated stop
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// =====================================================================
// Issue #73 – Stale E3DC-Daten nach Ladestopp
// After POST /api/wallbox/stop, triggerImmediateE3dcPoll must be called
// so the frontend gets fresh E3DC data immediately.
// =====================================================================

describe("Issue #73 – triggerImmediateE3dcPoll after stop", () => {
  let triggerImmediateE3dcPollMock: ReturnType<typeof vi.fn>;
  let mockSendUdpCommand: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.resetModules();

    triggerImmediateE3dcPollMock = vi.fn();
    mockSendUdpCommand = vi.fn();

    vi.doMock("../core/storage", () => ({
      storage: {
        getSettings: vi.fn(() => ({
          wallboxIp: "192.168.40.16",
          chargingStrategy: {
            activeStrategy: "max_without_battery",
            minStartPowerWatt: 1400,
            stopThresholdWatt: 1000,
            startDelaySeconds: 120,
            stopDelaySeconds: 300,
            physicalPhaseSwitch: 1,
            minCurrentChangeAmpere: 1,
            minChangeIntervalSeconds: 60,
            inputX1Strategy: "max_without_battery",
          },
        })),
        saveSettings: vi.fn(),
        getChargingContext: vi.fn(() => ({
          strategy: "max_without_battery",
          isActive: true,
          currentAmpere: 32,
          targetAmpere: 32,
          currentPhases: 1,
          adjustmentCount: 0,
        })),
        updateChargingContext: vi.fn(),
        getControlState: vi.fn(() => ({
          pvSurplus: false,
          nightCharging: false,
          batteryLock: true,
          gridCharging: false,
        })),
        saveControlState: vi.fn(),
        getPlugStatusTracking: vi.fn(() => ({})),
        savePlugStatusTracking: vi.fn(),
      },
    }));

    vi.doMock("../core/logger", () => ({ log: vi.fn() }));

    vi.doMock("../wallbox/transport", () => ({
      sendUdpCommand: mockSendUdpCommand,
    }));

    vi.doMock("../wallbox/sse", () => ({
      initSSEClient: vi.fn(),
      broadcastWallboxStatus: vi.fn(),
      broadcastPartialUpdate: vi.fn(),
    }));

    vi.doMock("../wallbox/broadcast-listener", () => ({
      getAuthoritativePlugStatus: vi.fn(() => 7),
    }));

    vi.doMock("../e3dc/poller", () => ({
      triggerImmediateE3dcPoll: triggerImmediateE3dcPollMock,
      resetWallboxIdleThrottle: vi.fn(),
    }));

    vi.doMock("../wallbox/cache-invalidation", () => ({
      invalidateWallboxCaches: vi.fn(),
    }));

    vi.doMock("../e3dc/client", () => ({
      e3dcClient: {
        isConfigured: vi.fn(() => true),
        configure: vi.fn(),
        lockDischarge: vi.fn().mockResolvedValue(undefined),
        unlockDischarge: vi.fn().mockResolvedValue(undefined),
      },
    }));

    vi.doMock("../monitoring/prowl-notifier", () => ({
      triggerProwlEvent: vi.fn(),
    }));

    vi.doMock("../routes/shared-state", () => ({
      getOrCreateStrategyController: vi.fn(() => ({
        handleStrategyChange: vi.fn().mockResolvedValue(undefined),
        activateMaxPowerImmediately: vi.fn().mockResolvedValue(undefined),
        stopChargingOnly: vi.fn().mockResolvedValue(undefined),
        stopChargingForStrategyOff: vi.fn().mockResolvedValue(undefined),
      })),
    }));
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("calls triggerImmediateE3dcPoll when POST /api/wallbox/stop is called", async () => {
    const express = (await import("express")).default;
    const supertest = (await import("supertest")).default;
    const { registerWallboxRoutes } = await import("../routes/wallbox-routes");

    const app = express();
    app.use(express.json());
    registerWallboxRoutes(app);

    const res = await supertest(app).post("/api/wallbox/stop").expect(200);
    expect(res.body.success).toBe(true);

    // Wait for background async task to complete
    await new Promise((resolve) => setTimeout(resolve, 50));

    // ASSERTION: triggerImmediateE3dcPoll must be called after stop
    expect(triggerImmediateE3dcPollMock).toHaveBeenCalledTimes(1);
  });
});

// =====================================================================
// Issue #74 – resetStatusPollThrottle should preserve cache
// resetStatusPollThrottle sets lastCachedStatus = null, causing
// getLastCachedWallboxStatus() to return null -> FRONTEND-STATE shows 0/0
// =====================================================================

describe("Issue #74 – resetStatusPollThrottle preserves cache", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.resetModules();

    vi.doMock("../core/storage", () => ({
      storage: {
        getSettings: vi.fn(() => ({
          wallboxIp: "192.168.40.16",
          chargingStrategy: { activeStrategy: "off" },
        })),
        getPlugStatusTracking: vi.fn(() => ({})),
        savePlugStatusTracking: vi.fn(),
        getChargingContext: vi.fn(() => ({ strategy: "off", isActive: false })),
        updateChargingContext: vi.fn(),
      },
    }));

    vi.doMock("../core/logger", () => ({ log: vi.fn() }));

    vi.doMock("../wallbox/transport", () => ({
      sendUdpCommand: vi.fn()
        .mockResolvedValueOnce({}) // report 1
        .mockResolvedValueOnce({ State: 3, Plug: 7, "Enable sys": 1, "Max curr": 16000 }) // report 2
        .mockResolvedValueOnce({ "E pres": 50000, "E total": 1000000, P: 3680000, I1: 16000, I2: 0, I3: 0 }), // report 3
    }));

    vi.doMock("../wallbox/sse", () => ({
      initSSEClient: vi.fn(),
      broadcastWallboxStatus: vi.fn(),
    }));

    vi.doMock("../wallbox/broadcast-listener", () => ({
      getAuthoritativePlugStatus: vi.fn(() => 7),
    }));
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("getLastCachedWallboxStatus returns stale (non-null) data after resetStatusPollThrottle", async () => {
    const { registerWallboxRoutes, resetStatusPollThrottle, getLastCachedWallboxStatus } = 
      await import("../routes/wallbox-routes");
    const express = (await import("express")).default;
    const supertest = (await import("supertest")).default;

    const app = express();
    app.use(express.json());
    registerWallboxRoutes(app);

    // First call: populate cache
    await supertest(app).get("/api/wallbox/status").expect(200);

    // Verify cache is populated
    const beforeReset = getLastCachedWallboxStatus();
    expect(beforeReset).not.toBeNull();
    expect(beforeReset!.state).toBe(3);

    // Reset throttle (simulates strategy start)
    resetStatusPollThrottle();

    // ASSERTION: Cache should still have data (not null)
    const afterReset = getLastCachedWallboxStatus();
    expect(afterReset).not.toBeNull();
    expect(afterReset!.state).toBe(3);
  });
});

// =====================================================================
// Issue #75 – Badge shows "Unterbrochen" after user-initiated stop
// ChargingContext should track lastStopReason: 'user' | 'system'
// Frontend should show "Gestoppt" for user-initiated stops.
// =====================================================================

describe("Issue #75 – lastStopReason in ChargingContext", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("chargingContextSchema accepts lastStopReason field", async () => {
    const { chargingContextSchema } = await import("@shared/schema");

    const validContext = {
      strategy: "off",
      isActive: false,
      currentAmpere: 0,
      targetAmpere: 0,
      currentPhases: 1,
      adjustmentCount: 0,
      lastStopReason: "user",
    };

    const result = chargingContextSchema.safeParse(validContext);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.lastStopReason).toBe("user");
    }
  });

  it("chargingContextSchema accepts 'system' as lastStopReason", async () => {
    const { chargingContextSchema } = await import("@shared/schema");

    const validContext = {
      strategy: "off",
      isActive: false,
      currentAmpere: 0,
      targetAmpere: 0,
      currentPhases: 1,
      adjustmentCount: 0,
      lastStopReason: "system",
    };

    const result = chargingContextSchema.safeParse(validContext);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.lastStopReason).toBe("system");
    }
  });

  it("POST /api/wallbox/stop sets lastStopReason to 'user' in ChargingContext", async () => {
    let capturedContextUpdates: any[] = [];

    vi.doMock("../core/storage", () => ({
      storage: {
        getSettings: vi.fn(() => ({
          wallboxIp: "192.168.40.16",
          chargingStrategy: {
            activeStrategy: "max_without_battery",
            minStartPowerWatt: 1400,
            stopThresholdWatt: 1000,
            startDelaySeconds: 120,
            stopDelaySeconds: 300,
            physicalPhaseSwitch: 1,
            minCurrentChangeAmpere: 1,
            minChangeIntervalSeconds: 60,
            inputX1Strategy: "max_without_battery",
          },
        })),
        saveSettings: vi.fn(),
        getChargingContext: vi.fn(() => ({
          strategy: "max_without_battery",
          isActive: true,
          currentAmpere: 32,
          targetAmpere: 32,
          currentPhases: 1,
          adjustmentCount: 0,
        })),
        updateChargingContext: vi.fn((...args: any[]) => {
          capturedContextUpdates.push(args[0]);
        }),
        getControlState: vi.fn(() => ({
          pvSurplus: false,
          nightCharging: false,
          batteryLock: true,
          gridCharging: false,
        })),
        saveControlState: vi.fn(),
        getPlugStatusTracking: vi.fn(() => ({})),
        savePlugStatusTracking: vi.fn(),
      },
    }));

    vi.doMock("../core/logger", () => ({ log: vi.fn() }));

    vi.doMock("../wallbox/transport", () => ({
      sendUdpCommand: vi.fn().mockResolvedValue({}),
    }));

    vi.doMock("../wallbox/sse", () => ({
      initSSEClient: vi.fn(),
      broadcastWallboxStatus: vi.fn(),
      broadcastPartialUpdate: vi.fn(),
    }));

    vi.doMock("../wallbox/broadcast-listener", () => ({
      getAuthoritativePlugStatus: vi.fn(() => 7),
    }));

    vi.doMock("../e3dc/poller", () => ({
      triggerImmediateE3dcPoll: vi.fn(),
      resetWallboxIdleThrottle: vi.fn(),
    }));

    vi.doMock("../e3dc/client", () => ({
      e3dcClient: {
        isConfigured: vi.fn(() => true),
        configure: vi.fn(),
        lockDischarge: vi.fn().mockResolvedValue(undefined),
        unlockDischarge: vi.fn().mockResolvedValue(undefined),
      },
    }));

    vi.doMock("../monitoring/prowl-notifier", () => ({
      triggerProwlEvent: vi.fn(),
    }));

    vi.doMock("../routes/shared-state", () => ({
      getOrCreateStrategyController: vi.fn(() => ({
        handleStrategyChange: vi.fn().mockResolvedValue(undefined),
        activateMaxPowerImmediately: vi.fn().mockResolvedValue(undefined),
        stopChargingOnly: vi.fn().mockResolvedValue(undefined),
        stopChargingForStrategyOff: vi.fn().mockResolvedValue(undefined),
      })),
    }));

    const express = (await import("express")).default;
    const supertest = (await import("supertest")).default;
    const { registerWallboxRoutes } = await import("../routes/wallbox-routes");

    const app = express();
    app.use(express.json());
    registerWallboxRoutes(app);

    await supertest(app).post("/api/wallbox/stop").expect(200);

    // Wait for background async task
    await new Promise((resolve) => setTimeout(resolve, 50));

    // ASSERTION: At least one updateChargingContext call should include lastStopReason: 'user'
    const hasUserStopReason = capturedContextUpdates.some(
      (update) => update.lastStopReason === "user"
    );
    expect(hasUserStopReason).toBe(true);
  });
});

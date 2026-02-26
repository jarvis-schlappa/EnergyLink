/**
 * Wallbox Status Data Flow Tests
 *
 * Tests that freeze the current behavior of the wallbox status data flow
 * BEFORE the architectural refactoring (wallboxStateManager).
 *
 * These tests ensure:
 * 1. HTTP endpoint uses authoritative plug status from broadcast-listener
 * 2. SSE full broadcasts contain all required fields
 * 3. SSE partial broadcasts document which fields are missing
 * 4. Idle-throttle returns cached status
 * 5. Broadcast-listener updates in-memory plug status correctly
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// ===================================================================
// 1. HTTP Endpoint: Authoritative Plug Status
// ===================================================================

describe("GET /api/wallbox/status – authoritative plug value", () => {
  const mockFetch = vi.fn();

  // Mock storage
  const mockStorage = {
    getSettings: vi.fn(() => ({
      wallboxIp: "192.168.40.16",
      chargingStrategy: { activeStrategy: "off" },
    })),
    getPlugStatusTracking: vi.fn(() => ({})),
    savePlugStatusTracking: vi.fn(),
    getChargingContext: vi.fn(() => ({ strategy: "off" })),
    updateChargingContext: vi.fn(),
  };

  // Mock sendUdpCommand – simulates 3 report responses
  const mockSendUdpCommand = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    vi.resetModules();

    vi.doMock("../core/storage", () => ({ storage: mockStorage }));
    vi.doMock("../core/logger", () => ({ log: vi.fn() }));
    vi.doMock("../wallbox/transport", () => ({
      sendUdpCommand: mockSendUdpCommand,
    }));
    vi.doMock("../wallbox/sse", () => ({
      initSSEClient: vi.fn(),
      broadcastWallboxStatus: vi.fn(),
    }));
    vi.doMock("../routes/shared-state", () => ({
      getOrCreateStrategyController: vi.fn(() => ({
        handleStrategyChange: vi.fn(),
        activateMaxPowerImmediately: vi.fn(),
        stopChargingOnly: vi.fn(),
        stopChargingForStrategyOff: vi.fn(),
      })),
    }));
  });

  it("uses broadcast-listener plug value over report 2 value", async () => {
    // Simulate: broadcast-listener knows plug=7, but report 2 still says plug=3
    vi.doMock("../wallbox/broadcast-listener", () => ({
      getAuthoritativePlugStatus: vi.fn(() => 7),
    }));

    const express = (await import("express")).default;
    const supertest = (await import("supertest")).default;
    const { registerWallboxRoutes } = await import("../routes/wallbox-routes");

    const app = express();
    app.use(express.json());
    registerWallboxRoutes(app);

    // report 1, report 2, report 3 responses
    mockSendUdpCommand
      .mockResolvedValueOnce({ Serial: "12345" }) // report 1
      .mockResolvedValueOnce({
        State: 2,
        Plug: 3, // ← stale value!
        "Enable sys": 1,
        "Max curr": 16000,
        Input: 0,
      }) // report 2
      .mockResolvedValueOnce({
        "E pres": 50000,
        "E total": 1000000,
        P: 0,
        I1: 0,
        I2: 0,
        I3: 0,
      }); // report 3

    const res = await supertest(app).get("/api/wallbox/status").expect(200);

    // Plug should be 7 (from broadcast-listener), NOT 3 (from report 2)
    expect(res.body.plug).toBe(7);
  });

  it("falls back to report 2 plug when no broadcast received yet", async () => {
    // No broadcast received → getAuthoritativePlugStatus returns null
    vi.doMock("../wallbox/broadcast-listener", () => ({
      getAuthoritativePlugStatus: vi.fn(() => null),
    }));

    const express = (await import("express")).default;
    const supertest = (await import("supertest")).default;
    const { registerWallboxRoutes } = await import("../routes/wallbox-routes");

    const app = express();
    app.use(express.json());
    registerWallboxRoutes(app);

    mockSendUdpCommand
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({
        State: 2,
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

    const res = await supertest(app).get("/api/wallbox/status").expect(200);

    expect(res.body.plug).toBe(3); // fallback to report 2
  });

  it("HTTP endpoint broadcasts status to all SSE clients", async () => {
    vi.doMock("../wallbox/broadcast-listener", () => ({
      getAuthoritativePlugStatus: vi.fn(() => 7),
    }));

    const { broadcastWallboxStatus } = await import("../wallbox/sse");
    const express = (await import("express")).default;
    const supertest = (await import("supertest")).default;
    const { registerWallboxRoutes } = await import("../routes/wallbox-routes");

    const app = express();
    app.use(express.json());
    registerWallboxRoutes(app);

    mockSendUdpCommand
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({
        State: 3,
        Plug: 3,
        "Enable sys": 1,
        "Max curr": 16000,
      })
      .mockResolvedValueOnce({
        "E pres": 50000,
        "E total": 1000000,
        P: 3680000,
        I1: 16000,
        I2: 0,
        I3: 0,
      });

    await supertest(app).get("/api/wallbox/status").expect(200);

    expect(broadcastWallboxStatus).toHaveBeenCalledTimes(1);
    const broadcastedStatus = (broadcastWallboxStatus as any).mock.calls[0][0];
    expect(broadcastedStatus.plug).toBe(7);
    expect(broadcastedStatus.state).toBe(3);
  });

  it("returns all required WallboxStatus fields", async () => {
    vi.doMock("../wallbox/broadcast-listener", () => ({
      getAuthoritativePlugStatus: vi.fn(() => 7),
    }));

    const express = (await import("express")).default;
    const supertest = (await import("supertest")).default;
    const { registerWallboxRoutes } = await import("../routes/wallbox-routes");

    const app = express();
    app.use(express.json());
    registerWallboxRoutes(app);

    mockSendUdpCommand
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({
        State: 3,
        Plug: 7,
        "Enable sys": 1,
        "Max curr": 16000,
        Input: 1,
      })
      .mockResolvedValueOnce({
        "E pres": 50000,
        "E total": 1000000,
        P: 3680000,
        I1: 16000,
        I2: 0,
        I3: 0,
      });

    const res = await supertest(app).get("/api/wallbox/status").expect(200);

    // All required fields from WallboxStatus schema
    expect(res.body).toHaveProperty("state");
    expect(res.body).toHaveProperty("plug");
    expect(res.body).toHaveProperty("enableSys");
    expect(res.body).toHaveProperty("maxCurr");
    expect(res.body).toHaveProperty("ePres");
    expect(res.body).toHaveProperty("eTotal");
    expect(res.body).toHaveProperty("power");
    expect(res.body).toHaveProperty("phases");
    expect(res.body).toHaveProperty("lastUpdated");

    // Correct unit conversions
    expect(res.body.maxCurr).toBe(16); // mA → A
    expect(res.body.ePres).toBe(5000); // dWh → Wh
    expect(res.body.eTotal).toBe(100000); // dWh → Wh
    expect(res.body.power).toBe(3.68); // µW → kW
    expect(res.body.phases).toBe(1); // only I1 > threshold
  });
});

// ===================================================================
// 2. SSE: Full vs Partial broadcasts
// ===================================================================
// NOTE: These tests are in a separate file (wallbox-sse-content.test.ts)
// because they need the REAL sse module (not mocked), and the doMock
// calls above interfere with module resolution within the same file.

// ===================================================================
// 3. Idle Throttle behavior
// ===================================================================

describe("Idle throttle on /api/wallbox/status", () => {
  const mockSendUdpCommand = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
    vi.useFakeTimers();

    vi.doMock("../core/storage", () => ({
      storage: {
        getSettings: vi.fn(() => ({
          wallboxIp: "192.168.40.16",
          chargingStrategy: { activeStrategy: "off" },
        })),
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
    }));
    vi.doMock("../wallbox/broadcast-listener", () => ({
      getAuthoritativePlugStatus: vi.fn(() => 7),
    }));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("returns cached status on second call within 30s when idle", async () => {
    const express = (await import("express")).default;
    const supertest = (await import("supertest")).default;
    const { registerWallboxRoutes } = await import("../routes/wallbox-routes");

    const app = express();
    app.use(express.json());
    registerWallboxRoutes(app);

    // First call: full UDP roundtrip
    mockSendUdpCommand
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({
        State: 5, // idle/interrupted
        Plug: 7,
        "Enable sys": 0,
        "Max curr": 16000,
      })
      .mockResolvedValueOnce({
        "E pres": 50000,
        "E total": 1000000,
        P: 0,
        I1: 0,
        I2: 0,
        I3: 0,
      });

    const res1 = await supertest(app).get("/api/wallbox/status").expect(200);
    expect(res1.body.state).toBe(5);
    expect(mockSendUdpCommand).toHaveBeenCalledTimes(3); // 3 reports

    // Second call within 30s: should use cache (strategy=off + state=5)
    mockSendUdpCommand.mockClear();
    vi.advanceTimersByTime(10_000); // 10s later

    const res2 = await supertest(app).get("/api/wallbox/status").expect(200);
    expect(res2.body.state).toBe(5);
    expect(mockSendUdpCommand).toHaveBeenCalledTimes(0); // cached!
  });

  it("does NOT throttle when state is not idle (state=3 charging)", async () => {
    const express = (await import("express")).default;
    const supertest = (await import("supertest")).default;
    const { registerWallboxRoutes } = await import("../routes/wallbox-routes");

    const app = express();
    app.use(express.json());
    registerWallboxRoutes(app);

    // First call: state=3 (charging, not idle)
    mockSendUdpCommand
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({
        State: 3,
        Plug: 7,
        "Enable sys": 1,
        "Max curr": 16000,
      })
      .mockResolvedValueOnce({
        "E pres": 50000,
        "E total": 1000000,
        P: 3680000,
        I1: 16000,
        I2: 0,
        I3: 0,
      });

    await supertest(app).get("/api/wallbox/status").expect(200);
    expect(mockSendUdpCommand).toHaveBeenCalledTimes(3);

    // Second call: NOT throttled because state=3 (not idle)
    mockSendUdpCommand.mockClear();
    mockSendUdpCommand
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({
        State: 3,
        Plug: 7,
        "Enable sys": 1,
        "Max curr": 16000,
      })
      .mockResolvedValueOnce({
        "E pres": 55000,
        "E total": 1000500,
        P: 3680000,
        I1: 16000,
        I2: 0,
        I3: 0,
      });

    await supertest(app).get("/api/wallbox/status").expect(200);
    expect(mockSendUdpCommand).toHaveBeenCalledTimes(3); // full roundtrip again
  });
});

// ===================================================================
// 4. Broadcast-Listener: in-memory plug state
// ===================================================================
// NOTE: These tests are in a separate file (wallbox-plug-authority.test.ts)
// because doMock for ../wallbox/broadcast-listener in section 1 above
// persists across vi.resetModules() and blocks the real import.

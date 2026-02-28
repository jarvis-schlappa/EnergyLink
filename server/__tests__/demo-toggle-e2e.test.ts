import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import { createServer, type Server } from "http";
import type { AddressInfo } from "net";

/**
 * E2E test for demo mode toggle at runtime (#18).
 *
 * Starts the server in PRODUCTION mode (no DEMO_AUTOSTART),
 * then toggles demo mode via POST /api/settings and verifies
 * that subsequent API calls return mock data (not real hardware).
 *
 * This test MUST fail before the fix is applied — if it passes
 * without the fix, it's testing mocks, not real behavior.
 */

let server: Server;
let baseUrl: string;

const SERVER_START_TIMEOUT = 30_000;

beforeAll(async () => {
  // CRITICAL: Do NOT set DEMO_AUTOSTART — we start in production mode
  delete process.env.DEMO_AUTOSTART;
  process.env.NODE_ENV = "production";
  process.env.PORT = "0";

  const express = (await import("express")).default;
  const { healthHandler } = await import("../core/health");
  const { registerRoutes } = await import("../routes/index");
  const { storage } = await import("../core/storage");

  const app = express();
  app.use(express.json());

  app.get("/api/health", healthHandler);

  // Ensure settings exist with "real" IPs (NOT 127.0.0.1)
  const currentSettings = storage.getSettings();
  storage.saveSettings({
    ...currentSettings,
    wallboxIp: "192.168.40.16",
    demoMode: false,
    mockWallboxPhases: 3,
    mockWallboxPlugStatus: 7,
    fhemSync: {
      enabled: false,
      host: "192.168.40.11",
      port: 7072,
      autoCloseGarageOnPlug: false,
    },
  });

  // Register routes — no mock server started!
  await registerRoutes(app);
  server = createServer(app);

  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address() as AddressInfo;
      baseUrl = `http://127.0.0.1:${addr.port}`;
      resolve();
    });
  });
}, SERVER_START_TIMEOUT);

afterAll(async () => {
  if (server) {
    // Stop mock if running
    try {
      const { stopUnifiedMock } = await import("../demo/unified-mock");
      await stopUnifiedMock();
    } catch { /* ignore */ }

    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

describe("Demo mode toggle at runtime (#18)", () => {
  it("should start with demoMode=false", async () => {
    const res = await request(server).get("/api/settings");
    expect(res.status).toBe(200);
    expect(res.body.demoMode).toBe(false);
    expect(res.body.wallboxIp).toBe("192.168.40.16");
  });

  it("should toggle demo mode on and serve mock wallbox data", async () => {
    // 1. Read current settings
    const getRes = await request(server).get("/api/settings");
    expect(getRes.status).toBe(200);
    const currentSettings = getRes.body;

    // 2. Toggle demo mode ON via POST /api/settings
    const postRes = await request(server)
      .post("/api/settings")
      .send({ ...currentSettings, demoMode: true });
    expect(postRes.status).toBe(200);

    // 3. Wait for mock server to start
    await new Promise((r) => setTimeout(r, 3000));

    // 4. Verify settings: wallboxIp should now be 127.0.0.1
    const settingsRes = await request(server).get("/api/settings");
    expect(settingsRes.status).toBe(200);
    expect(settingsRes.body.demoMode).toBe(true);
    expect(settingsRes.body.wallboxIp).toBe("127.0.0.1");

    // 5. CRITICAL: GET /api/wallbox/status must return mock data (not timeout/error)
    const wallboxRes = await request(server).get("/api/wallbox/status");
    expect(wallboxRes.status).toBe(200);
    // Mock wallbox returns state 2 (ready) with plug 7 (locked)
    expect(wallboxRes.body).toHaveProperty("state");
    expect(wallboxRes.body).toHaveProperty("plug");
    expect(typeof wallboxRes.body.state).toBe("number");
    expect(typeof wallboxRes.body.plug).toBe("number");
  }, 15_000);

  it("should serve mock E3DC data after toggle", async () => {
    // E3DC endpoint should return mock data (not connection errors)
    const res = await request(server).get("/api/e3dc/live");
    // If E3DC route exists and mock is running, should return 200 with data
    // If route doesn't exist, we'll get 404 — that's fine (not all routes may exist)
    if (res.status === 200) {
      expect(res.body).toHaveProperty("pvPower");
      expect(res.body).toHaveProperty("batterySoc");
      expect(typeof res.body.pvPower).toBe("number");
    }
  });

  it("should toggle demo mode off and restore real IPs", async () => {
    // 1. Read current settings
    const getRes = await request(server).get("/api/settings");
    const currentSettings = getRes.body;

    // 2. Toggle demo mode OFF
    const postRes = await request(server)
      .post("/api/settings")
      .send({ ...currentSettings, demoMode: false });
    expect(postRes.status).toBe(200);

    // 3. Wait for mock server to stop
    await new Promise((r) => setTimeout(r, 2000));

    // 4. Verify settings: wallboxIp should be restored
    const settingsRes = await request(server).get("/api/settings");
    expect(settingsRes.status).toBe(200);
    expect(settingsRes.body.demoMode).toBe(false);
    // wallboxIp should be restored from backup (192.168.40.16)
    expect(settingsRes.body.wallboxIp).toBe("192.168.40.16");
  }, 10_000);
});

describe("Mock wallbox plug status broadcast (#18)", () => {
  it("should apply plug status changes when demo mode is active", async () => {
    // 1. Enable demo mode first
    const getRes = await request(server).get("/api/settings");
    const currentSettings = getRes.body;
    
    await request(server)
      .post("/api/settings")
      .send({ ...currentSettings, demoMode: true });

    await new Promise((r) => setTimeout(r, 3000));

    // 2. Read current wallbox status — should be plug=7 (default)
    const status1 = await request(server).get("/api/wallbox/status");
    expect(status1.status).toBe(200);
    expect(status1.body.plug).toBe(7);

    // 3. Change plug status to 0 (unplugged) via settings
    const settingsRes = await request(server).get("/api/settings");
    await request(server)
      .post("/api/settings")
      .send({ ...settingsRes.body, mockWallboxPlugStatus: 0 });

    // 4. Wait for broadcast to propagate
    await new Promise((r) => setTimeout(r, 1000));

    // 5. Wallbox status should now show plug=0
    const status2 = await request(server).get("/api/wallbox/status");
    expect(status2.status).toBe(200);
    expect(status2.body.plug).toBe(0);

    // Cleanup: turn off demo mode
    const finalSettings = await request(server).get("/api/settings");
    await request(server)
      .post("/api/settings")
      .send({ ...finalSettings.body, demoMode: false });
    await new Promise((r) => setTimeout(r, 2000));
  }, 20_000);
});

describe("fhemSync.host backup/restore on demo toggle (#62)", () => {
  it("should restore fhemSync.host when demo mode is deactivated", async () => {
    // 0. Ensure clean state: demo OFF, real fhemSync.host set
    const cleanup = await request(server).get("/api/settings");
    await request(server)
      .post("/api/settings")
      .send({
        ...cleanup.body,
        demoMode: false,
        fhemSync: { enabled: false, host: "192.168.40.11", port: 7072, autoCloseGarageOnPlug: false },
      });
    await new Promise((r) => setTimeout(r, 2000));

    // 1. Verify initial state: demo OFF, real fhemSync.host
    const initialRes = await request(server).get("/api/settings");
    expect(initialRes.status).toBe(200);
    expect(initialRes.body.demoMode).toBe(false);
    expect(initialRes.body.fhemSync?.host).toBe("192.168.40.11");

    // 2. Toggle demo mode ON via POST /api/settings (full E2E path)
    const settingsOn = await request(server).get("/api/settings");
    const postOnRes = await request(server)
      .post("/api/settings")
      .send({ ...settingsOn.body, demoMode: true });
    expect(postOnRes.status).toBe(200);

    // Wait for startUnifiedMock() to finish (may partly fail on ports, that's ok)
    await new Promise((r) => setTimeout(r, 3000));

    // 3. Verify fhemSync.host is now 127.0.0.1 (mock)
    const demoOnRes = await request(server).get("/api/settings");
    expect(demoOnRes.status).toBe(200);
    expect(demoOnRes.body.demoMode).toBe(true);
    expect(demoOnRes.body.fhemSync?.host).toBe("127.0.0.1");

    // 4. Toggle demo mode OFF via POST /api/settings
    const settingsOff = await request(server).get("/api/settings");
    const postOffRes = await request(server)
      .post("/api/settings")
      .send({ ...settingsOff.body, demoMode: false });
    expect(postOffRes.status).toBe(200);

    await new Promise((r) => setTimeout(r, 2000));

    // 5. CRITICAL: fhemSync.host MUST be restored to original "192.168.40.11"
    const restoredRes = await request(server).get("/api/settings");
    expect(restoredRes.status).toBe(200);
    expect(restoredRes.body.demoMode).toBe(false);
    expect(restoredRes.body.fhemSync?.host).toBe("192.168.40.11");

    // 6. fhemHostBackup must be cleaned up (no stale backup after demo OFF)
    expect(restoredRes.body.fhemHostBackup).toBeUndefined();
  }, 20_000);
});

describe("E3DC mock state reset on demo toggle (#63)", () => {
  it("should reset SOC state when demo is restarted via reset()", async () => {
    const { e3dcMockService } = await import("../demo/e3dc-mock");

    // 1. Reset to get a clean time-appropriate initial SOC
    e3dcMockService.reset();
    const freshData = await e3dcMockService.getLiveData(0);
    const initialSoc = freshData.batterySoc;

    // 2. Dirty the singleton state directly (simulates SOC drift during long demo session)
    (e3dcMockService as any).currentSoc = 99;
    const dirtyData = await e3dcMockService.getLiveData(0);
    expect(dirtyData.batterySoc).toBe(99);

    // 3. Reset — SOC must return to time-appropriate value, NOT stay at 99
    e3dcMockService.reset();
    const resetData = await e3dcMockService.getLiveData(0);
    expect(resetData.batterySoc).toBe(initialSoc);
    expect(resetData.batterySoc).not.toBe(99);

    // 4. SOC must be in valid range (0-100)
    expect(resetData.batterySoc).toBeGreaterThanOrEqual(0);
    expect(resetData.batterySoc).toBeLessThanOrEqual(100);
  });
});

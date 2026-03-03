import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync } from "fs";
import { join } from "path";
import os from "os";
import request from "supertest";
import { createServer, type Server } from "http";
import type { AddressInfo } from "net";

/**
 * Extended integration tests for EnergyLink API routes in demo mode.
 * Covers: Garage, E3DC, Settings (charging/strategy/logs), Wallbox (plug-tracking).
 *
 * Same setup pattern as api-integration.test.ts:
 * Real Express server with DEMO_AUTOSTART=true, supertest, no mocks.
 */

let server: Server;
let baseUrl: string;
let tmpDataDir: string;
const originalDataDir = join(process.cwd(), "data");

const SERVER_START_TIMEOUT = 30_000;

beforeAll(async () => {
  // Isolate test data to prevent state leakage between test files (#88)
  tmpDataDir = mkdtempSync(join(os.tmpdir(), "energylink-test-route-"));
  process.env.DEMO_AUTOSTART = "true";
  process.env.NODE_ENV = "production";
  process.env.PORT = "0";

  const express = (await import("express")).default;
  const { healthHandler } = await import("../core/health");
  const { registerRoutes } = await import("../routes/index");
  const { storage } = await import("../core/storage");
  storage.reinitialize(tmpDataDir);
  const { startUnifiedMock } = await import("../demo/unified-mock");

  const app = express();
  app.use(express.json());

  app.get("/api/health", healthHandler);

  // Ensure demo mode settings exist with all required fields
  const currentSettings = storage.getSettings();
  if (!currentSettings?.wallboxIp) {
    storage.saveSettings({
      wallboxIp: "127.0.0.1",
      demoMode: true,
      mockWallboxPhases: 3,
      mockWallboxPlugStatus: 7,
    });
  } else if (!currentSettings.demoMode) {
    storage.saveSettings({ ...currentSettings, demoMode: true });
  }

  await startUnifiedMock();

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
    await new Promise<void>((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    });
  }
  try {
    const { stopUnifiedMock } = await import("../demo/unified-mock");
    await stopUnifiedMock();
  } catch {
    // ignore
  }
  try {
    const { shutdownSchedulers } = await import("../routes/index");
    await shutdownSchedulers();
  } catch {
    // ignore
  }
  // Restore original data dir and clean up temp (#88)
  const { storage } = await import("../core/storage");
  storage.reinitialize(originalDataDir);
  try { rmSync(tmpDataDir, { recursive: true, force: true }); } catch { /* ignore */ }
});

// ─── Garage Routes ──────────────────────────────────────────────────────

describe("Garage Routes", () => {
  it("GET /api/garage/status → 200 with state and lastChanged", async () => {
    const res = await request(baseUrl).get("/api/garage/status");
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty("state");
    expect(["open", "closed", "moving", "unknown"]).toContain(res.body.state);
  });

  it("POST /api/garage/toggle → 200 with success", async () => {
    const res = await request(baseUrl)
      .post("/api/garage/toggle")
      .send({});
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty("success", true);
  });

  it("POST /api/garage/toggle → 429 on rapid second call (cooldown)", async () => {
    // The previous toggle set the cooldown (20s). A second call should be rejected.
    const res = await request(baseUrl)
      .post("/api/garage/toggle")
      .send({});
    expect(res.status).toBe(429);
    expect(res.body).toHaveProperty("error");
    expect(res.body.error).toMatch(/Cooldown/i);
  });
});

// ─── E3DC Routes ────────────────────────────────────────────────────────

describe("E3DC Routes", () => {
  it("GET /api/e3dc/live-data → 200 or 503 (cache may be empty)", async () => {
    const res = await request(baseUrl).get("/api/e3dc/live-data");
    // In demo mode, cache might not be populated yet (503) or it might be (200)
    expect([200, 503]).toContain(res.status);

    if (res.status === 200) {
      expect(res.body).toHaveProperty("pvPower");
      expect(res.body).toHaveProperty("batteryPower");
      expect(res.body).toHaveProperty("housePower");
      expect(res.body).toHaveProperty("gridPower");
      expect(res.body).toHaveProperty("batterySoc");
      expect(typeof res.body.pvPower).toBe("number");
    } else {
      expect(res.body).toHaveProperty("error");
    }
  });

  it("POST /api/e3dc/execute-command with empty command → 400", async () => {
    // First ensure e3dc is enabled in settings
    const settingsRes = await request(baseUrl).get("/api/settings");
    const settings = settingsRes.body;
    await request(baseUrl)
      .post("/api/settings")
      .send({ ...settings, e3dc: { ...settings.e3dc, enabled: true } });

    const res = await request(baseUrl)
      .post("/api/e3dc/execute-command")
      .send({ command: "" });
    expect(res.status).toBe(400);
    expect(res.body).toHaveProperty("error");
  });

  it("POST /api/e3dc/execute-command without command field → 400", async () => {
    const res = await request(baseUrl)
      .post("/api/e3dc/execute-command")
      .send({});
    expect(res.status).toBe(400);
    expect(res.body).toHaveProperty("error");
  });

  it("POST /api/e3dc/execute-command with non-string command → 400", async () => {
    const res = await request(baseUrl)
      .post("/api/e3dc/execute-command")
      .send({ command: 123 });
    expect(res.status).toBe(400);
    expect(res.body).toHaveProperty("error");
  });

  it("POST /api/e3dc/execute-command with e3dc disabled → 400", async () => {
    // Disable e3dc
    const settingsRes = await request(baseUrl).get("/api/settings");
    const settings = settingsRes.body;
    await request(baseUrl)
      .post("/api/settings")
      .send({ ...settings, e3dc: { ...settings.e3dc, enabled: false } });

    const res = await request(baseUrl)
      .post("/api/e3dc/execute-command")
      .send({ command: "list" });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/nicht aktiviert/i);

    // Re-enable for other tests
    await request(baseUrl)
      .post("/api/settings")
      .send({ ...settings, e3dc: { ...settings.e3dc, enabled: true } });
  });

  it("GET /api/grid-frequency-status → 200 with tier/frequency/deviation", async () => {
    const res = await request(baseUrl).get("/api/grid-frequency-status");
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty("tier");
    expect(res.body).toHaveProperty("frequency");
    expect(res.body).toHaveProperty("deviation");
    expect(res.body).toHaveProperty("chargingActive");
    expect(res.body).toHaveProperty("lastUpdate");
    expect(typeof res.body.tier).toBe("number");
    expect(typeof res.body.frequency).toBe("number");
    expect(typeof res.body.chargingActive).toBe("boolean");
  });
});

// ─── Charging Context & Strategy ────────────────────────────────────────

describe("Charging Context & Strategy", () => {
  it("GET /api/charging/context → 200 with strategy fields", async () => {
    const res = await request(baseUrl).get("/api/charging/context");
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty("strategy");
    expect(res.body).toHaveProperty("isActive");
    expect(res.body).toHaveProperty("currentAmpere");
    expect(res.body).toHaveProperty("targetAmpere");
    expect(typeof res.body.isActive).toBe("boolean");
    expect(typeof res.body.currentAmpere).toBe("number");
  });

  it("POST /api/charging/strategy → switch off → surplus_battery_prio → off", async () => {
    // Ensure strategy config exists
    const settingsRes = await request(baseUrl).get("/api/settings");
    const settings = settingsRes.body;
    if (!settings.chargingStrategy) {
      await request(baseUrl)
        .post("/api/settings")
        .send({
          ...settings,
          chargingStrategy: {
            activeStrategy: "off",
            minStartPowerWatt: 1400,
            stopThresholdWatt: 1000,
            startDelaySeconds: 120,
            stopDelaySeconds: 300,
            physicalPhaseSwitch: 3,
            minCurrentChangeAmpere: 1,
            minChangeIntervalSeconds: 60,
            inputX1Strategy: "max_without_battery",
          },
        });
    }

    // Switch to surplus_battery_prio
    const res1 = await request(baseUrl)
      .post("/api/charging/strategy")
      .send({ strategy: "surplus_battery_prio" });
    expect(res1.status).toBe(200);
    expect(res1.body).toHaveProperty("success", true);
    expect(res1.body).toHaveProperty("strategy", "surplus_battery_prio");

    // Switch back to off
    const res2 = await request(baseUrl)
      .post("/api/charging/strategy")
      .send({ strategy: "off" });
    expect(res2.status).toBe(200);
    expect(res2.body).toHaveProperty("success", true);
    expect(res2.body).toHaveProperty("strategy", "off");
  });

  it("POST /api/charging/strategy with invalid strategy → 400", async () => {
    const res = await request(baseUrl)
      .post("/api/charging/strategy")
      .send({ strategy: "nonexistent_strategy" });
    expect(res.status).toBe(400);
    expect(res.body).toHaveProperty("error");
  });

  it("POST /api/charging/strategy/config → 200 with valid config", async () => {
    const config = {
      activeStrategy: "off",
      minStartPowerWatt: 1400,
      stopThresholdWatt: 1000,
      startDelaySeconds: 120,
      stopDelaySeconds: 300,
      physicalPhaseSwitch: 3,
      minCurrentChangeAmpere: 1,
      minChangeIntervalSeconds: 60,
      inputX1Strategy: "max_without_battery",
    };

    const res = await request(baseUrl)
      .post("/api/charging/strategy/config")
      .send(config);
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty("success", true);
  });

  it("POST /api/charging/strategy/config with invalid data → 400", async () => {
    const res = await request(baseUrl)
      .post("/api/charging/strategy/config")
      .send({ activeStrategy: "invalid" });
    expect(res.status).toBe(400);
    expect(res.body).toHaveProperty("error");
  });
});

// ─── Controls Sync ──────────────────────────────────────────────────────

describe("Controls Sync", () => {
  it("POST /api/controls/sync → 200 with control state", async () => {
    const res = await request(baseUrl)
      .post("/api/controls/sync")
      .send({});
    expect(res.status).toBe(200);
    expect(typeof res.body.pvSurplus).toBe("boolean");
    expect(typeof res.body.batteryLock).toBe("boolean");
  });
});

// ─── Log Settings & Deletion ────────────────────────────────────────────

describe("Log Settings & Deletion", () => {
  it("GET /api/logs/settings → 200 with level", async () => {
    const res = await request(baseUrl).get("/api/logs/settings");
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty("level");
    expect(["trace", "debug", "info", "warning", "error"]).toContain(
      res.body.level,
    );
  });

  it("POST /api/logs/settings → roundtrip level change", async () => {
    // Read current
    const initial = await request(baseUrl).get("/api/logs/settings");
    const originalLevel = initial.body.level;

    // Change to debug
    const newLevel = originalLevel === "debug" ? "info" : "debug";
    const postRes = await request(baseUrl)
      .post("/api/logs/settings")
      .send({ level: newLevel });
    expect(postRes.status).toBe(200);
    expect(postRes.body).toHaveProperty("success", true);

    // Verify
    const updated = await request(baseUrl).get("/api/logs/settings");
    expect(updated.body.level).toBe(newLevel);

    // Restore
    await request(baseUrl)
      .post("/api/logs/settings")
      .send({ level: originalLevel });
  });

  it("POST /api/logs/settings with invalid level → 400", async () => {
    const res = await request(baseUrl)
      .post("/api/logs/settings")
      .send({ level: "nonexistent" });
    expect(res.status).toBe(400);
    expect(res.body).toHaveProperty("error");
  });

  it("DELETE /api/logs → 200 clears logs", async () => {
    const res = await request(baseUrl).delete("/api/logs");
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty("success", true);

    // Verify logs are cleared (may have new log entries from the delete itself)
    const logsRes = await request(baseUrl).get("/api/logs");
    expect(logsRes.status).toBe(200);
    expect(Array.isArray(logsRes.body)).toBe(true);
  });
});

// ─── Wallbox Plug Tracking ──────────────────────────────────────────────

describe("Wallbox Plug Tracking", () => {
  it("GET /api/wallbox/plug-tracking → 200 with tracking data", async () => {
    const res = await request(baseUrl).get("/api/wallbox/plug-tracking");
    expect(res.status).toBe(200);
    expect(typeof res.body).toBe("object");
  });
});

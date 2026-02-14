import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import type { Server } from "http";
import type { AddressInfo } from "net";

/**
 * Integration tests for the EnergyLink API in demo mode.
 * Starts the actual Express server with DEMO_AUTOSTART=true.
 * No mocks — exercises real routes, storage, and mock-wallbox.
 */

let server: Server;
let baseUrl: string;

// Increase timeout for server startup
const SERVER_START_TIMEOUT = 30_000;

beforeAll(async () => {
  // Set demo mode environment
  process.env.DEMO_AUTOSTART = "true";
  process.env.NODE_ENV = "production"; // skip Vite dev setup
  process.env.PORT = "0"; // random port

  // Dynamically import and bootstrap the server
  const express = (await import("express")).default;
  const { healthHandler } = await import("../core/health");
  const { registerRoutes } = await import("../routes/index");
  const { storage } = await import("../core/storage");
  const { startUnifiedMock } = await import("../demo/unified-mock");

  const app = express();
  app.use(express.json());

  // Health endpoint (before auth, matching server/index.ts)
  app.get("/api/health", healthHandler);

  // Ensure demo mode settings exist
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

  // Start mock wallbox
  await startUnifiedMock();

  // Register all API routes (settings, wallbox, status, e3dc)
  server = await registerRoutes(app);

  // Listen on random port
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
  // Stop mock
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
});

// ─── Health & Status ────────────────────────────────────────────────────

describe("Health & Status", () => {
  it("GET /api/health → 200 with status/version/uptime", async () => {
    const res = await request(baseUrl).get("/api/health");
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty("status", "ok");
    expect(res.body).toHaveProperty("version");
    expect(res.body).toHaveProperty("uptime");
    expect(typeof res.body.uptime).toBe("number");
  });

  it("GET /api/status → 200 with settings/controls/timestamp", async () => {
    const res = await request(baseUrl).get("/api/status");
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty("settings");
    expect(res.body).toHaveProperty("controls");
    expect(res.body).toHaveProperty("timestamp");
    expect(res.body).toHaveProperty("buildInfo");
  });
});

// ─── Settings Roundtrip ─────────────────────────────────────────────────

describe("Settings Roundtrip", () => {
  it("GET → POST (modify) → GET verifies change", async () => {
    // 1. Read current settings
    const initial = await request(baseUrl).get("/api/settings");
    expect(initial.status).toBe(200);

    // 2. Modify a non-critical value and POST back
    const modified = {
      ...initial.body,
      mockWallboxPhases: initial.body.mockWallboxPhases === 1 ? 3 : 1,
    };
    const postRes = await request(baseUrl)
      .post("/api/settings")
      .send(modified);
    expect(postRes.status).toBe(200);
    expect(postRes.body).toHaveProperty("success", true);

    // 3. Read again and verify
    const updated = await request(baseUrl).get("/api/settings");
    expect(updated.status).toBe(200);
    expect(updated.body.mockWallboxPhases).toBe(modified.mockWallboxPhases);

    // 4. Restore original value
    await request(baseUrl)
      .post("/api/settings")
      .send({ ...updated.body, mockWallboxPhases: initial.body.mockWallboxPhases });
  });
});

// ─── Wallbox Control ────────────────────────────────────────────────────

describe("Wallbox Control", () => {
  it("GET /api/wallbox/status → 200 with expected fields", async () => {
    const res = await request(baseUrl).get("/api/wallbox/status");
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty("state");
    expect(res.body).toHaveProperty("plug");
    expect(res.body).toHaveProperty("enableSys");
    expect(res.body).toHaveProperty("maxCurr");
    expect(res.body).toHaveProperty("lastUpdated");
  });

  it("POST /api/wallbox/start → 200", async () => {
    const res = await request(baseUrl)
      .post("/api/wallbox/start")
      .send({});
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty("success", true);
  });

  it("POST /api/wallbox/stop → 200", async () => {
    const res = await request(baseUrl)
      .post("/api/wallbox/stop")
      .send({});
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty("success", true);
  });

  it("POST /api/wallbox/current with valid value → 200", async () => {
    const res = await request(baseUrl)
      .post("/api/wallbox/current")
      .send({ current: 10 });
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty("success", true);
  });
});

// ─── Input Validation ───────────────────────────────────────────────────

describe("Input Validation", () => {
  it("POST /api/wallbox/current with value < 6 → 400", async () => {
    const res = await request(baseUrl)
      .post("/api/wallbox/current")
      .send({ current: 3 });
    expect(res.status).toBe(400);
  });

  it("POST /api/wallbox/current with value > 32 → 400", async () => {
    const res = await request(baseUrl)
      .post("/api/wallbox/current")
      .send({ current: 50 });
    expect(res.status).toBe(400);
  });

  it("POST /api/wallbox/current with non-number → 400", async () => {
    const res = await request(baseUrl)
      .post("/api/wallbox/current")
      .send({ current: "abc" });
    expect(res.status).toBe(400);
  });

  it("POST /api/settings with invalid data → 400", async () => {
    const res = await request(baseUrl)
      .post("/api/settings")
      .send({ wallboxIp: 12345 }); // wallboxIp should be string
    expect(res.status).toBe(400);
  });

  it("POST /api/controls with invalid data → 400", async () => {
    const res = await request(baseUrl)
      .post("/api/controls")
      .send({ pvSurplus: "not-a-boolean" });
    expect(res.status).toBe(400);
  });

  it("POST /api/wallbox/demo-input with invalid input → 400", async () => {
    const res = await request(baseUrl)
      .post("/api/wallbox/demo-input")
      .send({ input: 5 }); // only 0 or 1 allowed
    expect(res.status).toBe(400);
  });
});

// ─── Build Info & Logs ──────────────────────────────────────────────────

describe("Build Info & Logs", () => {
  it("GET /api/build-info → 200 with version", async () => {
    const res = await request(baseUrl).get("/api/build-info");
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty("version");
  });

  it("GET /api/logs → 200 with array", async () => {
    const res = await request(baseUrl).get("/api/logs");
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
  });

  it("GET /api/controls → 200 with boolean fields", async () => {
    const res = await request(baseUrl).get("/api/controls");
    expect(res.status).toBe(200);
    expect(typeof res.body.pvSurplus).toBe("boolean");
    expect(typeof res.body.batteryLock).toBe("boolean");
  });
});

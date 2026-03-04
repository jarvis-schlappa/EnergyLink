import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync } from "fs";
import { join } from "path";
import os from "os";
import request from "supertest";
import { createServer, type Server } from "http";
import type { AddressInfo } from "net";

/**
 * Integration tests for GET /api/e3dc/history endpoint.
 * Exercises real routes in demo mode with MockE3dcGateway.
 */

let server: Server;
let baseUrl: string;
let tmpDataDir: string;
const originalDataDir = join(process.cwd(), "data");

const SERVER_START_TIMEOUT = 30_000;

beforeAll(async () => {
  tmpDataDir = mkdtempSync(join(os.tmpdir(), "energylink-test-history-"));
  process.env.DEMO_AUTOSTART = "true";
  process.env.NODE_ENV = "production";
  process.env.PORT = "0";

  const express = (await import("express")).default;
  const { healthHandler } = await import("../core/health");
  const { registerRoutes } = await import("../routes/index");
  const { storage } = await import("../core/storage");
  storage.reinitialize(tmpDataDir);
  const { startUnifiedMock } = await import("../demo/unified-mock");

  // Set up MockE3dcGateway (like server/index.ts does in demo mode)
  const { e3dcClient } = await import("../e3dc/client");
  const { MockE3dcGateway } = await import("../e3dc/gateway");
  e3dcClient.setGateway(new MockE3dcGateway());

  const app = express();
  app.use(express.json());
  app.get("/api/health", healthHandler);

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
  } catch { /* ignore */ }
  try {
    const { shutdownSchedulers } = await import("../routes/index");
    await shutdownSchedulers();
  } catch { /* ignore */ }
  const { storage } = await import("../core/storage");
  storage.reinitialize(originalDataDir);
  try { rmSync(tmpDataDir, { recursive: true, force: true }); } catch { /* ignore */ }
});

// ─── Helper: Enable/Disable E3DC ────────────────────────────────────────

async function ensureE3dcEnabled(): Promise<void> {
  const settingsRes = await request(baseUrl).get("/api/settings");
  const settings = settingsRes.body;
  if (!settings.e3dc?.enabled) {
    await request(baseUrl)
      .post("/api/settings")
      .send({ ...settings, e3dc: { ...settings.e3dc, enabled: true } });
  }
}

async function ensureE3dcDisabled(): Promise<void> {
  const settingsRes = await request(baseUrl).get("/api/settings");
  const settings = settingsRes.body;
  await request(baseUrl)
    .post("/api/settings")
    .send({ ...settings, e3dc: { ...settings.e3dc, enabled: false } });
}

// ─── E3DC History Endpoint ──────────────────────────────────────────────

describe("GET /api/e3dc/history", () => {
  // In demo mode, MockE3dcGateway returns empty output for -H commands.
  // The endpoint gracefully handles this: JSON.parse fails → data: {}
  // So valid requests return 200 with data: {}

  it("default period=day → 200 with period/date/data", async () => {
    await ensureE3dcEnabled();
    const res = await request(baseUrl).get("/api/e3dc/history");
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty("period", "day");
    expect(res.body).toHaveProperty("date");
    expect(res.body.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(res.body).toHaveProperty("data");
  });

  it("period=day → 200", async () => {
    await ensureE3dcEnabled();
    const res = await request(baseUrl).get("/api/e3dc/history?period=day");
    expect(res.status).toBe(200);
    expect(res.body.period).toBe("day");
  });

  it("period=week → 200", async () => {
    await ensureE3dcEnabled();
    const res = await request(baseUrl).get("/api/e3dc/history?period=week");
    expect(res.status).toBe(200);
    expect(res.body.period).toBe("week");
  });

  it("period=month → 200", async () => {
    await ensureE3dcEnabled();
    const res = await request(baseUrl).get("/api/e3dc/history?period=month");
    expect(res.status).toBe(200);
    expect(res.body.period).toBe("month");
  });

  it("period=year → 200", async () => {
    await ensureE3dcEnabled();
    const res = await request(baseUrl).get("/api/e3dc/history?period=year");
    expect(res.status).toBe(200);
    expect(res.body.period).toBe("year");
  });

  it("period=day with date=2026-03-01 → 200 with correct date", async () => {
    await ensureE3dcEnabled();
    const res = await request(baseUrl).get("/api/e3dc/history?period=day&date=2026-03-01");
    expect(res.status).toBe(200);
    expect(res.body.period).toBe("day");
    expect(res.body.date).toBe("2026-03-01");
  });

  it("no period → defaults to day", async () => {
    await ensureE3dcEnabled();
    const res = await request(baseUrl).get("/api/e3dc/history");
    expect(res.status).toBe(200);
    expect(res.body.period).toBe("day");
  });

  // ─── Error Cases ────────────────────────────────────────────────────

  it("period=century → 400", async () => {
    await ensureE3dcEnabled();
    const res = await request(baseUrl).get("/api/e3dc/history?period=century");
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/Ungültiger period-Wert/);
  });

  it("period=<empty string> → defaults to day (falsy)", async () => {
    await ensureE3dcEnabled();
    // Empty string is falsy in JS → falls back to "day" default
    const res = await request(baseUrl).get("/api/e3dc/history?period=");
    expect(res.status).toBe(200);
    expect(res.body.period).toBe("day");
  });

  it("date=blabla → 400", async () => {
    await ensureE3dcEnabled();
    const res = await request(baseUrl).get("/api/e3dc/history?period=day&date=blabla");
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/Ungültiges Datumsformat/);
  });

  it("date=2026-13-01 (invalid month) → 400", async () => {
    await ensureE3dcEnabled();
    const res = await request(baseUrl).get("/api/e3dc/history?period=day&date=2026-13-01");
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/Ungültiges Datum/);
  });

  it("date=not-a-date → 400 (format check)", async () => {
    await ensureE3dcEnabled();
    const res = await request(baseUrl).get("/api/e3dc/history?date=not-a-date");
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/Ungültiges Datumsformat/);
  });

  it("e3dc disabled → 400", async () => {
    await ensureE3dcDisabled();
    const res = await request(baseUrl).get("/api/e3dc/history?period=day");
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/nicht aktiviert/i);

    // Re-enable for subsequent tests
    await ensureE3dcEnabled();
  });

  // ─── Security ───────────────────────────────────────────────────────

  it("date with shell injection attempt → 400", async () => {
    await ensureE3dcEnabled();
    const res = await request(baseUrl).get("/api/e3dc/history?period=day&date=2026-01-01;rm%20-rf");
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/Ungültiges Datumsformat/);
  });

  it("period with injection attempt → 400", async () => {
    await ensureE3dcEnabled();
    const res = await request(baseUrl).get("/api/e3dc/history?period=day;cat%20/etc/passwd");
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/Ungültiger period-Wert/);
  });
});

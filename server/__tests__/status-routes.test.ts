import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock dependencies before importing the module under test
vi.mock("../storage", () => ({
  storage: {
    getSettings: vi.fn(() => ({
      wallboxIp: "192.168.40.16",
      e3dcIp: "192.168.40.10",
      demoMode: false,
    })),
    getControlState: vi.fn(() => ({
      pvSurplus: false,
      batteryLock: false,
      nightCharging: false,
      gridCharging: false,
    })),
    getPlugStatusTracking: vi.fn(() => ({
      lastPlugStatus: 7,
      lastPlugChange: "2026-02-13T19:00:00.000Z",
    })),
    getChargingContext: vi.fn(() => ({
      isActive: false,
      strategy: "off",
      currentAmpere: 0,
      targetAmpere: 0,
    })),
  },
}));

vi.mock("../e3dc-modbus", () => ({
  getE3dcModbusService: vi.fn(() => ({
    getLastReadLiveData: vi.fn(() => ({
      pvPower: 3500,
      batteryPower: 1200,
      batterySoc: 72,
      housePower: 800,
      gridPower: -1500,
      wallboxPower: 0,
    })),
  })),
}));

vi.mock("../grid-frequency-monitor", () => ({
  getGridFrequencyState: vi.fn(() => ({
    enabled: true,
    frequency: 50.01,
    lastUpdate: "2026-02-13T19:00:00.000Z",
  })),
}));

vi.mock("../build-info", () => ({
  getBuildInfo: vi.fn(() => ({
    version: "1.0.0",
    buildDate: "2026-02-13",
  })),
}));

vi.mock("../logger", () => ({
  log: vi.fn(),
}));

import express from "express";
import request from "supertest";
import { registerStatusRoutes } from "../routes/status-routes";

describe("/api/status", () => {
  let app: express.Express;

  beforeEach(() => {
    app = express();
    app.use(express.json());
    registerStatusRoutes(app);
  });

  it("returns consolidated status with all expected fields", async () => {
    const res = await request(app).get("/api/status").expect(200);

    expect(res.body).toHaveProperty("settings");
    expect(res.body).toHaveProperty("controls");
    expect(res.body).toHaveProperty("plugTracking");
    expect(res.body).toHaveProperty("chargingContext");
    expect(res.body).toHaveProperty("e3dcLiveData");
    expect(res.body).toHaveProperty("gridFrequency");
    expect(res.body).toHaveProperty("buildInfo");
    expect(res.body).toHaveProperty("timestamp");
  });

  it("returns correct settings data", async () => {
    const res = await request(app).get("/api/status").expect(200);

    expect(res.body.settings.wallboxIp).toBe("192.168.40.16");
  });

  it("returns correct control state", async () => {
    const res = await request(app).get("/api/status").expect(200);

    expect(res.body.controls.pvSurplus).toBe(false);
    expect(res.body.controls.nightCharging).toBe(false);
  });

  it("returns correct E3DC live data from cache", async () => {
    const res = await request(app).get("/api/status").expect(200);

    expect(res.body.e3dcLiveData.pvPower).toBe(3500);
    expect(res.body.e3dcLiveData.batterySoc).toBe(72);
  });

  it("returns correct charging context", async () => {
    const res = await request(app).get("/api/status").expect(200);

    expect(res.body.chargingContext.strategy).toBe("off");
    expect(res.body.chargingContext.isActive).toBe(false);
  });

  it("returns ISO timestamp", async () => {
    const res = await request(app).get("/api/status").expect(200);

    expect(() => new Date(res.body.timestamp)).not.toThrow();
    expect(new Date(res.body.timestamp).toISOString()).toBe(res.body.timestamp);
  });

  it("returns null e3dcLiveData when cache is empty", async () => {
    const { getE3dcModbusService } = await import("../e3dc-modbus");
    (getE3dcModbusService as any).mockReturnValueOnce({
      getLastReadLiveData: () => null,
    });

    const res = await request(app).get("/api/status").expect(200);

    expect(res.body.e3dcLiveData).toBeNull();
  });
});

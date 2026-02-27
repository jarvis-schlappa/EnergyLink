import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import express from "express";
import supertest from "supertest";
import type { Settings } from "@shared/schema";

// Mock web-push
vi.mock("web-push", () => ({
  default: {
    generateVAPIDKeys: vi.fn(() => ({
      publicKey: "test-public-key",
      privateKey: "test-private-key",
    })),
    setVapidDetails: vi.fn(),
    sendNotification: vi.fn().mockResolvedValue({}),
  },
}));

// Mock storage
let mockSettings: Settings = {
  wallboxIp: "127.0.0.1",
  webPush: {
    enabled: true,
    vapidPublicKey: "test-public-key",
    vapidPrivateKey: "test-private-key",
    subscriptions: [],
  },
};

vi.mock("../core/storage", () => ({
  storage: {
    getSettings: vi.fn(() => mockSettings),
    saveSettings: vi.fn((s: Settings) => { mockSettings = s; }),
  },
}));

vi.mock("../core/logger", () => ({
  log: vi.fn(),
}));

import { registerPushRoutes } from "../routes/push-routes";

function createApp() {
  const app = express();
  app.use(express.json());
  registerPushRoutes(app);
  return app;
}

describe("Push Routes", () => {
  let app: express.Express;

  beforeEach(() => {
    vi.clearAllMocks();
    mockSettings = {
      wallboxIp: "127.0.0.1",
      webPush: {
        enabled: true,
        vapidPublicKey: "test-public-key",
        vapidPrivateKey: "test-private-key",
        subscriptions: [],
      },
    };
    app = createApp();
  });

  describe("GET /api/push/vapid-key", () => {
    it("should return the public key", async () => {
      const res = await supertest(app).get("/api/push/vapid-key");
      expect(res.status).toBe(200);
      expect(res.body.publicKey).toBe("test-public-key");
    });

    it("should NOT return the private key", async () => {
      const res = await supertest(app).get("/api/push/vapid-key");
      expect(res.body.privateKey).toBeUndefined();
    });
  });

  describe("POST /api/push/subscribe", () => {
    it("should save a valid subscription", async () => {
      const res = await supertest(app)
        .post("/api/push/subscribe")
        .send({
          endpoint: "https://fcm.googleapis.com/test",
          keys: { p256dh: "key1", auth: "key2" },
          label: "Test Browser",
        });
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
    });

    it("should reject subscription without endpoint", async () => {
      const res = await supertest(app)
        .post("/api/push/subscribe")
        .send({ keys: { p256dh: "key1", auth: "key2" } });
      expect(res.status).toBe(400);
    });

    it("should reject subscription without keys", async () => {
      const res = await supertest(app)
        .post("/api/push/subscribe")
        .send({ endpoint: "https://example.com" });
      expect(res.status).toBe(400);
    });
  });

  describe("DELETE /api/push/subscribe", () => {
    it("should remove an existing subscription", async () => {
      mockSettings.webPush!.subscriptions = [
        {
          endpoint: "https://fcm.googleapis.com/test",
          keys: { p256dh: "key1", auth: "key2" },
          createdAt: "2025-01-01T00:00:00.000Z",
        },
      ];

      const res = await supertest(app)
        .delete("/api/push/subscribe")
        .send({ endpoint: "https://fcm.googleapis.com/test" });
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
    });

    it("should return 404 for non-existent subscription", async () => {
      const res = await supertest(app)
        .delete("/api/push/subscribe")
        .send({ endpoint: "https://does-not-exist.com" });
      expect(res.status).toBe(404);
    });

    it("should reject without endpoint", async () => {
      const res = await supertest(app)
        .delete("/api/push/subscribe")
        .send({});
      expect(res.status).toBe(400);
    });
  });

  describe("POST /api/push/test", () => {
    it("should reject when web push disabled", async () => {
      mockSettings.webPush!.enabled = false;
      const res = await supertest(app).post("/api/push/test");
      expect(res.status).toBe(400);
    });

    it("should reject when no subscriptions", async () => {
      mockSettings.webPush!.subscriptions = [];
      const res = await supertest(app).post("/api/push/test");
      expect(res.status).toBe(400);
    });

    it("should send test notification when subscriptions exist", async () => {
      mockSettings.webPush!.subscriptions = [
        {
          endpoint: "https://fcm.googleapis.com/test",
          keys: { p256dh: "key1", auth: "key2" },
          createdAt: "2025-01-01T00:00:00.000Z",
        },
      ];
      const res = await supertest(app).post("/api/push/test");
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
    });
  });
});

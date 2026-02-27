import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { Settings } from "@shared/schema";
import { webPushSchema, webPushSubscriptionSchema } from "@shared/schema";

// Mock web-push before importing service
vi.mock("web-push", () => ({
  default: {
    generateVAPIDKeys: vi.fn(() => ({
      publicKey: "BEl62iUYgUivxIkv69yViEuiBIa-Ib9-SkvMeAtA3LFgDzkOs-N0oOmjLGNkq2Ps",
      privateKey: "Dl1johMVwSfp5HiwJiAgGeOqc8B-eZBkHDCy_Yak06k",
    })),
    setVapidDetails: vi.fn(),
    sendNotification: vi.fn().mockResolvedValue({}),
  },
}));

// Mock storage
const mockSettings: Settings = {
  wallboxIp: "127.0.0.1",
  webPush: {
    enabled: true,
    vapidPublicKey: "BEl62iUYgUivxIkv69yViEuiBIa-Ib9-SkvMeAtA3LFgDzkOs-N0oOmjLGNkq2Ps",
    vapidPrivateKey: "Dl1johMVwSfp5HiwJiAgGeOqc8B-eZBkHDCy_Yak06k",
    subscriptions: [
      {
        endpoint: "https://fcm.googleapis.com/fcm/send/test-endpoint-1",
        keys: { p256dh: "test-p256dh", auth: "test-auth" },
        label: "Chrome Desktop",
        createdAt: "2025-01-01T00:00:00.000Z",
      },
    ],
  },
};

let savedSettings: Settings = { ...mockSettings };

vi.mock("../core/storage", () => ({
  storage: {
    getSettings: vi.fn(() => savedSettings),
    saveSettings: vi.fn((s: Settings) => { savedSettings = s; }),
  },
}));

vi.mock("../core/logger", () => ({
  log: vi.fn(),
}));

import {
  ensureVapidKeys,
  getVapidPublicKey,
  addSubscription,
  removeSubscription,
  sendPushNotification,
} from "../push/web-push-service";
import webPush from "web-push";
import { storage } from "../core/storage";

describe("Web Push Service", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    savedSettings = JSON.parse(JSON.stringify(mockSettings));
  });

  describe("Schema Validation", () => {
    it("should validate a valid webPush config", () => {
      const result = webPushSchema.safeParse({
        enabled: true,
        vapidPublicKey: "test-key",
        vapidPrivateKey: "test-private",
        subscriptions: [
          {
            endpoint: "https://example.com/push",
            keys: { p256dh: "key1", auth: "key2" },
            createdAt: "2025-01-01T00:00:00.000Z",
          },
        ],
      });
      expect(result.success).toBe(true);
    });

    it("should validate minimal webPush config", () => {
      const result = webPushSchema.safeParse({ enabled: false });
      expect(result.success).toBe(true);
    });

    it("should reject invalid subscription (missing keys)", () => {
      const result = webPushSubscriptionSchema.safeParse({
        endpoint: "https://example.com",
        createdAt: "2025-01-01",
      });
      expect(result.success).toBe(false);
    });

    it("should reject subscription with missing auth key", () => {
      const result = webPushSubscriptionSchema.safeParse({
        endpoint: "https://example.com",
        keys: { p256dh: "key1" },
        createdAt: "2025-01-01",
      });
      expect(result.success).toBe(false);
    });
  });

  describe("ensureVapidKeys", () => {
    it("should return existing keys from settings", () => {
      const keys = ensureVapidKeys();
      expect(keys.publicKey).toBe(mockSettings.webPush!.vapidPublicKey);
      expect(keys.privateKey).toBe(mockSettings.webPush!.vapidPrivateKey);
      expect(webPush.generateVAPIDKeys).not.toHaveBeenCalled();
    });

    it("should generate new keys if none exist", () => {
      savedSettings = { wallboxIp: "127.0.0.1", webPush: { enabled: false } };
      const keys = ensureVapidKeys();
      expect(webPush.generateVAPIDKeys).toHaveBeenCalled();
      expect(keys.publicKey).toBeDefined();
      expect(storage.saveSettings).toHaveBeenCalled();
    });
  });

  describe("getVapidPublicKey", () => {
    it("should return only the public key", () => {
      const key = getVapidPublicKey();
      expect(key).toBe(mockSettings.webPush!.vapidPublicKey);
    });
  });

  describe("addSubscription", () => {
    it("should add a new subscription", () => {
      addSubscription(
        { endpoint: "https://new-endpoint.com", keys: { p256dh: "new-p256dh", auth: "new-auth" } },
        "Firefox",
      );
      expect(storage.saveSettings).toHaveBeenCalled();
      const saved = (storage.saveSettings as any).mock.calls[0][0];
      expect(saved.webPush.subscriptions).toHaveLength(2);
    });

    it("should deduplicate by endpoint", () => {
      addSubscription(
        { endpoint: "https://fcm.googleapis.com/fcm/send/test-endpoint-1", keys: { p256dh: "updated", auth: "updated" } },
        "Updated",
      );
      expect(storage.saveSettings).toHaveBeenCalled();
      const saved = (storage.saveSettings as any).mock.calls[0][0];
      expect(saved.webPush.subscriptions).toHaveLength(1);
      expect(saved.webPush.subscriptions[0].keys.p256dh).toBe("updated");
    });
  });

  describe("removeSubscription", () => {
    it("should remove existing subscription", () => {
      const result = removeSubscription("https://fcm.googleapis.com/fcm/send/test-endpoint-1");
      expect(result).toBe(true);
      const saved = (storage.saveSettings as any).mock.calls[0][0];
      expect(saved.webPush.subscriptions).toHaveLength(0);
    });

    it("should return false for non-existent endpoint", () => {
      const result = removeSubscription("https://does-not-exist.com");
      expect(result).toBe(false);
    });
  });

  describe("sendPushNotification", () => {
    it("should send to all subscriptions", async () => {
      const result = await sendPushNotification("Test", "Body");
      expect(result.sent).toBe(1);
      expect(result.failed).toBe(0);
      expect(webPush.sendNotification).toHaveBeenCalledTimes(1);
    });

    it("should return zeros when webPush disabled", async () => {
      savedSettings = { wallboxIp: "127.0.0.1", webPush: { enabled: false } };
      const result = await sendPushNotification("Test", "Body");
      expect(result.sent).toBe(0);
      expect(result.failed).toBe(0);
    });

    it("should return zeros when no subscriptions", async () => {
      savedSettings = { wallboxIp: "127.0.0.1", webPush: { enabled: true, subscriptions: [] } };
      const result = await sendPushNotification("Test", "Body");
      expect(result.sent).toBe(0);
    });

    it("should clean up expired subscriptions (410 Gone)", async () => {
      (webPush.sendNotification as any).mockRejectedValueOnce({ statusCode: 410 });
      const result = await sendPushNotification("Test", "Body");
      expect(result.failed).toBe(1);
      // Should have saved cleaned subscriptions
      const saveCalls = (storage.saveSettings as any).mock.calls;
      const lastSave = saveCalls[saveCalls.length - 1][0];
      expect(lastSave.webPush.subscriptions).toHaveLength(0);
    });
  });
});

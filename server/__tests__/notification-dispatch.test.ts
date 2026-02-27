import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Settings } from "@shared/schema";

// Mock web-push-service
vi.mock("../push/web-push-service", () => ({
  sendPushNotification: vi.fn().mockResolvedValue({ sent: 1, failed: 0 }),
}));

// Mock logger
vi.mock("../core/logger", () => ({
  log: vi.fn(),
}));

import { triggerProwlEvent, triggerNotification, initializeProwlNotifier } from "../monitoring/prowl-notifier";
import { sendPushNotification } from "../push/web-push-service";

describe("Notification Dispatch", () => {
  const baseSettings: Settings = {
    wallboxIp: "127.0.0.1",
    prowl: {
      enabled: true,
      apiKey: "test-key",
      events: {
        appStarted: true,
        chargingStarted: true,
        chargingStopped: false,
        currentAdjusted: false,
        plugConnected: false,
        plugDisconnected: false,
        batteryLockActivated: false,
        batteryLockDeactivated: false,
        gridChargingActivated: false,
        gridChargingDeactivated: false,
        strategyChanged: false,
        errors: false,
      },
    },
    webPush: {
      enabled: true,
    },
  };

  beforeEach(() => {
    vi.clearAllMocks();
    // Initialize prowl notifier so getProwlNotifier() doesn't throw
    initializeProwlNotifier(baseSettings);
  });

  it("triggerProwlEvent should be an alias for triggerNotification", () => {
    expect(triggerProwlEvent).toBe(triggerNotification);
  });

  it("should fire both Prowl and Web Push when both enabled", () => {
    const prowlAction = vi.fn().mockResolvedValue(undefined);
    triggerNotification(baseSettings, "chargingStarted", prowlAction);

    expect(prowlAction).toHaveBeenCalled();
    expect(sendPushNotification).toHaveBeenCalledWith("Ladung gestartet", "EnergyLink");
  });

  it("should only fire Prowl when webPush disabled", () => {
    const settings: Settings = {
      ...baseSettings,
      webPush: { enabled: false },
    };
    const prowlAction = vi.fn().mockResolvedValue(undefined);
    triggerNotification(settings, "chargingStarted", prowlAction);

    expect(prowlAction).toHaveBeenCalled();
    expect(sendPushNotification).not.toHaveBeenCalled();
  });

  it("should only fire Web Push when Prowl disabled", () => {
    const settings: Settings = {
      ...baseSettings,
      prowl: { ...baseSettings.prowl!, enabled: false },
    };
    const prowlAction = vi.fn().mockResolvedValue(undefined);
    triggerNotification(settings, "chargingStarted", prowlAction);

    // Prowl disabled → action not called
    expect(prowlAction).not.toHaveBeenCalled();
    expect(sendPushNotification).toHaveBeenCalledWith("Ladung gestartet", "EnergyLink");
  });

  it("should not fire anything when event is disabled", () => {
    const prowlAction = vi.fn().mockResolvedValue(undefined);
    triggerNotification(baseSettings, "chargingStopped", prowlAction);

    expect(prowlAction).not.toHaveBeenCalled();
    expect(sendPushNotification).not.toHaveBeenCalled();
  });

  it("should not fire anything when settings are null", () => {
    const prowlAction = vi.fn().mockResolvedValue(undefined);
    triggerNotification(null, "chargingStarted", prowlAction);

    expect(prowlAction).not.toHaveBeenCalled();
    expect(sendPushNotification).not.toHaveBeenCalled();
  });

  it("should not fire when no events object exists", () => {
    const settings: Settings = {
      wallboxIp: "127.0.0.1",
      prowl: { enabled: true, apiKey: "test", events: undefined as any },
      webPush: { enabled: true },
    };
    const prowlAction = vi.fn().mockResolvedValue(undefined);
    triggerNotification(settings, "chargingStarted", prowlAction);

    expect(prowlAction).not.toHaveBeenCalled();
    expect(sendPushNotification).not.toHaveBeenCalled();
  });

  it("should handle missing webPush in settings gracefully", () => {
    const settings: Settings = {
      ...baseSettings,
      webPush: undefined,
    };
    const prowlAction = vi.fn().mockResolvedValue(undefined);
    triggerNotification(settings, "chargingStarted", prowlAction);

    expect(prowlAction).toHaveBeenCalled();
    expect(sendPushNotification).not.toHaveBeenCalled();
  });
});

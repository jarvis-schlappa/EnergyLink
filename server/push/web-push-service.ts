import webPush from "web-push";
import type { Settings, WebPushSubscription } from "@shared/schema";
import { log } from "../core/logger";
import { storage } from "../core/storage";

/**
 * Generates VAPID keys and saves them to settings (once).
 * Returns the public key.
 */
export function ensureVapidKeys(): { publicKey: string; privateKey: string } {
  const settings = storage.getSettings();
  if (settings?.webPush?.vapidPublicKey && settings?.webPush?.vapidPrivateKey) {
    return {
      publicKey: settings.webPush.vapidPublicKey,
      privateKey: settings.webPush.vapidPrivateKey,
    };
  }

  const vapidKeys = webPush.generateVAPIDKeys();
  log("info", "system", "VAPID-Keys generiert");

  // Save keys to settings (preserve existing settings)
  const current = settings || {} as Settings;
  const webPushSettings = current.webPush || { enabled: false };
  storage.saveSettings({
    ...current,
    webPush: {
      ...webPushSettings,
      vapidPublicKey: vapidKeys.publicKey,
      vapidPrivateKey: vapidKeys.privateKey,
    },
  });

  return {
    publicKey: vapidKeys.publicKey,
    privateKey: vapidKeys.privateKey,
  };
}

/**
 * Returns the VAPID public key (generates if missing).
 * NEVER returns the private key.
 */
export function getVapidPublicKey(): string {
  return ensureVapidKeys().publicKey;
}

/**
 * Adds a push subscription to settings.
 */
export function addSubscription(subscription: Omit<WebPushSubscription, "createdAt">, label?: string): void {
  const settings = storage.getSettings();
  if (!settings) return;

  const webPushSettings = settings.webPush || { enabled: false };
  const existing = webPushSettings.subscriptions || [];

  // Deduplicate by endpoint
  const filtered = existing.filter((s) => s.endpoint !== subscription.endpoint);

  const newSub: WebPushSubscription = {
    endpoint: subscription.endpoint,
    keys: subscription.keys,
    label: label,
    createdAt: new Date().toISOString(),
  };

  storage.saveSettings({
    ...settings,
    webPush: {
      ...webPushSettings,
      subscriptions: [...filtered, newSub],
    },
  });

  log("info", "system", `Web Push Subscription hinzugefügt (${filtered.length + 1} aktiv)`);
}

/**
 * Removes a push subscription by endpoint.
 */
export function removeSubscription(endpoint: string): boolean {
  const settings = storage.getSettings();
  if (!settings?.webPush?.subscriptions) return false;

  const before = settings.webPush.subscriptions.length;
  const filtered = settings.webPush.subscriptions.filter((s) => s.endpoint !== endpoint);

  if (filtered.length === before) return false;

  storage.saveSettings({
    ...settings,
    webPush: {
      ...settings.webPush,
      subscriptions: filtered,
    },
  });

  log("info", "system", `Web Push Subscription entfernt (${filtered.length} verbleibend)`);
  return true;
}

/**
 * Sends a push notification to all stored subscriptions.
 * Automatically removes expired/invalid subscriptions (410 Gone).
 */
export async function sendPushNotification(
  title: string,
  body: string,
  data?: Record<string, string>,
): Promise<{ sent: number; failed: number }> {
  const settings = storage.getSettings();
  if (!settings?.webPush?.enabled) {
    return { sent: 0, failed: 0 };
  }

  const subscriptions = settings.webPush.subscriptions || [];
  if (subscriptions.length === 0) {
    return { sent: 0, failed: 0 };
  }

  const { publicKey, privateKey } = ensureVapidKeys();
  webPush.setVapidDetails("mailto:noreply@energylink.local", publicKey, privateKey);

  const payload = JSON.stringify({ title, body, data });
  let sent = 0;
  let failed = 0;
  const expiredEndpoints: string[] = [];

  await Promise.allSettled(
    subscriptions.map(async (sub) => {
      try {
        await webPush.sendNotification(
          {
            endpoint: sub.endpoint,
            keys: sub.keys,
          },
          payload,
        );
        sent++;
      } catch (error: unknown) {
        const statusCode = (error as { statusCode?: number })?.statusCode;
        if (statusCode === 410 || statusCode === 404) {
          // Subscription expired/invalid – mark for removal
          expiredEndpoints.push(sub.endpoint);
          log("debug", "system", `Web Push Subscription abgelaufen: ${sub.endpoint.slice(0, 50)}...`);
        } else {
          log("warning", "system", "Web Push fehlgeschlagen", (error as Error)?.message || String(error));
        }
        failed++;
      }
    }),
  );

  // Clean up expired subscriptions
  if (expiredEndpoints.length > 0) {
    const freshSettings = storage.getSettings();
    if (freshSettings?.webPush?.subscriptions) {
      const cleaned = freshSettings.webPush.subscriptions.filter(
        (s) => !expiredEndpoints.includes(s.endpoint),
      );
      storage.saveSettings({
        ...freshSettings,
        webPush: {
          ...freshSettings.webPush,
          subscriptions: cleaned,
        },
      });
      log("info", "system", `${expiredEndpoints.length} abgelaufene Web Push Subscriptions entfernt`);
    }
  }

  if (sent > 0) {
    log("debug", "system", `Web Push gesendet: ${sent}/${subscriptions.length}`);
  }

  return { sent, failed };
}

import type { Express } from "express";
import { log } from "../core/logger";
import { storage } from "../core/storage";
import {
  getVapidPublicKey,
  addSubscription,
  removeSubscription,
  sendPushNotification,
} from "../push/web-push-service";

export function registerPushRoutes(app: Express): void {
  // GET /api/push/vapid-key – Public Key for frontend (NEVER expose private key!)
  app.get("/api/push/vapid-key", (req, res) => {
    try {
      const publicKey = getVapidPublicKey();
      res.json({ publicKey });
    } catch (error) {
      log("error", "system", "Fehler beim Abrufen des VAPID Public Keys", error instanceof Error ? error.message : String(error));
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // POST /api/push/subscribe – Save subscription
  app.post("/api/push/subscribe", (req, res) => {
    try {
      const { endpoint, keys, label } = req.body;

      if (!endpoint || !keys?.p256dh || !keys?.auth) {
        return res.status(400).json({ error: "Ungültige Subscription: endpoint und keys (p256dh, auth) erforderlich" });
      }

      addSubscription({ endpoint, keys }, label);
      res.json({ success: true, message: "Subscription gespeichert" });
    } catch (error) {
      log("error", "system", "Fehler beim Speichern der Push Subscription", error instanceof Error ? error.message : String(error));
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // DELETE /api/push/subscribe – Remove subscription
  app.delete("/api/push/subscribe", (req, res) => {
    try {
      const { endpoint } = req.body;

      if (!endpoint) {
        return res.status(400).json({ error: "endpoint erforderlich" });
      }

      const removed = removeSubscription(endpoint);
      if (removed) {
        res.json({ success: true, message: "Subscription entfernt" });
      } else {
        res.status(404).json({ error: "Subscription nicht gefunden" });
      }
    } catch (error) {
      log("error", "system", "Fehler beim Entfernen der Push Subscription", error instanceof Error ? error.message : String(error));
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // POST /api/push/test – Send test notification
  app.post("/api/push/test", async (req, res) => {
    try {
      const settings = storage.getSettings();

      if (!settings?.webPush?.enabled) {
        return res.status(400).json({ error: "Web Push ist nicht aktiviert" });
      }

      const subscriptions = settings.webPush.subscriptions || [];
      if (subscriptions.length === 0) {
        return res.status(400).json({ error: "Keine Push-Subscriptions vorhanden. Aktiviere Browser-Benachrichtigungen zuerst." });
      }

      const result = await sendPushNotification(
        "EnergyLink Test",
        "Web Push-Benachrichtigungen sind korrekt konfiguriert!",
      );

      if (result.sent > 0) {
        log("info", "system", "Web Push Test-Benachrichtigung gesendet");
        res.json({ success: true, message: `Test an ${result.sent} Gerät(e) gesendet` });
      } else {
        res.status(500).json({ error: "Test-Benachrichtigung fehlgeschlagen – prüfe Subscriptions und Logs" });
      }
    } catch (error) {
      log("error", "system", "Fehler beim Senden der Web Push Test-Benachrichtigung", error instanceof Error ? error.message : String(error));
      res.status(500).json({ error: "Internal server error" });
    }
  });
}

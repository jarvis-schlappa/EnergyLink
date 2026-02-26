import type { Express } from "express";
import { storage } from "../core/storage";
import { log } from "../core/logger";
import { getGarageStatus, toggleGarage } from "../fhem/garage";

/** Separate cooldowns for manual toggle vs auto-close to prevent the manual
 *  toggle from blocking auto-close (see bug-report-2026-02-26-test3.md).
 *  Typical workflow: manual open → cable plug-in (<60s) → auto-close must fire. */
let lastManualToggleTime = 0;
let lastAutoCloseTime = 0;
const MANUAL_TOGGLE_COOLDOWN_MS = 20_000;
const AUTO_CLOSE_COOLDOWN_MS = 60_000;

export function registerGarageRoutes(app: Express): void {
  app.get("/api/garage/status", async (req, res) => {
    try {
      const settings = storage.getSettings();
      const host = settings?.fhemSync?.host;

      if (!host) {
        return res.status(400).json({ error: "FHEM host not configured" });
      }

      const status = await getGarageStatus(host);
      res.json(status);
    } catch (error) {
      log("error", "garage", "Fehler beim Abrufen des Garage-Status",
        error instanceof Error ? error.message : String(error));
      res.status(500).json({ error: "Failed to get garage status" });
    }
  });

  app.post("/api/garage/toggle", async (req, res) => {
    try {
      const settings = storage.getSettings();
      const host = settings?.fhemSync?.host;

      if (!host) {
        return res.status(400).json({ error: "FHEM host not configured" });
      }

      // Cooldown check (manual toggle only)
      const now = Date.now();
      if (now - lastManualToggleTime < MANUAL_TOGGLE_COOLDOWN_MS) {
        const remaining = Math.ceil((MANUAL_TOGGLE_COOLDOWN_MS - (now - lastManualToggleTime)) / 1000);
        log("warning", "garage", `Toggle abgelehnt – Cooldown aktiv (noch ${remaining}s)`);
        return res.status(429).json({ error: `Cooldown aktiv, bitte ${remaining}s warten` });
      }

      await toggleGarage(host);
      lastManualToggleTime = Date.now();
      res.json({ success: true });
    } catch (error) {
      log("error", "garage", "Fehler beim Auslösen des Garagentor-Tasters",
        error instanceof Error ? error.message : String(error));
      res.status(500).json({ error: "Failed to toggle garage" });
    }
  });
}

/**
 * Auto-Close Logic: Wird aufgerufen wenn Plug-Status von <5 auf ≥5 wechselt.
 * Prüft ob Garage offen ist und autoCloseGarageOnPlug aktiv, dann Toggle.
 */
export async function autoCloseGarageIfNeeded(): Promise<void> {
  const settings = storage.getSettings();
  const host = settings?.fhemSync?.host;

  if (!host || !settings?.fhemSync?.autoCloseGarageOnPlug) {
    return;
  }

  // Cooldown check: only against previous auto-close events (not manual toggles)
  const now = Date.now();
  if (now - lastAutoCloseTime < AUTO_CLOSE_COOLDOWN_MS) {
    log("debug", "garage", "Auto-Close übersprungen – Cooldown aktiv");
    return;
  }

  try {
    const status = await getGarageStatus(host);
    if (status.state !== "open") {
      log("debug", "garage", `Auto-Close übersprungen – Garage ist ${status.state}`);
      return;
    }

    log("info", "garage", "Auto-Close: Kabel eingesteckt, Garage wird geschlossen");
    await toggleGarage(host);
    lastAutoCloseTime = Date.now();
  } catch (error) {
    log("error", "garage", "Auto-Close fehlgeschlagen",
      error instanceof Error ? error.message : String(error));
  }
}

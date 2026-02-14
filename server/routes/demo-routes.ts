import type { Express } from "express";
import { storage } from "../storage";
import { log } from "../logger";
import { z } from "zod";
import { wallboxMockService } from "../wallbox-mock";

/**
 * Demo-only Routes für Wallbox-Simulation.
 * Werden nur im Demo-Modus registriert (siehe routes/index.ts).
 */
export function registerDemoRoutes(app: Express): void {
  app.post("/api/wallbox/demo-input", async (req, res) => {
    try {
      const settings = storage.getSettings();

      // Prüfe ob Demo-Modus aktiv ist
      if (!settings?.demoMode) {
        return res.status(403).json({ error: "Demo mode not enabled" });
      }

      // Validiere Request Body mit Zod
      const requestSchema = z.object({
        input: z.union([z.literal(0), z.literal(1)]),
      });

      const parsed = requestSchema.parse(req.body);
      const { input } = parsed;

      // Setze Input in Mock-Wallbox (sendet automatisch UDP-Broadcast)
      wallboxMockService.setInput(input);

      log(
        "info",
        "wallbox",
        `Demo: Potenzialfreier Kontakt (Input) gesetzt`,
        `Wert: ${input}`,
      );
      res.json({ success: true, input });
    } catch (error) {
      if (error instanceof z.ZodError) {
        return res.status(400).json({
          error: "Invalid request data",
          details: error.errors,
        });
      }
      log(
        "error",
        "wallbox",
        "Failed to set demo input",
        error instanceof Error ? error.message : String(error),
      );
      res.status(500).json({ error: "Failed to set demo input" });
    }
  });

  app.post("/api/wallbox/demo-plug", async (req, res) => {
    try {
      const settings = storage.getSettings();

      // Prüfe ob Demo-Modus aktiv ist
      if (!settings?.demoMode) {
        return res.status(403).json({ error: "Demo mode not enabled" });
      }

      // Validiere Request Body mit Zod
      const requestSchema = z.object({
        plug: z.number().min(0).max(7),
      });

      const parsed = requestSchema.parse(req.body);
      const { plug } = parsed;

      // Setze Plug-Status in Mock-Wallbox (sendet automatisch UDP-Broadcast)
      wallboxMockService.setPlugStatus(plug);

      // Aktualisiere Settings
      const updatedSettings = { ...settings, mockWallboxPlugStatus: plug };
      storage.saveSettings(updatedSettings);

      log("info", "wallbox", `Demo: Plug-Status gesetzt`, `Wert: ${plug}`);
      res.json({ success: true, plug });
    } catch (error) {
      if (error instanceof z.ZodError) {
        return res.status(400).json({
          error: "Invalid request data",
          details: error.errors,
        });
      }
      log(
        "error",
        "wallbox",
        "Failed to set demo plug status",
        error instanceof Error ? error.message : String(error),
      );
      res.status(500).json({ error: "Failed to set demo plug status" });
    }
  });
}

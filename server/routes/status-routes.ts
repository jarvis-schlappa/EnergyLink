import type { Express } from "express";
import { storage } from "../storage";
import { log } from "../logger";
import { getE3dcModbusService } from "../e3dc-modbus";
import { getGridFrequencyState } from "../grid-frequency-monitor";
import { getBuildInfo } from "../build-info";

/**
 * Konsolidierter Status-Endpoint: Liefert alle vom Frontend gepollt Daten
 * in einem einzigen Request statt 5 paralleler Polls.
 */
export function registerStatusRoutes(app: Express): void {
  app.get("/api/status", (req, res) => {
    try {
      const settings = storage.getSettings();
      const controls = storage.getControlState();
      const plugTracking = storage.getPlugStatusTracking();
      const chargingContext = storage.getChargingContext();
      const buildInfo = getBuildInfo();

      // E3DC Live-Daten aus Cache (kein Netzwerk-Call)
      const e3dcService = getE3dcModbusService();
      const e3dcLiveData = e3dcService.getLastReadLiveData() ?? null;

      // Netzfrequenz-Status
      const gridFrequency = getGridFrequencyState();

      res.json({
        settings,
        controls,
        plugTracking,
        chargingContext,
        e3dcLiveData,
        gridFrequency,
        buildInfo,
        timestamp: new Date().toISOString(),
      });
    } catch (error) {
      log(
        "error",
        "system",
        "Fehler beim Abrufen des konsolidierten Status",
        error instanceof Error ? error.message : String(error),
      );
      res.status(500).json({ error: "Failed to retrieve consolidated status" });
    }
  });
}

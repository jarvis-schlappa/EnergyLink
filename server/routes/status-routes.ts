import type { Express } from "express";
import { storage } from "../core/storage";
import { log } from "../core/logger";
import { getE3dcModbusService } from "../e3dc/modbus";
import { getGridFrequencyState } from "../monitoring/grid-frequency-monitor";
import { getBuildInfo } from "../core/build-info";
import { getLastCachedWallboxStatus } from "./wallbox-routes";

// Issue #71: FRONTEND-STATE Trace-Log – Change-Detection State
// Speichert den letzten geloggten Snapshot als kompakten String zum Vergleich.
let lastFrontendStateSnapshot = "";

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

      // Issue #71: FRONTEND-STATE Trace-Log
      // Einmal pro Poll-Zyklus, nur bei Änderung – zeigt was das Frontend gerade sieht.
      const wallboxStatus = getLastCachedWallboxStatus();
      const strategy = settings?.chargingStrategy?.activeStrategy ?? "unknown";
      const demo = settings?.demoMode ?? false;

      const wbPower = wallboxStatus ? Math.round(wallboxStatus.power * 1000) : 0;
      const wbState = wallboxStatus?.state ?? 0;
      const wbPlug = wallboxStatus?.plug ?? 0;
      const wbCharging = wbState === 3;

      const pvPower = e3dcLiveData ? Math.round(e3dcLiveData.pvPower) : 0;
      const soc = e3dcLiveData ? Math.round(e3dcLiveData.batterySoc) : 0;
      const gridPower = e3dcLiveData ? Math.round(e3dcLiveData.gridPower) : 0;
      const batPower = e3dcLiveData ? Math.round(e3dcLiveData.batteryPower) : 0;

      const snapshot = `wb=${wbPower}/${wbState}/${wbPlug}/${wbCharging} e3dc=${pvPower}/${soc}/${gridPower}/${batPower} strategy=${strategy} demo=${demo}`;
      if (snapshot !== lastFrontendStateSnapshot) {
        lastFrontendStateSnapshot = snapshot;
        log(
          "trace",
          "system",
          `[FRONTEND-STATE] wallbox={power:${wbPower}W, state:${wbState}, plug:${wbPlug}, charging:${wbCharging}} e3dc={pv:${pvPower}W, soc:${soc}%, grid:${gridPower}W, bat:${batPower}W} strategy=${strategy} demo=${demo}`,
        );
      }

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

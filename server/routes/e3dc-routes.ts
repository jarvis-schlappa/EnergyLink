import type { Express } from "express";
import { storage } from "../core/storage";
import { log } from "../core/logger";
import { e3dcClient } from "../e3dc/client";
import { getE3dcModbusService } from "../e3dc/modbus";
import { getE3dcBackoffLevel } from "../e3dc/poller";
import { getGridFrequencyState } from "../monitoring/grid-frequency-monitor";
import { getProwlNotifier } from "../monitoring/prowl-notifier";

export function registerE3dcRoutes(app: Express): void {
  app.get("/api/e3dc/live-data", async (req, res) => {
    try {
      const settings = storage.getSettings();

      // E3DC IP erforderlich (im Demo-Modus: 127.0.0.1:5502 für Unified Mock Server)
      if (!settings?.e3dcIp) {
        log(
          "error",
          "system",
          "E3DC IP nicht konfiguriert - bitte in Einstellungen setzen",
        );
        return res.status(400).json({
          error: "E3DC IP nicht konfiguriert",
        });
      }

      // Hole Daten aus dem Cache (E3DC-Poller aktualisiert alle 5s)
      const e3dcService = getE3dcModbusService();
      const cachedData = e3dcService.getLastReadLiveData();

      if (cachedData) {
        // Cache-Hit: Verwende gecachte Daten (vom E3DC-Poller)
        log(
          "debug",
          "system",
          `E3DC Live-Daten aus Cache gelesen: PV=${cachedData.pvPower}W, Batterie=${cachedData.batteryPower}W (SOC=${cachedData.batterySoc}%), Haus=${cachedData.housePower}W`,
        );
        res.json(cachedData);
      } else {
        // Cache-Miss: Erste Anfrage vor erstem Poll
        const backoffLevel = getE3dcBackoffLevel();
        
        if (backoffLevel > 0) {
          log(
            "debug",
            "system",
            `E3DC Cache leer (Backoff-Modus Level ${backoffLevel}) - warte auf nächsten Poller-Versuch`,
          );
        } else {
          log(
            "warning",
            "system",
            "E3DC Cache leer - warte auf ersten Poller-Durchlauf (alle 5s)",
          );
        }
        
        res.status(503).json({
          error: "E3DC-Daten noch nicht verfügbar - bitte kurz warten und erneut versuchen",
        });
      }
    } catch (error) {
      log(
        "error",
        "system",
        "Unerwarteter Fehler bei E3DC Live-Daten Abfrage",
        error instanceof Error ? error.message : String(error),
      );
      res.status(500).json({ error: "Internal server error" });
    }
  });

  app.post("/api/e3dc/execute-command", async (req, res) => {
    try {
      const settings = storage.getSettings();
      
      // E3DC muss aktiviert sein
      if (!settings?.e3dc?.enabled) {
        return res.status(400).json({ error: "E3DC ist nicht aktiviert" });
      }
      
      // Validiere Input
      const { command } = req.body;
      if (!command || typeof command !== 'string' || command.trim() === '') {
        return res.status(400).json({ error: "Befehl ist erforderlich" });
      }
      
      // Führe Befehl aus und erhalte Output
      try {
        const output = await e3dcClient.executeConsoleCommand(command);
        res.json({ output });
      } catch (execError) {
        const errorMessage = execError instanceof Error ? execError.message : String(execError);
        log("error", "system", `E3DC Console: Fehler`, errorMessage);
        res.json({ output: `Fehler: ${errorMessage}` });
      }
    } catch (error) {
      log("error", "system", "Fehler in E3DC Console", error instanceof Error ? error.message : String(error));
      res.status(500).json({ error: "Internal server error" });
    }
  });

  app.get("/api/grid-frequency-status", (req, res) => {
    try {
      const status = getGridFrequencyState();
      res.json(status);
    } catch (error) {
      log("error", "system", "Fehler beim Abrufen des Netzfrequenz-Status", error instanceof Error ? error.message : String(error));
      res.status(500).json({ error: "Internal server error" });
    }
  });

  app.post("/api/prowl/test", async (req, res) => {
    try {
      const settings = storage.getSettings();
      
      if (!settings?.prowl?.enabled) {
        return res.status(400).json({ error: "Prowl ist nicht aktiviert" });
      }
      
      if (!settings?.prowl?.apiKey) {
        return res.status(400).json({ error: "Prowl API Key nicht konfiguriert" });
      }
      
      const success = await getProwlNotifier().sendTestNotification();
      
      if (success) {
        log("info", "system", "Prowl Test-Benachrichtigung gesendet");
        res.json({ success: true, message: "Test-Benachrichtigung gesendet" });
      } else {
        res.status(500).json({ error: "Test-Benachrichtigung fehlgeschlagen - prüfe API Key und Logs" });
      }
    } catch (error) {
      log("error", "system", "Fehler beim Senden der Prowl Test-Benachrichtigung", error instanceof Error ? error.message : String(error));
      res.status(500).json({ error: "Internal server error" });
    }
  });
}

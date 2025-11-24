import type { Express } from "express";
import { createServer, type Server } from "http";
import { storage } from "./storage";
import {
  settingsSchema,
  controlStateSchema,
  logSettingsSchema,
  type LogLevel,
  e3dcBatteryStatusSchema,
  type ControlState,
  e3dcLiveDataSchema,
  chargingStrategyConfigSchema,
  chargingStrategySchema,
  type ChargingStrategy,
} from "@shared/schema";
import { e3dcClient } from "./e3dc-client";
import { getE3dcModbusService } from "./e3dc-modbus";
import { log } from "./logger";
import { z } from "zod";
import { ChargingStrategyController } from "./charging-strategy-controller";
import { wallboxMockService } from "./wallbox-mock";
import { sendUdpCommand, sendUdpCommandNoResponse } from "./wallbox-transport";
import { getBuildInfo } from "./build-info";
import { syncE3dcToFhem, startFhemSyncScheduler, stopFhemSyncScheduler } from "./fhem-e3dc-sync";
import { startE3dcPoller, stopE3dcPoller, getE3dcBackoffLevel } from "./e3dc-poller";
import { initializeProwlNotifier, triggerProwlEvent, extractTargetWh, getProwlNotifier } from "./prowl-notifier";
import { initSSEClient, broadcastWallboxStatus } from "./wallbox-sse";

// Module-scope Scheduler Handles (überleben Hot-Reload)
let chargingStrategyInterval: NodeJS.Timeout | null = null;
let nightChargingSchedulerInterval: NodeJS.Timeout | null = null;
let fhemSyncInterval: NodeJS.Timeout | null = null;
let e3dcPollerInterval: NodeJS.Timeout | null = null;
let strategyController: ChargingStrategyController | null = null;

/**
 * Graceful Shutdown für alle Scheduler
 * Wird von index.ts beim SIGTERM/SIGINT aufgerufen
 */
export async function shutdownSchedulers(): Promise<void> {
  log("info", "system", "Stoppe alle Scheduler...");
  
  // Stoppe Charging Strategy Event-Listener (wartet auf laufenden Strategy-Check)
  if (strategyController) {
    await strategyController.stopEventListener();
    log("info", "system", "Charging-Strategy-Event-Listener gestoppt");
  }
  
  // Stoppe Scheduler
  if (chargingStrategyInterval) {
    clearInterval(chargingStrategyInterval);
    chargingStrategyInterval = null;
    log("info", "system", "Charging-Strategy-Fallback-Timer gestoppt");
  }
  
  if (nightChargingSchedulerInterval) {
    clearInterval(nightChargingSchedulerInterval);
    nightChargingSchedulerInterval = null;
    log("info", "system", "Night-Charging-Scheduler gestoppt");
  }
  
  // Stoppe FHEM-Sync-Scheduler (wartet auf laufenden Sync)
  await stopFhemSyncScheduler(fhemSyncInterval);
  fhemSyncInterval = null;
  
  // Stoppe E3DC-Background-Poller (wartet auf laufenden Poll)
  await stopE3dcPoller();
  e3dcPollerInterval = null;
  
  log("info", "system", "Alle Scheduler erfolgreich gestoppt");
}

async function callSmartHomeUrl(url: string | undefined): Promise<void> {
  if (!url) return;
  try {
    log("info", "webhook", `Rufe SmartHome-URL auf`, `URL: ${url}`);
    const response = await fetch(url, { method: "GET" });
    log(
      "info",
      "webhook",
      `SmartHome-URL erfolgreich aufgerufen`,
      `Status: ${response.status}, URL: ${url}`,
    );
  } catch (error) {
    log(
      "error",
      "webhook",
      "Fehler beim Aufruf der SmartHome-URL",
      `URL: ${url}, Fehler: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

async function getFhemDeviceState(
  baseUrl: string,
  deviceName: string,
): Promise<boolean | null> {
  try {
    const url = `${baseUrl}?detail=${deviceName}`;
    log(
      "debug",
      "webhook",
      `Frage FHEM-Gerätestatus ab`,
      `URL: ${url}, Gerät: ${deviceName}`,
    );

    const response = await fetch(url, { method: "GET" });
    if (!response.ok) {
      log(
        "warning",
        "webhook",
        `FHEM-Statusabfrage fehlgeschlagen`,
        `Status: ${response.status}, URL: ${url}`,
      );
      return null;
    }

    const html = await response.text();

    // Suche nach <div informId="deviceName-state">on/off</div>
    const regex = new RegExp(
      `<div informId="${deviceName}-state">([^<]*)`,
      "i",
    );
    const match = html.match(regex);

    if (match && match[1]) {
      const state = match[1].trim().toLowerCase();
      log(
        "debug",
        "webhook",
        `FHEM-Gerätestatus empfangen`,
        `Gerät: ${deviceName}, Status: ${state}`,
      );
      return state === "on";
    }

    log(
      "warning",
      "webhook",
      `FHEM-Status nicht gefunden im HTML`,
      `Gerät: ${deviceName}`,
    );
    return null;
  } catch (error) {
    log(
      "error",
      "webhook",
      "Fehler beim Abrufen des FHEM-Status",
      `Gerät: ${deviceName}, Fehler: ${error instanceof Error ? error.message : String(error)}`,
    );
    return null;
  }
}

function extractDeviceNameFromUrl(url: string | undefined): string | null {
  if (!url) return null;
  try {
    // Versuche zuerst detail= Parameter
    let match = url.match(/detail=([^&]+)/);
    if (match && match[1]) {
      return match[1];
    }

    // Fallback: Versuche cmd.DEVICE= Format
    match = url.match(/cmd\.([^=]+)=/);
    if (match && match[1]) {
      return match[1];
    }

    // Fallback: Versuche set%20DEVICE%20 Format (URL-encoded)
    match = url.match(/set%20([^%]+)%20/);
    if (match && match[1]) {
      return match[1];
    }

    // Fallback: Versuche set DEVICE Format (decoded)
    match = url.match(/set\s+(\S+)\s+/);
    if (match && match[1]) {
      return match[1];
    }

    return null;
  } catch {
    return null;
  }
}

function extractBaseUrlFromUrl(url: string | undefined): string | null {
  if (!url) return null;
  try {
    const match = url.match(/^(https?:\/\/[^?]+)/);
    return match ? match[1] : null;
  } catch {
    return null;
  }
}

export async function registerRoutes(app: Express): Promise<Server> {
  // Prowl-Notifier wird bereits in index.ts initialisiert
  
  app.get("/api/build-info", (req, res) => {
    try {
      const buildInfo = getBuildInfo();
      res.json(buildInfo);
    } catch (error) {
      log(
        "error",
        "system",
        "Fehler beim Abrufen der Build-Info",
        error instanceof Error ? error.message : String(error),
      );
      res.status(500).json({ error: "Failed to get build info" });
    }
  });

  // SSE-Endpoint für Echtzeit-Status-Updates
  app.get("/api/wallbox/stream", (req, res) => {
    initSSEClient(res);
  });

  app.get("/api/wallbox/status", async (req, res) => {
    try {
      const settings = storage.getSettings();

      if (!settings?.wallboxIp) {
        return res.status(400).json({ error: "Wallbox IP not configured" });
      }

      const report1 = await sendUdpCommand(settings.wallboxIp, "report 1");
      const report2 = await sendUdpCommand(settings.wallboxIp, "report 2");
      const report3 = await sendUdpCommand(settings.wallboxIp, "report 3");

      // Phasenzahl aus Strömen ableiten (nicht aus Spannungen, da diese immer anliegen)
      const i1 = report3?.["I1"] || 0;
      const i2 = report3?.["I2"] || 0;
      const i3 = report3?.["I3"] || 0;

      // Zähle wie viele Phasen aktiv sind (>100mA = 0.1A Threshold)
      const CURRENT_THRESHOLD = 100; // mA
      let activePhaseCount = 0;
      if (i1 > CURRENT_THRESHOLD) activePhaseCount++;
      if (i2 > CURRENT_THRESHOLD) activePhaseCount++;
      if (i3 > CURRENT_THRESHOLD) activePhaseCount++;

      const detectedPhases = activePhaseCount; // 0, 1, 2, or 3

      const status = {
        state: report2?.State || 0,
        plug: report2?.Plug || 0,
        input: report2?.Input, // Potenzialfreier Kontakt (optional)
        enableSys: report2["Enable sys"] || 0,
        maxCurr: (report2["Max curr"] || 0) / 1000,
        ePres: (report3["E pres"] || 0) / 10, // von dWh zu Wh (Frontend konvertiert zu kWh)
        eTotal: (report3["E total"] || 0) / 10, // von dWh zu Wh (Frontend konvertiert zu kWh)
        power: (report3?.P || 0) / 1000000,
        phases: detectedPhases,
        i1: i1 / 1000,
        i2: i2 / 1000,
        i3: i3 / 1000,
        lastUpdated: new Date().toISOString(),
      };

      // Tracke Änderungen des Kabelstatus im Hintergrund (nur bei gültigen Werten)
      if (typeof status.plug === "number") {
        const tracking = storage.getPlugStatusTracking();
        if (
          tracking.lastPlugStatus !== undefined &&
          tracking.lastPlugStatus !== status.plug
        ) {
          // Status hat sich geändert - speichere Zeitstempel
          storage.savePlugStatusTracking({
            lastPlugStatus: status.plug,
            lastPlugChange: new Date().toISOString(),
          });
          log(
            "info",
            "wallbox",
            `Kabelstatus geändert: ${tracking.lastPlugStatus} -> ${status.plug}`,
          );
        } else if (tracking.lastPlugStatus === undefined) {
          // Erster Aufruf - initialisiere ohne Zeitstempel
          storage.savePlugStatusTracking({
            lastPlugStatus: status.plug,
          });
        }
      }

      // Broadcast to all WebSocket clients
      broadcastWallboxStatus(status);

      res.json(status);
    } catch (error) {
      log(
        "error",
        "wallbox",
        "Failed to get wallbox status",
        error instanceof Error ? error.message : String(error),
      );
      res.status(500).json({ error: "Failed to communicate with wallbox" });
    }
  });

  app.post("/api/wallbox/start", (req, res) => {
    try {
      const settings = storage.getSettings();

      if (!settings?.wallboxIp) {
        return res.status(400).json({ error: "Wallbox IP not configured" });
      }

      // Optional: Aktiviere Ladestrategie (Standard: inputX1Strategy)
      const { strategy } = req.body;
      let strategyToActivate: ChargingStrategy | undefined;
      
      if (strategy !== undefined) {
        const strategyValidation = chargingStrategySchema.safeParse(strategy);
        if (!strategyValidation.success) {
          return res.status(400).json({ error: "Invalid charging strategy" });
        }
        strategyToActivate = strategyValidation.data;

        const updatedSettings = {
          ...settings,
          chargingStrategy: {
            ...settings.chargingStrategy,
            minStartPowerWatt: settings.chargingStrategy?.minStartPowerWatt ?? 1400,
            stopThresholdWatt: settings.chargingStrategy?.stopThresholdWatt ?? 1000,
            startDelaySeconds: settings.chargingStrategy?.startDelaySeconds ?? 120,
            stopDelaySeconds: settings.chargingStrategy?.stopDelaySeconds ?? 300,
            physicalPhaseSwitch: settings.chargingStrategy?.physicalPhaseSwitch ?? 3,
            minCurrentChangeAmpere: settings.chargingStrategy?.minCurrentChangeAmpere ?? 1,
            minChangeIntervalSeconds: settings.chargingStrategy?.minChangeIntervalSeconds ?? 60,
            inputX1Strategy: settings.chargingStrategy?.inputX1Strategy ?? "max_without_battery",
            activeStrategy: strategyToActivate,
          },
        };

        storage.saveSettings(updatedSettings);
        log("info", "wallbox", `Ladestrategie aktiviert: ${strategyToActivate}`);
      }

      // Sofort antworten für schnelle UI-Reaktion
      res.json({ success: true });
      
      // Background: Async-Operationen im Hintergrund ausführen (nicht warten)
      (async () => {
        try {
          // WICHTIG: Battery Lock aktivieren/deaktivieren basierend auf Strategie
          if (strategyToActivate) {
            if (!strategyController) {
              strategyController = new ChargingStrategyController(sendUdpCommand);
            }
            
            if (strategyToActivate === "max_without_battery") {
              // X1-Optimierung: Schneller Pfad (Wallbox → SSE → Battery Lock async)
              await strategyController.activateMaxPowerImmediately(settings.wallboxIp);
              log("info", "wallbox", `Laden erfolgreich gestartet`);
            } else {
              // Normale Strategien: Event-driven Flow
              await strategyController.handleStrategyChange(strategyToActivate);
              
              const response = await sendUdpCommand(settings.wallboxIp, "ena 1");
              if (
                !response ||
                (!response["TCH-OK"] && !JSON.stringify(response).includes("TCH-OK"))
              ) {
                log(
                  "error",
                  "wallbox",
                  `Laden starten fehlgeschlagen - keine Bestätigung`,
                  `Antwort: ${JSON.stringify(response)}`,
                );
              } else {
                log("info", "wallbox", `Laden erfolgreich gestartet`);
              }
            }
          } else {
            // Keine Strategie → nur Wallbox starten
            const response = await sendUdpCommand(settings.wallboxIp, "ena 1");

            if (
              !response ||
              (!response["TCH-OK"] && !JSON.stringify(response).includes("TCH-OK"))
            ) {
              log(
                "error",
                "wallbox",
                `Laden starten fehlgeschlagen - keine Bestätigung`,
                `Antwort: ${JSON.stringify(response)}`,
              );
            } else {
              log("info", "wallbox", `Laden erfolgreich gestartet`);
            }
          }
        } catch (bgError) {
          log(
            "error",
            "wallbox",
            "Background: Failed to start charging",
            bgError instanceof Error ? bgError.message : String(bgError),
          );
        }
      })();
    } catch (error) {
      log(
        "error",
        "wallbox",
        "Failed to start charging",
        error instanceof Error ? error.message : String(error),
      );
      res.status(500).json({ error: "Failed to start charging" });
    }
  });

  app.post("/api/wallbox/stop", (req, res) => {
    try {
      const settings = storage.getSettings();

      if (!settings?.wallboxIp) {
        return res.status(400).json({ error: "Wallbox IP not configured" });
      }

      // Setze Ladestrategie auf "off"
      const updatedSettings = {
        ...settings,
        chargingStrategy: {
          ...settings.chargingStrategy,
          minStartPowerWatt: settings.chargingStrategy?.minStartPowerWatt ?? 1400,
          stopThresholdWatt: settings.chargingStrategy?.stopThresholdWatt ?? 1000,
          startDelaySeconds: settings.chargingStrategy?.startDelaySeconds ?? 120,
          stopDelaySeconds: settings.chargingStrategy?.stopDelaySeconds ?? 300,
          physicalPhaseSwitch: settings.chargingStrategy?.physicalPhaseSwitch ?? 3,
          minCurrentChangeAmpere: settings.chargingStrategy?.minCurrentChangeAmpere ?? 1,
          minChangeIntervalSeconds: settings.chargingStrategy?.minChangeIntervalSeconds ?? 60,
          inputX1Strategy: settings.chargingStrategy?.inputX1Strategy ?? "max_without_battery",
          activeStrategy: "off" as const,
        },
      };

      storage.saveSettings(updatedSettings);
      log("info", "wallbox", `Ladestrategie deaktiviert (auf "off" gesetzt)`);
      
      // Sofort antworten für schnelle UI-Reaktion
      res.json({ success: true });
      
      // Background: Async-Operationen im Hintergrund ausführen (nicht warten)
      (async () => {
        try {
          // WICHTIG: Battery Lock deaktivieren
          if (!strategyController) {
            strategyController = new ChargingStrategyController(sendUdpCommand);
          }
          await strategyController.handleStrategyChange("off");

          const response = await sendUdpCommand(settings.wallboxIp, "ena 0");

          if (
            !response ||
            (!response["TCH-OK"] && !JSON.stringify(response).includes("TCH-OK"))
          ) {
            log(
              "error",
              "wallbox",
              `Laden stoppen fehlgeschlagen - keine Bestätigung`,
              `Antwort: ${JSON.stringify(response)}`,
            );
          } else {
            log("info", "wallbox", `Laden erfolgreich gestoppt`);
          }
        } catch (bgError) {
          log(
            "error",
            "wallbox",
            "Background: Failed to stop charging",
            bgError instanceof Error ? bgError.message : String(bgError),
          );
        }
      })();
    } catch (error) {
      log(
        "error",
        "wallbox",
        "Failed to stop charging",
        error instanceof Error ? error.message : String(error),
      );
      res.status(500).json({ error: "Failed to stop charging" });
    }
  });

  app.post("/api/wallbox/current", async (req, res) => {
    try {
      const settings = storage.getSettings();

      const { current } = req.body;
      if (typeof current !== "number" || current < 6 || current > 32) {
        return res
          .status(400)
          .json({ error: "Current must be between 6 and 32 amperes" });
      }

      const currentInMilliamps = Math.round(current * 1000);

      if (!settings?.wallboxIp) {
        return res.status(400).json({ error: "Wallbox IP not configured" });
      }

      // Sende curr Befehl und warte auf TCH-OK :done Bestätigung
      const response = await sendUdpCommand(
        settings.wallboxIp,
        `curr ${currentInMilliamps}`,
      );

      // Prüfe ob die Wallbox den Befehl bestätigt hat
      if (
        !response ||
        (!response["TCH-OK"] && !JSON.stringify(response).includes("TCH-OK"))
      ) {
        log(
          "error",
          "wallbox",
          `Ladestrom-Änderung fehlgeschlagen - keine Bestätigung`,
          `Antwort: ${JSON.stringify(response)}`,
        );
        return res
          .status(500)
          .json({ error: "Wallbox did not acknowledge current change" });
      }

      // Verifiziere die Änderung durch Abfrage von Report 2
      await new Promise((resolve) => setTimeout(resolve, 200)); // Kurze Pause für Wallbox-Verarbeitung
      const report2 = await sendUdpCommand(settings.wallboxIp, "report 2");
      const actualCurrent = report2?.["Curr user"] || 0;

      if (Math.abs(actualCurrent - currentInMilliamps) > 100) {
        log(
          "error",
          "wallbox",
          `Ladestrom-Änderung fehlgeschlagen - Verifizierung`,
          `Erwartet: ${currentInMilliamps}mA, Tatsächlich: ${actualCurrent}mA`,
        );
        return res
          .status(500)
          .json({ error: "Current change was not applied by wallbox" });
      }

      log(
        "info",
        "wallbox",
        `Ladestrom erfolgreich geändert und verifiziert`,
        `Neuer Wert: ${current}A (${currentInMilliamps}mA)`,
      );
      res.json({ success: true });
    } catch (error) {
      log(
        "error",
        "wallbox",
        "Failed to set current",
        error instanceof Error ? error.message : String(error),
      );
      res.status(500).json({ error: "Failed to set charging current" });
    }
  });

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

  app.get("/api/settings", (req, res) => {
    const settings = storage.getSettings();
    if (!settings) {
      return res.json({
        wallboxIp: "",
        pvSurplusOnUrl: "",
        pvSurplusOffUrl: "",
        nightChargingOnUrl: "",
        nightChargingOffUrl: "",
        batteryLockOnUrl: "",
        batteryLockOffUrl: "",
      });
    }
    res.json(settings);
  });

  app.post("/api/settings", async (req, res) => {
    try {
      const newSettings = settingsSchema.parse(req.body);
      const oldSettings = storage.getSettings();

      // Prüfe ob Strategie sich geändert hat
      const oldStrategy = oldSettings?.chargingStrategy?.activeStrategy;
      const newStrategy = newSettings?.chargingStrategy?.activeStrategy;
      const strategyChanged = oldStrategy !== newStrategy;

      // Prüfe ob Mock-Wallbox-Phasen sich geändert haben
      const oldPhases = oldSettings?.mockWallboxPhases;
      const newPhases = newSettings?.mockWallboxPhases;
      const phasesChanged = oldPhases !== newPhases;

      // Prüfe ob Mock-Wallbox-Plug-Status sich geändert hat
      const oldPlug = oldSettings?.mockWallboxPlugStatus;
      const newPlug = newSettings?.mockWallboxPlugStatus;
      const plugChanged = oldPlug !== newPlug;

      // Prüfe ob E3DC-Konfiguration sich geändert hat
      const oldE3dc = oldSettings?.e3dc;
      const newE3dc = newSettings?.e3dc;
      const e3dcChanged = JSON.stringify(oldE3dc) !== JSON.stringify(newE3dc);

      storage.saveSettings(newSettings);
      
      // Aktualisiere Prowl-Notifier mit neuen Settings
      try {
        getProwlNotifier().updateSettings(newSettings);
      } catch (error) {
        log("warning", "system", "Prowl-Notifier konnte nicht aktualisiert werden", error instanceof Error ? error.message : String(error));
      }

      // Demo-Modus: Aktualisiere Mock-Wallbox-Phasen ohne Neustart
      if (newSettings.demoMode && phasesChanged && newPhases) {
        try {
          wallboxMockService.setPhases(newPhases);
          log(
            "info",
            "system",
            `Mock-Wallbox-Phasen aktualisiert: ${newPhases}P`,
            "Änderung sofort wirksam ohne Neustart",
          );
        } catch (error) {
          log(
            "warning",
            "system",
            "Mock-Wallbox-Phasen konnten nicht aktualisiert werden",
            error instanceof Error ? error.message : String(error),
          );
        }
      }

      // Demo-Modus: Aktualisiere Mock-Wallbox-Plug-Status und sende Broadcast
      if (newSettings.demoMode && plugChanged && newPlug !== undefined) {
        try {
          wallboxMockService.setPlugStatus(newPlug);
          log(
            "info",
            "system",
            `Mock-Wallbox-Plug-Status aktualisiert: ${newPlug}`,
            "Broadcast gesendet",
          );
        } catch (error) {
          log(
            "warning",
            "system",
            "Mock-Wallbox-Plug-Status konnte nicht aktualisiert werden",
            error instanceof Error ? error.message : String(error),
          );
        }
      }

      // E3DC-Konfiguration speichern wenn sich etwas geändert hat
      if (e3dcChanged) {
        if (newSettings.e3dc?.enabled) {
          try {
            log("info", "system", "E3DC-Konfiguration wird gespeichert");
            e3dcClient.configure(newSettings.e3dc);
            log("info", "system", "E3DC-Konfiguration erfolgreich gespeichert");
          } catch (error) {
            log(
              "error",
              "system",
              "Fehler beim Speichern der E3DC-Konfiguration",
              error instanceof Error ? error.message : String(error),
            );
          }
        } else if (e3dcClient.isConfigured()) {
          e3dcClient.disconnect();
          log("info", "system", "E3DC-Konfiguration entfernt");
        }
      }

      // WICHTIG: Wenn Strategie geändert wurde, Battery Lock aktivieren/deaktivieren
      if (strategyChanged && newStrategy) {
        // Lazy-init Strategy Controller falls noch nicht vorhanden
        if (!strategyController) {
          strategyController = new ChargingStrategyController(sendUdpCommand);
        }

        try {
          log("info", "system", `Ladestrategie gewechselt auf: ${newStrategy}`);
          await strategyController.handleStrategyChange(newStrategy);
          
          // Prowl-Benachrichtigung für Strategie-Wechsel
          triggerProwlEvent(newSettings, "strategyChanged", (notifier) =>
            notifier.sendStrategyChanged(oldStrategy || "off", newStrategy)
          );
        } catch (error) {
          log(
            "warning",
            "system",
            "Battery Lock konnte nicht gesetzt werden",
            error instanceof Error ? error.message : String(error),
          );
          // Nicht kritisch - Strategie wurde trotzdem gespeichert
        }
      }

      res.json({ success: true });
    } catch (error) {
      // Detailliertes Error-Logging für Validierungsfehler
      if (error instanceof Error) {
        log("error", "system", "Settings-Validierung fehlgeschlagen", error.message);
        
        // Bei Zod-Errors: Zeige alle Fehler im Detail
        if ('errors' in error && Array.isArray((error as any).errors)) {
          const zodErrors = (error as any).errors;
          zodErrors.forEach((err: any) => {
            log("error", "system", `Validierungsfehler bei ${err.path.join('.')}: ${err.message}`);
          });
        }
        
        // Logge auch den Request-Body (ohne sensitive Daten)
        const sanitizedBody = { ...req.body };
        if (sanitizedBody.prowl?.apiKey) {
          sanitizedBody.prowl.apiKey = '[REDACTED]';
        }
        log("error", "system", "Request-Body:", JSON.stringify(sanitizedBody, null, 2));
      } else {
        log("error", "system", "Unbekannter Fehler beim Speichern der Settings", String(error));
      }
      
      res.status(400).json({ error: "Invalid settings data" });
    }
  });

  app.get("/api/controls", (req, res) => {
    const state = storage.getControlState();
    res.json(state);
  });

  app.get("/api/wallbox/plug-tracking", (req, res) => {
    const tracking = storage.getPlugStatusTracking();
    res.json(tracking);
  });

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
        
        // Wenn E3DC im Backoff ist, stille Pause (DEBUG-Level)
        // Wenn nicht im Backoff aber kein Cache, dann echtes Problem (WARNING)
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

  app.post("/api/controls", async (req, res) => {
    try {
      // Frischer State vom Storage für Vergleich
      const currentStorageState = storage.getControlState();

      // Parse und validiere Request, aber entferne nightCharging (scheduler-only)
      const state = controlStateSchema.parse(req.body);
      delete (state as any).nightCharging; // Entferne nightCharging aus Request

      const settings = storage.getSettings();

      // Merke welche Felder tatsächlich geändert werden sollen
      const changedFields = {
        pvSurplus: state.pvSurplus !== currentStorageState.pvSurplus,
        batteryLock: state.batteryLock !== currentStorageState.batteryLock,
        gridCharging: state.gridCharging !== currentStorageState.gridCharging,
      };

      if (changedFields.pvSurplus) {
        log(
          "info",
          "system",
          `PV-Überschussladung ${state.pvSurplus ? "aktiviert" : "deaktiviert"}`,
        );

        // Sende Wallbox-Phasen-Umschaltung (Mock versteht "mode pv", echte Wallbox ignoriert)
        if (settings?.wallboxIp) {
          try {
            await sendUdpCommand(
              settings.wallboxIp,
              `mode pv ${state.pvSurplus ? "1" : "0"}`,
            );
            log(
              "info",
              "wallbox",
              `Wallbox ${state.pvSurplus ? "auf einphasige (6-32A)" : "auf dreiphasige (6-16A)"} Ladung umgeschaltet`,
            );
          } catch (error) {
            // Fehler ignorieren - echte Wallbox kennt diesen Befehl nicht, das ist ok
            log(
              "debug",
              "wallbox",
              `mode pv Befehl ignoriert (normale Wallbox kennt diesen Befehl nicht)`,
            );
          }
        }

        // SmartHome-URL aufrufen (nur wenn konfiguriert)
        await callSmartHomeUrl(
          state.pvSurplus
            ? settings?.pvSurplusOnUrl
            : settings?.pvSurplusOffUrl,
        );
      }

      if (changedFields.batteryLock) {
        log(
          "info",
          "system",
          `Batterie entladen sperren ${state.batteryLock ? "aktiviert" : "deaktiviert"}`,
        );
        if (state.batteryLock) {
          await lockBatteryDischarge(settings);
        } else {
          await unlockBatteryDischarge(settings);
        }
      }

      if (changedFields.gridCharging) {
        log(
          "info",
          "system",
          `Netzstrom-Laden ${state.gridCharging ? "aktiviert" : "deaktiviert"}`,
        );
        if (state.gridCharging) {
          await enableGridCharging(settings);
        } else {
          await disableGridCharging(settings);
        }
      }

      // Atomar: Nur die tatsächlich geänderten Felder aktualisieren
      // nightCharging wird NIE vom Request übernommen (scheduler-only)
      const updates: Partial<ControlState> = {};
      if (changedFields.pvSurplus) updates.pvSurplus = state.pvSurplus;
      if (changedFields.batteryLock) updates.batteryLock = state.batteryLock;
      if (changedFields.gridCharging) updates.gridCharging = state.gridCharging;

      storage.updateControlState(updates);
      res.json({ success: true });
    } catch (error) {
      res.status(400).json({ error: "Invalid control state data" });
    }
  });

  app.post("/api/controls/sync", async (req, res) => {
    // Endpoint nur für Kompatibilität beibehalten - keine FHEM-Synchronisation mehr
    const currentState = storage.getControlState();
    res.json(currentState);
  });

  app.get("/api/logs", (req, res) => {
    const logs = storage.getLogs();
    res.json(logs);
  });

  app.delete("/api/logs", (req, res) => {
    storage.clearLogs();
    log("info", "system", "Logs gelöscht");
    res.json({ success: true });
  });

  app.get("/api/logs/settings", (req, res) => {
    const settings = storage.getLogSettings();
    res.json(settings);
  });

  app.post("/api/logs/settings", (req, res) => {
    try {
      const settings = logSettingsSchema.parse(req.body);
      storage.saveLogSettings(settings);
      log("info", "system", `Log-Level auf "${settings.level}" gesetzt`);
      res.json({ success: true });
    } catch (error) {
      res.status(400).json({ error: "Invalid log settings data" });
    }
  });

  // === CHARGING STRATEGY API ROUTES ===

  app.get("/api/charging/context", (req, res) => {
    try {
      const context = storage.getChargingContext();
      res.json(context);
    } catch (error) {
      log(
        "error",
        "system",
        "Fehler beim Abrufen des Charging Context",
        error instanceof Error ? error.message : String(error),
      );
      res.status(500).json({ error: "Failed to retrieve charging context" });
    }
  });

  app.post("/api/charging/strategy", async (req, res) => {
    try {
      const strategyRequestSchema = z.object({
        strategy: chargingStrategySchema,
      });

      const parsed = strategyRequestSchema.parse(req.body);
      const { strategy } = parsed;

      const settings = storage.getSettings();
      if (!settings?.chargingStrategy) {
        return res
          .status(400)
          .json({ error: "Strategy configuration not found" });
      }

      // Alte Strategie für Prowl-Benachrichtigung speichern
      const oldStrategy = settings.chargingStrategy.activeStrategy;

      const updatedConfig = {
        ...settings.chargingStrategy,
        activeStrategy: strategy,
      };

      storage.saveSettings({
        ...settings,
        chargingStrategy: updatedConfig,
      });

      // WICHTIG: Nutze X1-Fast-Path für max_without_battery
      if (strategyController) {
        try {
          if (strategy === "max_without_battery") {
            // X1-Optimierung: Schneller Pfad (Wallbox → SSE → Battery Lock async)
            const wallboxIp = settings.wallboxIp || "192.168.40.16";
            await strategyController.activateMaxPowerImmediately(wallboxIp);
          } else {
            // Normale Strategien: Event-driven Flow
            await strategyController.handleStrategyChange(strategy);
            
            // Sofortiger Check nach Strategiewechsel (vermeidet 0-15s Verzögerung)
            try {
              const wallboxIp = settings.wallboxIp || "192.168.40.16";
              await strategyController.triggerImmediateCheck(wallboxIp);
            } catch (error) {
              log(
                "debug",
                "system",
                "Sofortiger Check fehlgeschlagen (Scheduler übernimmt)",
                error instanceof Error ? error.message : String(error),
              );
              // Nicht kritisch - Scheduler wird Check nachholen
            }
          }
        } catch (error) {
          log(
            "warning",
            "system",
            "Strategie-Aktivierung fehlgeschlagen",
            error instanceof Error ? error.message : String(error),
          );
          // Nicht kritisch - Strategie wurde trotzdem gespeichert
        }
      }

      log("info", "system", `Ladestrategie gewechselt auf: ${strategy}`);
      
      // Prowl-Benachrichtigung für Strategie-Wechsel
      triggerProwlEvent(settings, "strategyChanged", (notifier) =>
        notifier.sendStrategyChanged(oldStrategy, strategy)
      );
      
      res.json({ success: true, strategy });
    } catch (error) {
      if (error instanceof z.ZodError) {
        return res.status(400).json({
          error: "Invalid request data",
          details: error.errors,
        });
      }
      log(
        "error",
        "system",
        "Fehler beim Wechseln der Ladestrategie",
        error instanceof Error ? error.message : String(error),
      );
      res.status(500).json({ error: "Failed to switch strategy" });
    }
  });

  app.post("/api/charging/strategy/config", async (req, res) => {
    try {
      const config = chargingStrategyConfigSchema.parse(req.body);
      const settings = storage.getSettings();

      if (!settings) {
        return res.status(400).json({ error: "Settings not found" });
      }

      storage.saveSettings({
        ...settings,
        chargingStrategy: config,
      });

      log("info", "system", "Ladestrategie-Konfiguration aktualisiert");
      res.json({ success: true });
    } catch (error) {
      if (error instanceof z.ZodError) {
        return res.status(400).json({
          error: "Invalid configuration data",
          details: error.errors,
        });
      }
      log(
        "error",
        "system",
        "Fehler beim Speichern der Strategie-Konfiguration",
        error instanceof Error ? error.message : String(error),
      );
      res.status(500).json({ error: "Failed to save strategy configuration" });
    }
  });

  // Hilfsfunktion um aktuelle Zeit in der konfigurierten Zeitzone zu erhalten
  const getCurrentTimeInTimezone = (
    timezone: string = "Europe/Berlin",
  ): string => {
    const now = new Date();
    const formatter = new Intl.DateTimeFormat("de-DE", {
      timeZone: timezone,
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    });

    const parts = formatter.formatToParts(now);
    const hours = parts.find((p) => p.type === "hour")?.value || "00";
    const minutes = parts.find((p) => p.type === "minute")?.value || "00";

    return `${hours}:${minutes}`;
  };

  // Hilfsfunktion für Batterie-Entladesperre (E3DC)
  const lockBatteryDischarge = async (settings: any) => {
    if (settings?.e3dc?.enabled && e3dcClient.isConfigured()) {
      log(
        "info",
        "system",
        `Batterie-Entladesperre: Verwende E3DC-Integration${settings?.demoMode ? " (Demo-Modus)" : ""}`,
      );
      await e3dcClient.lockDischarge();
      
      // Prowl-Benachrichtigung (non-blocking, with initialization guard)
      triggerProwlEvent(settings, "batteryLockActivated", (notifier) =>
        notifier.sendBatteryLockActivated()
      );
    } else {
      log(
        "warning",
        "system",
        `Batterie-Entladesperre: E3DC nicht konfiguriert`,
      );
    }
  };

  const unlockBatteryDischarge = async (settings: any) => {
    if (settings?.e3dc?.enabled && e3dcClient.isConfigured()) {
      log(
        "info",
        "system",
        `Batterie-Entladesperre aufheben: Verwende E3DC-Integration${settings?.demoMode ? " (Demo-Modus)" : ""}`,
      );
      await e3dcClient.unlockDischarge();
      
      // Prowl-Benachrichtigung (non-blocking, with initialization guard)
      triggerProwlEvent(settings, "batteryLockDeactivated", (notifier) =>
        notifier.sendBatteryLockDeactivated()
      );
    } else {
      log(
        "warning",
        "system",
        `Batterie-Entladesperre aufheben: E3DC nicht konfiguriert`,
      );
    }
  };

  // Hilfsfunktion für Netzstrom-Laden (E3DC)
  const enableGridCharging = async (settings: any) => {
    if (settings?.e3dc?.enabled && e3dcClient.isConfigured()) {
      try {
        log(
          "info",
          "system",
          `Netzstrom-Laden: Verwende E3DC-Integration${settings?.demoMode ? " (Demo-Modus)" : ""}`,
        );
        await e3dcClient.enableGridCharge();
        
        // Prowl-Benachrichtigung mit SOC und Zielmenge (non-blocking, with initialization guard)
        const e3dcData = getE3dcModbusService().getLastReadLiveData();
        const socStart = e3dcData?.batterySoc;
        const targetWh = settings?.e3dc?.gridChargeEnableCommand 
          ? extractTargetWh(settings.e3dc.gridChargeEnableCommand)
          : undefined;
        triggerProwlEvent(settings, "gridChargingActivated", (notifier) =>
          notifier.sendGridChargingActivated(socStart, targetWh)
        );
        
        return;
      } catch (error) {
        const errorMessage =
          error instanceof Error ? error.message : JSON.stringify(error);
        log(
          "error",
          "system",
          `E3DC-Fehler beim Aktivieren des Netzstrom-Ladens`,
          errorMessage,
        );
      }
    } else {
      log("warning", "system", `Netzstrom-Laden: E3DC nicht konfiguriert`);
    }
  };

  const disableGridCharging = async (settings: any) => {
    if (settings?.e3dc?.enabled && e3dcClient.isConfigured()) {
      try {
        log(
          "info",
          "system",
          `Netzstrom-Laden deaktivieren: Verwende E3DC-Integration${settings?.demoMode ? " (Demo-Modus)" : ""}`,
        );
        await e3dcClient.disableGridCharge();
        
        // Prowl-Benachrichtigung mit SOC-Ende (non-blocking, with initialization guard)
        const e3dcData = getE3dcModbusService().getLastReadLiveData();
        const socEnd = e3dcData?.batterySoc;
        triggerProwlEvent(settings, "gridChargingDeactivated", (notifier) =>
          notifier.sendGridChargingDeactivated(socEnd)
        );
        
        return;
      } catch (error) {
        const errorMessage =
          error instanceof Error ? error.message : JSON.stringify(error);
        log(
          "error",
          "system",
          `E3DC-Fehler beim Deaktivieren des Netzstrom-Ladens`,
          errorMessage,
        );
      }
    } else {
      log(
        "warning",
        "system",
        `Netzstrom-Laden deaktivieren: E3DC nicht konfiguriert`,
      );
    }
  };

  // === CHARGING STRATEGY SCHEDULER ===
  const checkChargingStrategy = async () => {
    try {
      const settings = storage.getSettings();
      const controlState = storage.getControlState();

      // Skip wenn keine Wallbox IP konfiguriert
      if (!settings?.wallboxIp) {
        return;
      }

      // Context auf "off" setzen wenn Strategy deaktiviert + Wallbox stoppen
      const strategyConfig = settings.chargingStrategy;
      if (!strategyConfig || strategyConfig.activeStrategy === "off") {
        // Lazy-init Controller für stopChargingForStrategyOff
        if (!strategyController) {
          strategyController = new ChargingStrategyController(sendUdpCommand);
        }

        // Wallbox stoppen (falls sie noch lädt)
        await strategyController.stopChargingForStrategyOff(settings.wallboxIp);
        return;
      }

      // Validiere Strategie-Config mit Zod (verhindert Crash bei fehlenden Feldern)
      try {
        chargingStrategyConfigSchema.parse(strategyConfig);
      } catch (error) {
        log(
          "warning",
          "system",
          "Strategie-Config unvollständig - überspringe Ausführung. Bitte Config in Settings vervollständigen.",
        );
        return;
      }

      // Skip wenn Night Charging aktiv (höhere Priorität)
      if (controlState.nightCharging) {
        log("info", "system", "Night Charging aktiv - Strategie pausiert");
        return;
      }

      // Lazy-init Controller
      if (!strategyController) {
        strategyController = new ChargingStrategyController(sendUdpCommand);
      }

      // Hole E3DC Live-Daten (mit Wallbox-Leistung 0 für Überschuss-Berechnung)
      if (!settings.e3dcIp) {
        log(
          "info",
          "system",
          "E3DC IP nicht konfiguriert - Strategie kann nicht ausgeführt werden",
        );
        return;
      }

      const modbusService = getE3dcModbusService();
      if (!modbusService) {
        log(
          "info",
          "system",
          "E3DC Modbus Service nicht verfügbar - Strategie kann nicht ausgeführt werden",
        );
        return;
      }

      // Stelle Verbindung zum E3DC her (falls noch nicht geschehen)
      try {
        await modbusService.connect(settings.e3dcIp);
      } catch (error) {
        log(
          "error",
          "system",
          "Fehler beim Verbinden zum E3DC Modbus Service",
          error instanceof Error ? error.message : String(error),
        );
        return;
      }

      // Hole aktuelle Wallbox-Leistung für korrekte Überschuss-Berechnung
      let currentWallboxPower = 0;
      try {
        const report3 = await sendUdpCommand(settings.wallboxIp, "report 3");
        // Power ist in Report 3 als P (in Milliwatt), dividiert durch 1.000 für Watt
        currentWallboxPower = (report3?.P || 0) / 1000;
      } catch (error) {
        // Falls Wallbox-Abfrage fehlschlägt, nutze 0W als Fallback
        log(
          "debug",
          "system",
          "Wallbox-Abfrage für E3DC-Surplus fehlgeschlagen - nutze 0W",
          error instanceof Error ? error.message : String(error),
        );
      }

      let e3dcLiveData;
      try {
        e3dcLiveData = await modbusService.readLiveData(currentWallboxPower);
      } catch (error) {
        log(
          "error",
          "system",
          "Fehler beim Abrufen der E3DC-Daten",
          error instanceof Error ? error.message : String(error),
        );
        return;
      }

      // Führe Strategie aus
      log(
        "debug",
        "system",
        `Strategy Check: ${strategyConfig.activeStrategy}`,
      );
      await strategyController.processStrategy(
        e3dcLiveData,
        settings.wallboxIp,
      );
    } catch (error) {
      log(
        "error",
        "system",
        "Fehler im Charging Strategy Scheduler",
        error instanceof Error ? error.message : String(error),
      );
    }
  };

  // Scheduler für zeitgesteuerte Ladung
  let isNightChargingOperationInProgress = false;

  const checkNightChargingSchedule = async () => {
    try {
      // Lock-Mechanismus: Verhindert parallele E3DC-Operationen
      if (isNightChargingOperationInProgress) {
        log(
          "debug",
          "system",
          `Scheduler für zeitgesteuerte Ladung: E3DC-Operation läuft bereits - überspringe diesen Tick`,
        );
        return;
      }

      const settings = storage.getSettings();
      const schedule = settings?.nightChargingSchedule;
      const currentState = storage.getControlState();

      const currentTime = getCurrentTimeInTimezone("Europe/Berlin");

      log(
        "debug",
        "system",
        `Scheduler für zeitgesteuerte Ladung läuft - Aktuelle Zeit: ${currentTime}, Zeitsteuerung aktiviert: ${schedule?.enabled}, Zeitfenster: ${schedule?.startTime}-${schedule?.endTime}`,
      );

      // Wenn Scheduler deaktiviert wurde, aber Wallbox noch lädt -> stoppen
      if (!schedule?.enabled) {
        if (currentState.nightCharging) {
          log(
            "info",
            "system",
            `Zeitgesteuerte Ladung: Zeitsteuerung deaktiviert - stoppe Laden`,
          );

          // try/finally für garantierte Lock-Freigabe (Lock MUSS innerhalb try gesetzt werden!)
          try {
            // Lock setzen: Verhindert parallele E3DC-Operationen
            isNightChargingOperationInProgress = true;
            
            // KRITISCH: Setze nightCharging=false SOFORT, BEVOR der lange async E3DC-Befehl läuft
            storage.saveControlState({
              ...currentState,
              nightCharging: false,
              batteryLock: false,
              gridCharging: false,
            });

            // Stoppe die Wallbox (kann fehlschlagen)
            if (settings?.wallboxIp) {
              try {
                await sendUdpCommand(settings.wallboxIp, "ena 0");
              
              // Prowl-Benachrichtigung: Ladung gestoppt (non-blocking)
              triggerProwlEvent(settings, "chargingStopped", (notifier) =>
                notifier.sendChargingStopped("Zeitsteuerung deaktiviert")
              );
            } catch (error) {
              log(
                "error",
                "system",
                "Zeitgesteuerte Ladung: Fehler beim Stoppen der Wallbox (Scheduler deaktiviert)",
                error instanceof Error ? error.message : String(error),
              );
            }
          }

            // Deaktiviere Battery Lock + Grid Charging (KOMBINIERT in einem e3dcset-Aufruf!)
            if (e3dcClient.isConfigured()) {
              try {
                log(
                  "info",
                  "system",
                  `Zeitgesteuerte Ladung: Deaktiviere Battery Lock + Grid Charging (Scheduler deaktiviert, kombiniert)`,
                );
                
                // KOMBINIERTER Aufruf: Battery Lock + Grid Charging deaktivieren in einem e3dcset-Befehl
                await e3dcClient.disableNightCharging();
                
                // Prowl-Benachrichtigung: Battery Lock deaktiviert (non-blocking)
                triggerProwlEvent(settings, "batteryLockDeactivated", (notifier) =>
                  notifier.sendBatteryLockDeactivated()
                );
                
                // Prowl-Benachrichtigung: Grid Charging deaktiviert mit SOC-Ende (falls war aktiv, non-blocking)
                if (currentState.gridCharging) {
                  const e3dcData = getE3dcModbusService().getLastReadLiveData();
                  const socEnd = e3dcData?.batterySoc;
                  triggerProwlEvent(settings, "gridChargingDeactivated", (notifier) =>
                    notifier.sendGridChargingDeactivated(socEnd)
                  );
                }
              } catch (error) {
                log(
                  "error",
                  "system",
                  "Fehler beim Deaktivieren von Night Charging (Scheduler deaktiviert) - State wird zurückgerollt",
                  error instanceof Error ? error.message : String(error),
                );
                // Rollback: Setze KOMPLETTEN State zurück (inkl. gridCharging!)
                storage.saveControlState(currentState);
                return; // Abbruch
              }
            } else {
              log(
                "warning",
                "system",
                `Zeitgesteuerte Ladung: E3DC nicht konfiguriert - Battery Lock nicht deaktiviert`,
              );
            }
          } finally {
            // Lock IMMER freigeben, auch bei Fehlern
            isNightChargingOperationInProgress = false;
          }
        }
        return;
      }

      const isInTimeWindow = isTimeInRange(
        currentTime,
        schedule.startTime,
        schedule.endTime,
      );

      if (isInTimeWindow && !currentState.nightCharging) {
        log(
          "info",
          "system",
          `Zeitgesteuerte Ladung: Zeitfenster erreicht (${schedule.startTime}-${schedule.endTime}) - starte Laden`,
        );

        // try/finally für garantierte Lock-Freigabe (Lock MUSS innerhalb try gesetzt werden!)
        try {
          // Lock setzen: Verhindert parallele E3DC-Operationen
          isNightChargingOperationInProgress = true;
          
          // KRITISCH: Setze nightCharging=true SOFORT, BEVOR der lange async E3DC-Befehl läuft
          // Verhindert dass der nächste Scheduler-Tick (00:01) den Befehl nochmal ausführt
          const withGridCharging = e3dcClient.isConfigured() && e3dcClient.isGridChargeDuringNightChargingEnabled();
          storage.saveControlState({
            ...currentState,
            nightCharging: true,
            batteryLock: true,
            gridCharging: withGridCharging,
          });

          // Aktiviere Batterie-Entladesperre + optional Grid Charging (KOMBINIERT in einem e3dcset-Aufruf!)
          let gridChargingSuccess = false;
          if (e3dcClient.isConfigured()) {
            try {
              log(
                "info",
                "system",
                withGridCharging
                  ? `Zeitgesteuerte Ladung: Aktiviere Battery Lock + Grid Charging (kombiniert)`
                  : `Zeitgesteuerte Ladung: Aktiviere Battery Lock`,
              );
              
              // KOMBINIERTER Aufruf: Battery Lock + Grid Charging in einem e3dcset-Befehl
              await e3dcClient.enableNightCharging(withGridCharging);
              gridChargingSuccess = true;
              
              // Prowl-Benachrichtigung: Battery Lock aktiviert (non-blocking)
              triggerProwlEvent(settings, "batteryLockActivated", (notifier) =>
                notifier.sendBatteryLockActivated()
              );
              
              // Prowl-Benachrichtigung: Grid Charging aktiviert mit SOC und Zielmenge (falls aktiviert, non-blocking)
              if (withGridCharging) {
                const e3dcData = getE3dcModbusService().getLastReadLiveData();
                const socStart = e3dcData?.batterySoc;
                const targetWh = settings?.e3dc?.gridChargeEnableCommand 
                  ? extractTargetWh(settings.e3dc.gridChargeEnableCommand)
                  : undefined;
                triggerProwlEvent(settings, "gridChargingActivated", (notifier) =>
                  notifier.sendGridChargingActivated(socStart, targetWh)
                );
              }
            } catch (error) {
              log(
                "error",
                "system",
                "Fehler beim Aktivieren von Night Charging - State wird zurückgerollt",
                error instanceof Error ? error.message : String(error),
              );
              // Rollback: Setze KOMPLETTEN State zurück (inkl. gridCharging!)
              storage.saveControlState(currentState);
              return; // Abbruch, keine Wallbox-Aktivierung
            }
          } else {
            log(
              "warning",
              "system",
              `Zeitgesteuerte Ladung: E3DC nicht konfiguriert - Battery Lock nicht aktiviert`,
            );
          }

          // Korrigiere gridCharging-State basierend auf tatsächlichem Ergebnis
          if (gridChargingSuccess && withGridCharging) {
            // State war korrekt, nichts zu tun
          } else {
            // Grid Charging wurde nicht aktiviert (z.B. E3DC nicht konfiguriert)
            storage.saveControlState({
              ...currentState,
              nightCharging: true,
              batteryLock: true,
              gridCharging: false,
            });
          }

          // Dann starte die Wallbox (kann fehlschlagen, aber Batterie-Sperre ist bereits aktiv)
          if (settings?.wallboxIp) {
            try {
              await sendUdpCommand(settings.wallboxIp, "ena 1");
              
              // Prowl-Benachrichtigung: Ladung gestartet (non-blocking)
              const context = storage.getChargingContext();
              const phases = context.currentPhases || 1;
              const current = phases === 1 ? 32 : 16;
              triggerProwlEvent(settings, "chargingStarted", (notifier) =>
                notifier.sendChargingStarted(current, phases, "Nachtladung")
              );
            } catch (error) {
              log(
                "error",
                "system",
                "Zeitgesteuerte Ladung: Fehler beim Starten der Wallbox (Batterie-Sperre ist aktiv)",
                error instanceof Error ? error.message : String(error),
              );
            }
          }
        } finally {
          // Lock IMMER freigeben, auch bei Fehlern
          isNightChargingOperationInProgress = false;
        }
      } else if (!isInTimeWindow && currentState.nightCharging) {
        log(
          "info",
          "system",
          `Zeitgesteuerte Ladung: Zeitfenster beendet - stoppe Laden`,
        );

        // try/finally für garantierte Lock-Freigabe (Lock MUSS innerhalb try gesetzt werden!)
        try {
          // Lock setzen: Verhindert parallele E3DC-Operationen
          isNightChargingOperationInProgress = true;
          
          // KRITISCH: Setze nightCharging=false SOFORT, BEVOR der lange async E3DC-Befehl läuft
          // Verhindert dass der nächste Scheduler-Tick (05:01) den Befehl nochmal ausführt
          storage.saveControlState({
            ...currentState,
            nightCharging: false,
            batteryLock: false,
            gridCharging: false,
          });

          // Stoppe die Wallbox (kann fehlschlagen)
          if (settings?.wallboxIp) {
            try {
              await sendUdpCommand(settings.wallboxIp, "ena 0");
              
              // Prowl-Benachrichtigung: Ladung gestoppt (non-blocking)
              triggerProwlEvent(settings, "chargingStopped", (notifier) =>
                notifier.sendChargingStopped("Zeitfenster beendet")
              );
            } catch (error) {
              log(
                "error",
                "system",
                "Zeitgesteuerte Ladung: Fehler beim Stoppen der Wallbox",
                error instanceof Error ? error.message : String(error),
              );
            }
          }

          // Deaktiviere Battery Lock + Grid Charging (KOMBINIERT in einem e3dcset-Aufruf!)
          if (e3dcClient.isConfigured()) {
            try {
              log(
                "info",
                "system",
                `Zeitgesteuerte Ladung: Deaktiviere Battery Lock + Grid Charging (kombiniert)`,
              );
              
              // KOMBINIERTER Aufruf: Battery Lock + Grid Charging deaktivieren in einem e3dcset-Befehl
              await e3dcClient.disableNightCharging();
              
              // Prowl-Benachrichtigung: Battery Lock deaktiviert (non-blocking)
              triggerProwlEvent(settings, "batteryLockDeactivated", (notifier) =>
                notifier.sendBatteryLockDeactivated()
              );
              
              // Prowl-Benachrichtigung: Grid Charging deaktiviert mit SOC-Ende (falls war aktiv, non-blocking)
              if (currentState.gridCharging) {
                const e3dcData = getE3dcModbusService().getLastReadLiveData();
                const socEnd = e3dcData?.batterySoc;
                triggerProwlEvent(settings, "gridChargingDeactivated", (notifier) =>
                  notifier.sendGridChargingDeactivated(socEnd)
                );
              }
            } catch (error) {
              log(
                "error",
                "system",
                "Fehler beim Deaktivieren von Night Charging - State wird zurückgerollt",
                error instanceof Error ? error.message : String(error),
              );
              // Rollback: Setze KOMPLETTEN State zurück (inkl. gridCharging!)
              storage.saveControlState(currentState);
              return; // Abbruch
            }
          } else {
            log(
              "warning",
              "system",
              `Zeitgesteuerte Ladung: E3DC nicht konfiguriert - Battery Lock nicht deaktiviert`,
            );
          }
        } finally {
          // Lock IMMER freigeben, auch bei Fehlern
          isNightChargingOperationInProgress = false;
        }
      }
    } catch (error) {
      log(
        "error",
        "system",
        "Fehler beim Scheduler für zeitgesteuerte Ladung",
        String(error),
      );
    }
  };

  // Hilfsfunktion um zu prüfen ob eine Zeit in einem Zeitfenster liegt
  const isTimeInRange = (
    current: string,
    start: string,
    end: string,
  ): boolean => {
    const [currentH, currentM] = current.split(":").map(Number);
    const [startH, startM] = start.split(":").map(Number);
    const [endH, endM] = end.split(":").map(Number);

    const currentMinutes = currentH * 60 + currentM;
    const startMinutes = startH * 60 + startM;
    const endMinutes = endH * 60 + endM;

    // Handle overnight time windows (e.g., 23:00 - 05:00)
    if (endMinutes < startMinutes) {
      return currentMinutes >= startMinutes || currentMinutes < endMinutes;
    }

    return currentMinutes >= startMinutes && currentMinutes < endMinutes;
  };

  // Lade E3DC-Konfiguration beim Start wenn vorhanden
  const initialSettings = storage.getSettings();
  if (initialSettings?.e3dc?.enabled) {
    try {
      e3dcClient.configure(initialSettings.e3dc);
      log("info", "system", "E3DC-Konfiguration beim Start geladen");
    } catch (error) {
      log(
        "error",
        "system",
        "Fehler beim Laden der E3DC-Konfiguration beim Start",
        error instanceof Error ? error.message : String(error),
      );
    }
  }

  // Starte Scheduler synchronisiert zur vollen Minute
  log(
    "info",
    "system",
    "Scheduler für zeitgesteuerte Ladung wird gestartet - prüft jede volle Minute",
  );

  // Berechne Verzögerung bis zur nächsten vollen Minute
  const now = new Date();
  const secondsUntilNextMinute = 60 - now.getSeconds();
  const msUntilNextMinute =
    secondsUntilNextMinute * 1000 - now.getMilliseconds();

  log(
    "debug",
    "system",
    `Scheduler-Synchronisation: Nächste Prüfung in ${secondsUntilNextMinute}s zur vollen Minute`,
  );

  // Erste Prüfung zur nächsten vollen Minute
  if (!nightChargingSchedulerInterval) {
    setTimeout(() => {
      checkNightChargingSchedule();

      // Danach jede Minute exakt zur vollen Minute
      nightChargingSchedulerInterval = setInterval(
        checkNightChargingSchedule,
        60 * 1000,
      );
    }, msUntilNextMinute);
  }

  // Initiale Prüfung beim Start (optional - prüft sofort)
  checkNightChargingSchedule();

  // === STARTE CHARGING STRATEGY EVENT-LISTENER ===
  // Primär: Event-driven via E3DC-Hub (~1ms Latenz)
  // Sekundär: 15s-Timer als Health-Check/Fallback
  const currentSettings = storage.getSettings();
  const wallboxIp = currentSettings?.wallboxIp || "192.168.40.16";
  
  // Initialisiere Controller wenn noch nicht vorhanden
  if (!strategyController) {
    strategyController = new ChargingStrategyController(sendUdpCommand);
  }
  
  await strategyController.startEventListener(wallboxIp);
  
  log(
    "info",
    "system",
    "Charging Strategy Scheduler wird gestartet - Event-driven (primär) + 15s-Timer (Fallback)",
  );
  
  // 15s-Timer als Fallback/Health-Check
  if (!chargingStrategyInterval) {
    chargingStrategyInterval = setInterval(() => {
      log("debug", "strategy", "Fallback-Timer: Health-Check Charging Strategy");
      checkChargingStrategy();
    }, 15 * 1000);
  }

  // === STARTE E3DC-BACKGROUND-POLLER ===
  // Liest alle 10s E3DC-Daten im Hintergrund - unabhängig von Clients oder Strategien
  if (!e3dcPollerInterval) {
    e3dcPollerInterval = startE3dcPoller();
  }

  // === STARTE FHEM-E3DC-SYNC SCHEDULER ===
  // Startet separaten 10s-Scheduler, damit FHEM auch Updates bekommt wenn kein Client aktiv ist
  if (!fhemSyncInterval) {
    fhemSyncInterval = startFhemSyncScheduler();
  }

  const httpServer = createServer(app);

  // SSE-Server für Echtzeit-Wallbox-Updates ist bereits via /api/wallbox/stream konfiguriert
  log("info", "system", "SSE-Server für Wallbox-Status-Updates bereit");

  return httpServer;
}

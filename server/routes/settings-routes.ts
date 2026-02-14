import type { Express } from "express";
import { storage } from "../storage";
import {
  settingsSchema,
  controlStateSchema,
  logSettingsSchema,
  type ControlState,
  chargingStrategyConfigSchema,
  chargingStrategySchema,
} from "@shared/schema";
import { e3dcClient } from "../e3dc-client";
import { log } from "../logger";
import { DEFAULT_WALLBOX_IP } from "../defaults";
import { z } from "zod";
import { wallboxMockService } from "../wallbox-mock";
import { sendUdpCommand } from "../wallbox-transport";
import { getBuildInfo } from "../build-info";
import { triggerProwlEvent, getProwlNotifier } from "../prowl-notifier";
import { callSmartHomeUrl } from "./helpers";
import {
  getOrCreateStrategyController,
  strategyController,
  lockBatteryDischarge,
  unlockBatteryDischarge,
  enableGridCharging,
  disableGridCharging,
} from "./shared-state";

export function registerSettingsRoutes(app: Express): void {
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
        const controller = getOrCreateStrategyController();

        try {
          log("info", "system", `Ladestrategie gewechselt auf: ${newStrategy}`);
          await controller.handleStrategyChange(newStrategy);
          
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

      // WICHTIG: Optimierte Reihenfolge für schnelle Wallbox-Reaktion
      if (strategyController) {
        try {
          const wallboxIp = settings.wallboxIp || DEFAULT_WALLBOX_IP;
          
          if (strategy === "max_without_battery") {
            // START: Wallbox SOFORT starten, Battery Lock DANACH
            await strategyController.activateMaxPowerImmediately(wallboxIp);
          } else if (strategy === "off") {
            // STOPP: Wallbox SOFORT stoppen, Battery Lock DANACH deaktivieren
            log("info", "system", "Strategie 'off' - Wallbox wird SOFORT gestoppt");
            
            // 1. Wallbox SOFORT stoppen (keine Verzögerung!)
            await strategyController.stopChargingOnly(wallboxIp, "Strategie auf 'off' gesetzt");
            
            // 2. Context auf off setzen
            storage.updateChargingContext({ 
              isActive: false, 
              strategy: "off",
              currentAmpere: 0,
              targetAmpere: 0,
            });
            
            // 3. Battery Lock DANACH deaktivieren (sequentiell, blockiert UI nicht mehr)
            await strategyController.handleStrategyChange(strategy);
          } else {
            // Andere Strategien: Event-driven Flow
            await strategyController.handleStrategyChange(strategy);
            
            // Sofortiger Check nach Strategiewechsel (vermeidet 0-15s Verzögerung)
            try {
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
}

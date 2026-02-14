import type { Express } from "express";
import { storage } from "../core/storage";
import { chargingStrategySchema, type ChargingStrategy } from "@shared/schema";
import { log } from "../core/logger";
import { sendUdpCommand } from "../wallbox/transport";
import { initSSEClient, broadcastWallboxStatus } from "../wallbox/sse";
import { getOrCreateStrategyController } from "./shared-state";

export function registerWallboxRoutes(app: Express): void {
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
          const controller = getOrCreateStrategyController();
          
          // WICHTIG: Battery Lock aktivieren/deaktivieren basierend auf Strategie
          if (strategyToActivate) {
            if (strategyToActivate === "max_without_battery") {
              // X1-Optimierung: Schneller Pfad (Wallbox → SSE → Battery Lock async)
              await controller.activateMaxPowerImmediately(settings.wallboxIp);
              log("info", "wallbox", `Laden erfolgreich gestartet`);
            } else {
              // Normale Strategien: Event-driven Flow
              await controller.handleStrategyChange(strategyToActivate);
              
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
          const controller = getOrCreateStrategyController();
          await controller.handleStrategyChange("off");

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

  app.get("/api/wallbox/plug-tracking", (req, res) => {
    const tracking = storage.getPlugStatusTracking();
    res.json(tracking);
  });
}

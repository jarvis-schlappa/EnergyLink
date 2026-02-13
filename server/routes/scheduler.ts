import { storage } from "../storage";
import { chargingStrategyConfigSchema } from "@shared/schema";
import { e3dcClient } from "../e3dc-client";
import { getE3dcModbusService } from "../e3dc-modbus";
import { log } from "../logger";
import { sendUdpCommand } from "../wallbox-transport";
import { startFhemSyncScheduler, stopFhemSyncScheduler } from "../fhem-e3dc-sync";
import { startE3dcPoller, stopE3dcPoller, getE3dcBackoffLevel } from "../e3dc-poller";
import { triggerProwlEvent, extractTargetWh } from "../prowl-notifier";
import { startGridFrequencyMonitor, stopGridFrequencyMonitor } from "../grid-frequency-monitor";
import { getCurrentTimeInTimezone, isTimeInRange } from "./helpers";
import {
  chargingStrategyInterval,
  nightChargingSchedulerInterval,
  fhemSyncInterval,
  e3dcPollerInterval,
  strategyController,
  setChargingStrategyInterval,
  setNightChargingSchedulerInterval,
  setFhemSyncInterval,
  setE3dcPollerInterval,
  getOrCreateStrategyController,
} from "./shared-state";

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
    setChargingStrategyInterval(null);
    log("info", "system", "Charging-Strategy-Fallback-Timer gestoppt");
  }
  
  if (nightChargingSchedulerInterval) {
    clearInterval(nightChargingSchedulerInterval);
    setNightChargingSchedulerInterval(null);
    log("info", "system", "Night-Charging-Scheduler gestoppt");
  }
  
  // Stoppe FHEM-Sync-Scheduler (wartet auf laufenden Sync)
  await stopFhemSyncScheduler(fhemSyncInterval);
  setFhemSyncInterval(null);
  
  // Stoppe E3DC-Background-Poller (wartet auf laufenden Poll)
  await stopE3dcPoller();
  setE3dcPollerInterval(null);
  
  // Stoppe Netzfrequenz-Monitor
  stopGridFrequencyMonitor();
  
  log("info", "system", "Alle Scheduler erfolgreich gestoppt");
}

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
      const controller = getOrCreateStrategyController();

      // Wallbox stoppen (falls sie noch lädt)
      await controller.stopChargingForStrategyOff(settings.wallboxIp);
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

    const controller = getOrCreateStrategyController();

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
    await controller.processStrategy(
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

/**
 * Startet alle Scheduler (Night Charging, Charging Strategy, E3DC Poller, FHEM Sync, Grid Frequency)
 * Wird von registerRoutes() aufgerufen.
 */
export async function startSchedulers(): Promise<void> {
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
      setNightChargingSchedulerInterval(setInterval(
        checkNightChargingSchedule,
        60 * 1000,
      ));
    }, msUntilNextMinute);
  }

  // Initiale Prüfung beim Start (optional - prüft sofort)
  checkNightChargingSchedule();

  // === STARTE CHARGING STRATEGY EVENT-LISTENER ===
  const currentSettings = storage.getSettings();
  const wallboxIp = currentSettings?.wallboxIp || "192.168.40.16";
  
  const controller = getOrCreateStrategyController();
  
  await controller.startEventListener(wallboxIp);
  
  log(
    "info",
    "system",
    "Charging Strategy Scheduler wird gestartet - Event-driven (primär) + 15s-Timer (Fallback)",
  );
  
  // 15s-Timer als Fallback/Health-Check
  if (!chargingStrategyInterval) {
    setChargingStrategyInterval(setInterval(() => {
      log("debug", "strategy", "Fallback-Timer: Health-Check Charging Strategy");
      checkChargingStrategy();
    }, 15 * 1000));
  }

  // === STARTE E3DC-BACKGROUND-POLLER ===
  if (!e3dcPollerInterval) {
    setE3dcPollerInterval(startE3dcPoller());
  }

  // === STARTE NETZFREQUENZ-MONITOR ===
  startGridFrequencyMonitor();

  // === STARTE FHEM-E3DC-SYNC SCHEDULER ===
  if (!fhemSyncInterval) {
    setFhemSyncInterval(startFhemSyncScheduler());
  }
}

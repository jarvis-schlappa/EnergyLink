/**
 * Wallbox Broadcast Listener
 *
 * Lauscht auf UDP-Broadcasts der KEBA Wallbox auf Port 7090.
 * Reagiert auf verschiedene Broadcast-Typen:
 * - Input → Ladestrategie-Wechsel basierend auf potenzialfreiem Kontakt X1
 * - Plug → Kabelstatus-Änderungen in Echtzeit
 * - E pres → Session-Energie während der Ladung
 * - State → Wallbox-Status-Änderungen
 *
 * Verwendet den zentralen UDP-Channel (kein eigener Socket).
 */

import { log } from "./logger";
import { storage } from "./storage";
import { wallboxUdpChannel } from "./wallbox-udp-channel";
import { ChargingStrategyController } from "./charging-strategy-controller";
import { getProwlNotifier } from "./prowl-notifier";
import { broadcastWallboxStatus } from "./wallbox-sse";

let lastInputStatus: number | null = null;
let lastPlugStatus: number | null = null;
let lastState: number | null = null;
let isEnabled = false;
let strategyController: ChargingStrategyController | null = null;
let sendUdpCommand: ((ip: string, command: string) => Promise<any>) | null =
  null;

// Handler für Broadcast-Nachrichten (async für stopChargingForStrategyOff)
const handleBroadcast = async (data: any, rinfo: any) => {
  let targetStrategy: any = null;

  try {
    // Verarbeite Plug-Status-Broadcasts
    // Nutzt In-Memory-Tracking für schnelle Änderungs-Erkennung
    if (data.Plug !== undefined) {
      const plugStatus = data.Plug;

      // Beim ersten Broadcast: Vergleiche mit gespeichertem Status
      if (lastPlugStatus === null) {
        try {
          const tracking = storage.getPlugStatusTracking();
          const savedStatus = tracking?.lastPlugStatus;
          
          // Prüfe ob sich der Status seit letztem App-Lauf geändert hat
          if (savedStatus !== undefined && savedStatus !== plugStatus) {
            log(
              "info",
              "system",
              `[Wallbox-Broadcast-Listener] Plug-Status geändert (seit letztem Start): ${savedStatus} → ${plugStatus} (von ${rinfo.address})`,
            );
            
            // Speichere neuen Status
            storage.savePlugStatusTracking({
              lastPlugStatus: plugStatus,
              lastPlugChange: new Date().toISOString(),
            });
            
            // Prowl-Benachrichtigung senden
            const settingsForProwl = storage.getSettings();
            if (settingsForProwl?.prowl?.enabled) {
              const prowl = getProwlNotifier();
              
              // Auto wurde angesteckt (Wechsel zu Plug=7)
              if (plugStatus === 7 && settingsForProwl?.prowl?.events?.plugConnected) {
                void prowl.sendPlugConnected();
              } 
              // Auto wurde abgesteckt (Wechsel von Plug=7 zu niedrigerem Status)
              else if (savedStatus === 7 && plugStatus < 7 && settingsForProwl?.prowl?.events?.plugDisconnected) {
                void prowl.sendPlugDisconnected();
              }
            }
          } else {
            // Kein Wechsel - nur initialisieren
            storage.savePlugStatusTracking({
              lastPlugStatus: plugStatus,
            });
          }
        } catch (error) {
          // Fallback: Initialisiere ohne Vergleich
          storage.savePlugStatusTracking({
            lastPlugStatus: plugStatus,
          });
        }
        
        lastPlugStatus = plugStatus;
        return;
      }

      // Normale Broadcast-Verarbeitung (nicht der erste)
      if (lastPlugStatus !== plugStatus) {
        log(
          "info",
          "system",
          `[Wallbox-Broadcast-Listener] Plug-Status geändert: ${lastPlugStatus} → ${plugStatus} (von ${rinfo.address})`,
        );

        // Aktualisiere Plug-Tracking mit Zeitstempel
        try {
          storage.savePlugStatusTracking({
            lastPlugStatus: plugStatus,
            lastPlugChange: new Date().toISOString(),
          });
        } catch (error) {
          log(
            "error",
            "system",
            "[Wallbox-Broadcast-Listener] Fehler beim Speichern des Plug-Status:",
            error instanceof Error ? error.message : String(error),
          );
        }
        
        // Prowl-Benachrichtigung (non-blocking, with initialization guard)
        try {
          const settingsForProwl = storage.getSettings();
          
          if (settingsForProwl?.prowl?.enabled) {
            const prowl = getProwlNotifier();
            
            // KEBA Plug-Status-Werte:
            // Plug=1 = Kein Kabel an Wallbox
            // Plug=3 = Kabel angesteckt, kein Auto (Auto abgesteckt)
            // Plug=7 = Auto angesteckt (Kabel + Auto verbunden)
            
            // Auto wurde angesteckt (Wechsel zu Plug=7)
            if (plugStatus === 7 && settingsForProwl?.prowl?.events?.plugConnected) {
              void prowl.sendPlugConnected();
            } 
            // Auto wurde abgesteckt (Wechsel von Plug=7 zu niedrigerem Status)
            else if (lastPlugStatus === 7 && plugStatus < 7 && settingsForProwl?.prowl?.events?.plugDisconnected) {
              void prowl.sendPlugDisconnected();
            }
          }
        } catch (error) {
          log("debug", "system", "Prowl-Notifier nicht initialisiert - überspringe Benachrichtigung");
        }
        
        // WebSocket-Broadcast: Hol aktuellen Status und push zu Clients
        void fetchAndBroadcastStatus("Plug-Änderung");
      }

      // Update In-Memory-Tracker für nächsten Broadcast
      lastPlugStatus = plugStatus;
    }

    // Verarbeite State-Broadcasts
    // DESIGN: State wird nur geloggt, nicht persistiert.
    // Grund: Wallbox-Status wird bereits durch /api/wallbox/status Polling abgerufen.
    // Dieser Handler dient als zusätzliche Debugging-Information für schnellere Erkennung.
    if (data.State !== undefined) {
      const state = data.State;

      if (state !== lastState && lastState !== null) {
        const stateNames: Record<number, string> = {
          0: "starting",
          1: "not ready for charging",
          2: "ready for charging",
          3: "charging",
          4: "error",
          5: "authorization rejected",
        };

        log(
          "info",
          "system",
          `[Wallbox-Broadcast-Listener] State geändert: ${lastState} → ${state} (${stateNames[state] || "unknown"}) (von ${rinfo.address})`,
        );
        
        // WebSocket-Broadcast: Hol aktuellen Status und push zu Clients
        void fetchAndBroadcastStatus("State-Änderung");
      }

      lastState = state;
    }

    // Verarbeite E pres-Broadcasts (während Ladung)
    // Throttle E pres Logging um Log-Flooding zu vermeiden (alle 3s von Mock)
    if (data["E pres"] !== undefined) {
      // E pres wird vom Frontend per Polling abgerufen
      // Kein Logging nötig (würde Logs überschwemmen bei 3s-Interval)
    }

    // Reagiere auf Input-Broadcasts (Ladestrategie-Wechsel)
    if (data.Input === undefined) {
      return; // Keine Input-Änderung
    }

    const inputStatus = data.Input;

    // Nur reagieren wenn sich der Status ändert
    if (inputStatus === lastInputStatus) {
      return;
    }

    // Initial-Sync: Erster Broadcast initialisiert nur den Baseline-State
    // Verhindert ungewollte Strategiewechsel beim App-Start
    if (lastInputStatus === null) {
      lastInputStatus = inputStatus;
      log(
        "debug",
        "system",
        `[Wallbox-Broadcast-Listener] Initial-Sync: Input=${inputStatus} (von ${rinfo.address})`,
      );
      return; // Keine Controller-Aktionen beim ersten Broadcast
    }

    log(
      "info",
      "system",
      `[Wallbox-Broadcast-Listener] Input-Status geändert: ${lastInputStatus} → ${inputStatus} (von ${rinfo.address})`,
    );
    lastInputStatus = inputStatus;

    // Reagiere auf Input-Änderung
    if (inputStatus === 1) {
      // Hole konfigurierte Strategie aus den Einstellungen
      const settings = storage.getSettings();
      targetStrategy =
        settings?.chargingStrategy?.inputX1Strategy ?? "max_without_battery";

      log(
        "info",
        "system",
        `[Wallbox-Broadcast-Listener] Aktiviere Ladestrategie: ${targetStrategy}`,
      );

      // WICHTIG: Battery Lock aktivieren (für E3DC S10) wenn Strategie max_without_battery
      if (strategyController) {
        try {
          await strategyController.handleStrategyChange(targetStrategy);
        } catch (error) {
          log(
            "error",
            "system",
            "[Wallbox-Broadcast-Listener] Strategie-Wechsel fehlgeschlagen:",
            error instanceof Error ? error.message : String(error),
          );
          // Fortfahren - Strategie wird trotzdem gesetzt (finally-Block)
        }
      } else {
        log(
          "warning",
          "system",
          "[Wallbox-Broadcast-Listener] ChargingStrategyController nicht verfügbar",
        );
      }
    } else if (inputStatus === 0) {
      targetStrategy = "off";
      log(
        "info",
        "system",
        "[Wallbox-Broadcast-Listener] Deaktiviere Ladestrategie: Aus",
      );

      // Verwende den ChargingStrategyController für zentralisierte Stopp-Logik
      const settings = storage.getSettings();
      if (settings?.wallboxIp && strategyController) {
        try {
          await strategyController.stopChargingForStrategyOff(
            settings.wallboxIp,
          );
        } catch (error) {
          log(
            "error",
            "system",
            "[Wallbox-Broadcast-Listener] Wallbox stoppen fehlgeschlagen:",
            error instanceof Error ? error.message : String(error),
          );
          // Fortfahren - Strategie wird trotzdem auf "off" gesetzt (finally-Block)
        }
      } else {
        log(
          "warning",
          "system",
          "[Wallbox-Broadcast-Listener] ChargingStrategyController nicht verfügbar - Wallbox nicht gestoppt",
        );
      }
    }
  } catch (error) {
    log(
      "error",
      "system",
      "[Wallbox-Broadcast-Listener] Nachricht verarbeiten fehlgeschlagen:",
      error instanceof Error ? error.message : String(error),
    );
  } finally {
    // KRITISCH: Strategie IMMER setzen, auch wenn Controller-Aufrufe fehlschlagen
    // Dies verhindert inkonsistente States zwischen Input und Strategie
    if (targetStrategy !== null) {
      try {
        // WICHTIG: Context NACH Controller-Aufrufen neu laden, um Updates nicht zu überschreiben
        const freshContext = storage.getChargingContext();

        // Nur Strategie ändern, wenn sie sich vom Ziel unterscheidet
        if (freshContext.strategy !== targetStrategy) {
          storage.saveChargingContext({
            ...freshContext,
            strategy: targetStrategy,
          });
          log(
            "info",
            "system",
            `[Wallbox-Broadcast-Listener] Strategie persistent gesetzt: ${targetStrategy}`,
          );
        }

        const settings = storage.getSettings();
        if (
          settings?.chargingStrategy &&
          settings.chargingStrategy.activeStrategy !== targetStrategy
        ) {
          settings.chargingStrategy.activeStrategy = targetStrategy;
          storage.saveSettings(settings);
          log(
            "info",
            "system",
            `[Wallbox-Broadcast-Listener] Settings persistent gesetzt: ${targetStrategy}`,
          );
        }
      } catch (persistError) {
        log(
          "error",
          "system",
          "[Wallbox-Broadcast-Listener] KRITISCH: Strategie-Persistierung fehlgeschlagen:",
          persistError instanceof Error
            ? persistError.message
            : String(persistError),
        );
      }
    }
  }
};

/**
 * Holt aktuellen Wallbox-Status und broadcastet ihn an WebSocket-Clients
 * Wird bei Plug- und State-Änderungen aufgerufen
 */
async function fetchAndBroadcastStatus(reason: string): Promise<void> {
  try {
    const settings = storage.getSettings();
    if (!settings?.wallboxIp || !sendUdpCommand) {
      return;
    }

    // Hole vollständigen Status (wie in /api/wallbox/status)
    const report1 = await sendUdpCommand(settings.wallboxIp, "report 1");
    const report2 = await sendUdpCommand(settings.wallboxIp, "report 2");
    const report3 = await sendUdpCommand(settings.wallboxIp, "report 3");

    // Phasenzahl aus Strömen ableiten
    const i1 = report3?.["I1"] || 0;
    const i2 = report3?.["I2"] || 0;
    const i3 = report3?.["I3"] || 0;
    const CURRENT_THRESHOLD = 100; // mA
    let activePhaseCount = 0;
    if (i1 > CURRENT_THRESHOLD) activePhaseCount++;
    if (i2 > CURRENT_THRESHOLD) activePhaseCount++;
    if (i3 > CURRENT_THRESHOLD) activePhaseCount++;

    const status = {
      state: report2?.State || 0,
      plug: report2?.Plug || 0,
      input: report2?.Input,
      enableSys: report2["Enable sys"] || 0,
      maxCurr: (report2["Max curr"] || 0) / 1000,
      ePres: (report3["E pres"] || 0) / 10,
      eTotal: (report3["E total"] || 0) / 10,
      power: (report3?.P || 0) / 1000000,
      phases: activePhaseCount,
      i1: i1 / 1000,
      i2: i2 / 1000,
      i3: i3 / 1000,
      lastUpdated: new Date().toISOString(),
    };

    // Broadcast zu allen WebSocket-Clients
    broadcastWallboxStatus(status);
    log("debug", "system", `[WebSocket] Broadcast gesendet (${reason})`);
  } catch (error) {
    log("debug", "system", "[WebSocket] Fehler beim Status-Abruf für Broadcast:", error instanceof Error ? error.message : String(error));
  }
}

export async function startBroadcastListener(
  udpCommandSender: (ip: string, command: string) => Promise<any>,
): Promise<void> {
  if (isEnabled) {
    log("debug", "system", "[Wallbox-Broadcast-Listener] Läuft bereits");
    return;
  }

  // Speichere sendUdpCommand für ChargingStrategyController
  sendUdpCommand = udpCommandSender;
  strategyController = new ChargingStrategyController(udpCommandSender);

  // Registriere Broadcast-Handler beim UDP-Channel
  wallboxUdpChannel.onBroadcast(handleBroadcast);

  isEnabled = true;

  // Hole konfigurierte X1-Strategie für Logging
  const settings = storage.getSettings();
  const x1Strategy =
    settings?.chargingStrategy?.inputX1Strategy ?? "max_without_battery";

  log(
    "info",
    "system",
    "✅ [Wallbox-Broadcast-Listener] Lauscht auf Wallbox-Broadcasts (Port 7090)",
  );
  log(
    "info",
    "system",
    `   - Input → Ladestrategie-Wechsel (X1=1: '${x1Strategy}', X1=0: 'Aus')`,
  );
  log("info", "system", "   - Plug → Kabelstatus-Tracking in Echtzeit");
  log("info", "system", "   - State → Wallbox-Status-Änderungen");
  log("info", "system", "   - E pres → Session-Energie während Ladung");
}

export async function stopBroadcastListener(): Promise<void> {
  if (!isEnabled) {
    return;
  }

  // Deregistriere Handler
  wallboxUdpChannel.offBroadcast(handleBroadcast);

  isEnabled = false;
  lastInputStatus = null;
  lastPlugStatus = null;
  lastState = null;
  strategyController = null;
  sendUdpCommand = null;
  log("info", "system", "✅ [Wallbox-Broadcast-Listener] Gestoppt");
}

export function isBroadcastListenerEnabled(): boolean {
  return isEnabled;
}

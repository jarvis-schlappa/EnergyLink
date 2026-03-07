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

import { log } from "../core/logger";
import { storage } from "../core/storage";
import { wallboxUdpChannel } from "./udp-channel";
import { getOrCreateStrategyController } from "../routes/shared-state";
import { getProwlNotifier, triggerProwlEvent } from "../monitoring/prowl-notifier";
import { broadcastWallboxStatus, broadcastPartialUpdate } from "./sse";
import { invalidateWallboxCaches } from "./cache-invalidation";
import { updateLastCachedWallboxStatus } from "../routes/wallbox-routes";
import { autoCloseGarageIfNeeded } from "../routes/garage-routes";

let lastInputStatus: number | null = null;
let lastPlugStatus: number | null = null;
let lastState: number | null = null;
let lastEpres: number | null = null;
let isEnabled = false;
let sendUdpCommand: ((ip: string, command: string) => Promise<any>) | null =
  null;

// Zähler für E-pres-Events seit letztem vollen Status-Broadcast.
// Alle EPRES_FULL_STATUS_INTERVAL Events wird ein voller Status geholt,
// damit power/phases/currents live im GUI aktualisiert werden.
let epresCountSinceFullStatus = 0;
const EPRES_FULL_STATUS_INTERVAL = 5;

function resetVehicleFinishedOnPlugChange(previousPlug: number | null | undefined, nextPlug: number): void {
  if (previousPlug === null || previousPlug === undefined || previousPlug === nextPlug) {
    return;
  }

  const context = storage.getChargingContext();
  if (context.vehicleFinishedCharging) {
    log(
      "info",
      "system",
      `[Wallbox-Broadcast-Listener] Plug-Wechsel ${previousPlug} → ${nextPlug} erkannt → vehicleFinishedCharging zurückgesetzt`,
    );
    storage.updateChargingContext({ vehicleFinishedCharging: false, vehicleFinishedAt: undefined });
  }
}

// Handler für Broadcast-Nachrichten (async für stopChargingForStrategyOff)
const handleBroadcast = async (data: any, rinfo: any) => {
  // IP-Filter: Nur Broadcasts von der konfigurierten Wallbox-IP verarbeiten (Fixes #40)
  // Wenn wallboxIp nicht konfiguriert → durchlassen (Fallback für unkonfigurierte Systeme)
  const currentSettings = storage.getSettings();
  if (currentSettings?.wallboxIp && rinfo.address !== currentSettings.wallboxIp) {
    log(
      "debug",
      "system",
      `[Wallbox-Broadcast-Listener] Broadcast von fremder IP ignoriert: ${rinfo.address} (erwartet: ${currentSettings.wallboxIp})`,
    );
    return;
  }

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
            resetVehicleFinishedOnPlugChange(savedStatus, plugStatus);
            
            // Speichere neuen Status
            storage.savePlugStatusTracking({
              lastPlugStatus: plugStatus,
              lastPlugChange: new Date().toISOString(),
            });
            
            // Auto-Close Garage: Plug wechselt von <5 auf ≥5 (Kabel eingesteckt)
            if (savedStatus < 5 && plugStatus >= 5) {
              autoCloseGarageIfNeeded().catch(() => {});
            }

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
        resetVehicleFinishedOnPlugChange(lastPlugStatus, plugStatus);

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
        
        // Auto-Close Garage: Plug wechselt von <5 auf ≥5 (Kabel eingesteckt)
        if (lastPlugStatus < 5 && plugStatus >= 5) {
          autoCloseGarageIfNeeded().catch(() => {});
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
        
        // WICHTIG: In-Memory-Tracker ZUERST aktualisieren, DANN broadcasten!
        // fetchAndBroadcastStatus() liest lastPlugStatus als autoritative Quelle.
        // Wenn wir erst broadcasten, geht der alte Plug-Wert per SSE raus → Flicker.
        lastPlugStatus = plugStatus;

        // WebSocket-Broadcast: Hol aktuellen Status und push zu Clients
        void fetchAndBroadcastStatus("Plug-Änderung");
      } else {
        // Kein Wechsel – nur In-Memory aktualisieren (redundant aber sicher)
        lastPlugStatus = plugStatus;
      }
    }

    // Verarbeite State-Broadcasts
    // KEBA sendet spontane State-Änderungen (z.B. beim Anstecken/Abstecken)
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
        
        // Issue #80/#93: Bei State-Änderung Idle-Throttle zurücksetzen
        // Damit nächster E3DC-Poll sofort die Wallbox abfragt
        invalidateWallboxCaches();
        
        // Sofortiges partial SSE update (ohne 3 UDP-Requests)
        // Include lastPlugStatus to prevent frontend from losing plug value
        broadcastPartialUpdate({ state, ...(lastPlugStatus !== null ? { plug: lastPlugStatus } : {}) });
        
        // Vollständigen Status im Hintergrund holen für alle Felder
        void fetchAndBroadcastStatus("State-Änderung");
        
        // Frühe "Auto voll"-Erkennung: State 3→2 bei Plug=7 und WIR haben nicht gestoppt
        // Wenn lastState===3 (charging) und neuer state===2 (ready, not charging)
        // und Auto noch angesteckt (lastPlugStatus===7) und context sagt isActive=true
        // → das Auto hat die Ladung selbst beendet (nicht wir per ena 0)
        // Begründung: Wenn WIR stoppen, setzt stopCharging() isActive=false BEVOR
        // der State-Broadcast kommt. Also: isActive=true → Auto hat gestoppt.
        if (lastState === 3 && (state === 2 || state === 5) && lastPlugStatus === 7) {
          const context = storage.getChargingContext();
          if (context.isActive) {
            log(
              "info",
              "system",
              "[Wallbox-Broadcast-Listener] Auto hat Ladung beendet (State 3→" + state + " bei Plug=7, isActive=true) → vehicleFinishedCharging=true",
            );
            storage.updateChargingContext({ vehicleFinishedCharging: true, vehicleFinishedAt: new Date().toISOString() });
            
            // Bug #84: Wallbox deaktivieren damit ena nicht hängen bleibt
            try {
              const settings = storage.getSettings();
              if (settings?.wallboxIp) {
                await getOrCreateStrategyController().ensureWallboxDisabled(settings.wallboxIp, 1);
              }
            } catch (error) {
              log("warning", "system", "[Wallbox-Broadcast-Listener] ensureWallboxDisabled fehlgeschlagen", error instanceof Error ? error.message : String(error));
            }
          }
        }
      }

      lastState = state;
    }

    // Verarbeite E pres-Broadcasts (Session-Energie während Ladung)
    // KEBA sendet diese spontan alle ~1-2s während der Ladung
    // Werte in 0.1 Wh → umrechnen in Wh für Frontend
    if (data["E pres"] !== undefined) {
      const epresRaw = data["E pres"];
      if (epresRaw !== lastEpres) {
        lastEpres = epresRaw;
        // Broadcast partial SSE update (Wh = raw / 10)
        // Include lastPlugStatus to prevent frontend from losing plug value
        broadcastPartialUpdate({ ePres: epresRaw / 10, ...(lastPlugStatus !== null ? { plug: lastPlugStatus } : {}) });

        // Periodisch vollen Status holen während Ladung aktiv (State=3),
        // damit power/phases/currents live im GUI aktualisiert werden.
        // E-pres kommt alle ~1-2s → alle 5 Events ≈ alle 5-10s ein voller Status.
        if (lastState === 3) {
          epresCountSinceFullStatus++;
          if (epresCountSinceFullStatus >= EPRES_FULL_STATUS_INTERVAL) {
            epresCountSinceFullStatus = 0;
            void fetchAndBroadcastStatus("E-pres periodisch (Ladeleistung)");
          }
        }
      }
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
    
    // Issue #80/#93: Throttle zurücksetzen bei Strategie-Wechsel
    invalidateWallboxCaches();


    // Reagiere auf Input-Änderung
    if (inputStatus === 1) {
      const settings = storage.getSettings();
      targetStrategy =
        settings?.chargingStrategy?.inputX1Strategy ?? "max_without_battery";

      log(
        "info",
        "system",
        `[Wallbox-Broadcast-Listener] Aktiviere Ladestrategie: ${targetStrategy}`,
      );

      // X1-OPTIMIERUNG: NUR für max_without_battery
      // Andere Strategien (surplus_*) brauchen E3DC-Daten → normale Event-Loop verwenden
      if (targetStrategy === "max_without_battery" && settings?.wallboxIp) {
        // OPTIMIERTER PFAD: Schnelle UI-Reaktion mit Battery Lock Sicherheit
        // 1. Wallbox sofort starten
        // 2. SSE sofort senden (UI bekommt Update in ~2-3s)
        // 3. Battery Lock aktivieren (KRITISCH: await für Sicherheit!)
        // 4. Bei Fehler: Wallbox stoppen + Strategie NICHT setzen
        
        const x1StartTime = Date.now();
        log('debug', 'system', '[X1-Optimierung] Input 0→1: START (max_without_battery)');
        
        try {
          // SCHRITT 1: Wallbox SOFORT starten (ohne auf Battery Lock zu warten)
          log('debug', 'system', '[X1-Optimierung] Schritt 1/3: Wallbox starten');
          await getOrCreateStrategyController().activateMaxPowerImmediately(settings.wallboxIp);
          
          const wallboxDone = Date.now() - x1StartTime;
          log('debug', 'system', `[X1-Optimierung] Schritt 1/3 FERTIG - Wallbox gestartet in ${wallboxDone}ms`);
          
          // SCHRITT 2: SSE SOFORT senden (UI bekommt Update - optimiert!)
          log('debug', 'system', '[X1-Optimierung] Schritt 2/3: SSE-Update senden');
          await fetchAndBroadcastStatus("X1-Aktivierung");
          
          const sseDone = Date.now() - x1StartTime;
          log('debug', 'system', `[X1-Optimierung] Schritt 2/3 FERTIG - SSE gesendet in ${sseDone}ms`);
          
          // SCHRITT 3: Battery Lock aktivieren (KRITISCH: await für Sicherheit!)
          // UI hat bereits Update, aber wir MÜSSEN warten um Batterie zu schützen
          log('debug', 'system', '[X1-Optimierung] Schritt 3/3: Battery Lock aktivieren (KRITISCH)');
          await getOrCreateStrategyController().handleStrategyChange(targetStrategy);
          
          const batteryDone = Date.now() - x1StartTime;
          log('debug', 'system', `[X1-Optimierung] Schritt 3/3 FERTIG - Battery Lock aktiviert in ${batteryDone}ms`);
          log('info', 'system', `[X1-Optimierung] Input 0→1 FERTIG - UI-Update in ${sseDone}ms, Total: ${batteryDone}ms`);
          
          // Prowl-Notification NACHDEM alles erfolgreich war
          const finalContext = storage.getChargingContext();
          if (finalContext.isActive) {
            triggerProwlEvent(settings, "chargingStarted", (notifier) =>
              notifier.sendChargingStarted(finalContext.currentAmpere, 1, finalContext.strategy)
            );
          }
        } catch (error) {
          log(
            "error",
            "system",
            "[X1-Optimierung] FEHLER - Rollback wird ausgeführt:",
            error instanceof Error ? error.message : String(error),
          );
          
          // ROLLBACK: Wallbox stoppen weil Battery Lock fehlgeschlagen
          try {
            await getOrCreateStrategyController().stopChargingOnly(settings.wallboxIp, "Battery Lock Fehler - Sicherheits-Rollback");
            log('error', 'system', '[X1-Optimierung] Rollback erfolgreich - Wallbox gestoppt');
            
            // Prowl-Notification: Kritischer Fehler
            triggerProwlEvent(settings, "errors", (notifier) =>
              notifier.sendError("X1 Aktivierung fehlgeschlagen: Battery Lock konnte nicht aktiviert werden. Wallbox wurde gestoppt.")
            );
          } catch (rollbackError) {
            log(
              'error',
              'system',
              '[X1-Optimierung] KRITISCH: Rollback fehlgeschlagen!',
              rollbackError instanceof Error ? rollbackError.message : String(rollbackError)
            );
          }
          
          // WICHTIG: targetStrategy auf null setzen → finally-Block setzt KEINE Strategie
          targetStrategy = null;
        }
      } else {
        // NORMALER PFAD: Für surplus-Strategien (brauchen E3DC-Daten)
        // Battery Lock aktivieren, dann wartet Event-Loop auf E3DC-Daten
        try {
          await getOrCreateStrategyController().handleStrategyChange(targetStrategy);
        } catch (error) {
          log(
            "error",
            "system",
            "[Wallbox-Broadcast-Listener] Strategie-Wechsel fehlgeschlagen:",
            error instanceof Error ? error.message : String(error),
          );
          // Fortfahren - Strategie wird trotzdem gesetzt (finally-Block)
        }
      }
    } else if (inputStatus === 0) {
      // X1-OPTIMIERUNG: Sofortige UI-Reaktion durch parallele Ausführung
      // 1. Wallbox sofort stoppen
      // 2. SSE sofort senden
      // 3. Battery Lock asynchron im Hintergrund deaktivieren
      
      const x1StopTime = Date.now();
      log('debug', 'system', '[X1-Optimierung] Input 1→0: START');
      
      targetStrategy = "off";
      log(
        "info",
        "system",
        "[Wallbox-Broadcast-Listener] Deaktiviere Ladestrategie: Aus",
      );

      const settings = storage.getSettings();
      if (settings?.wallboxIp) {
        try {
          // SCHRITT 1: Wallbox SOFORT stoppen (ohne auf Battery Lock zu warten)
          log('debug', 'system', '[X1-Optimierung] Schritt 1/3: Wallbox stoppen');
          await getOrCreateStrategyController().stopChargingOnly(settings.wallboxIp, "Input X1 deaktiviert");
          
          const wallboxDone = Date.now() - x1StopTime;
          log('debug', 'system', `[X1-Optimierung] Schritt 1/3 FERTIG - Wallbox gestoppt in ${wallboxDone}ms`);
          
          // SCHRITT 2: SSE SOFORT senden (UI bekommt Update)
          log('debug', 'system', '[X1-Optimierung] Schritt 2/3: SSE-Update senden');
          await fetchAndBroadcastStatus("X1-Deaktivierung");
          
          const sseDone = Date.now() - x1StopTime;
          log('debug', 'system', `[X1-Optimierung] Schritt 2/3 FERTIG - SSE gesendet in ${sseDone}ms`);
          
          // SCHRITT 3: Battery Lock ASYNCHRON im Hintergrund deaktivieren
          // Fire-and-forget: UI wartet nicht darauf
          log('debug', 'system', '[X1-Optimierung] Schritt 3/3: Battery Lock (async im Hintergrund)');
          void getOrCreateStrategyController().handleStrategyChange("off")
            .then(() => {
              const batteryDone = Date.now() - x1StopTime;
              log('debug', 'system', `[X1-Optimierung] Schritt 3/3 FERTIG - Battery Lock deaktiviert in ${batteryDone}ms`);
            })
            .catch((error) => {
              log(
                "error",
                "system",
                "[X1-Optimierung] Battery Lock Deaktivierung fehlgeschlagen:",
                error instanceof Error ? error.message : String(error),
              );
            });
          
          const totalTime = Date.now() - x1StopTime;
          log('info', 'system', `[X1-Optimierung] Input 1→0 FERTIG - UI-Update in ${totalTime}ms (Battery Lock läuft im Hintergrund)`);
        } catch (error) {
          log(
            "error",
            "system",
            "[X1-Optimierung] Wallbox stoppen fehlgeschlagen:",
            error instanceof Error ? error.message : String(error),
          );
          // Fortfahren - Strategie wird trotzdem auf "off" gesetzt (finally-Block)
        }
      } else {
        log(
          "warning",
          "system",
          "[Wallbox-Broadcast-Listener] ChargingStrategyController oder Wallbox-IP nicht verfügbar - Wallbox nicht gestoppt",
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

    // Plug-Status: In-Memory-Wert ist autoritativ (Broadcast ist schneller als report 2)
    // Fallback auf report2.Plug nur wenn noch kein Broadcast empfangen wurde
    const authoritativePlug = lastPlugStatus ?? report2?.Plug ?? 0;

    const status = {
      state: report2?.State || 0,
      plug: authoritativePlug,
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
    // Issue #79: Auch den gecachten Status aktualisieren, damit /api/status aktuelle Werte liefert
    updateLastCachedWallboxStatus(status);
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

  // Speichere sendUdpCommand für Wallbox-Kommunikation
  sendUdpCommand = udpCommandSender;

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
  lastEpres = null;
  epresCountSinceFullStatus = 0;
  sendUdpCommand = null;
  log("info", "system", "✅ [Wallbox-Broadcast-Listener] Gestoppt");
}

export function isBroadcastListenerEnabled(): boolean {
  return isEnabled;
}

/**
 * Gibt den autoritativen Plug-Status aus dem In-Memory-State zurück.
 * Der Broadcast-Listener empfängt Plug-Änderungen direkt per UDP-Push
 * und ist daher schneller und zuverlässiger als report-2-Abfragen.
 *
 * @returns Aktueller Plug-Status (number) oder null wenn noch kein Broadcast empfangen wurde.
 */
export function getAuthoritativePlugStatus(): number | null {
  return lastPlugStatus;
}

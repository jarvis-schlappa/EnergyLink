import { log } from "../core/logger";
import { storage } from "../core/storage";
import { getE3dcModbusService, getE3dcLiveDataHub } from "./modbus";
import { sendUdpCommand } from "../wallbox/transport";
import { getProwlNotifier } from "../monitoring/prowl-notifier";
import { getOutsideTemp } from "../fhem/outside-temp";

/**
 * E3DC-Background-Poller
 * 
 * Liest in konfigurierbarem Intervall (Standard: 10s) E3DC-Daten im Hintergrund,
 * damit FHEM und andere Consumer immer aktuelle Werte bekommen - unabhängig von
 * aktiven Clients oder laufenden Charging-Strategien.
 * 
 * Exponential Backoff bei Verbindungsfehlern:
 * - Level 0: 10s (normal)
 * - Level 1: 30s
 * - Level 2: 1min
 * - Level 3: 5min
 * - Level 4: 10min (max)
 */

// Module-scope handles
let pollerInterval: NodeJS.Timeout | null = null;
let initialPollerTimeout: NodeJS.Timeout | null = null;
let runningPollPromise: Promise<void> | null = null;
let runningStopPromise: Promise<void> | null = null;

// Exponential Backoff State
let backoffLevel = 0;
let previousBackoffLevel = 0; // Für State-Transition Detection (Prowl-Notifikationen)
const BACKOFF_INTERVALS = [10, 30, 60, 300, 600]; // In Sekunden: 10s, 30s, 1min, 5min, 10min
const MAX_BACKOFF_LEVEL = 4; // Max Level (10min)
let basePollingIntervalSeconds = 10;

// Wallbox Idle-Polling Throttle (Issue #80)
// Wenn Strategie "off" + Wallbox nicht lädt → Wallbox nur alle 30s abfragen statt jeden E3DC-Poll
const IDLE_WALLBOX_POLL_INTERVAL_MS = 30_000;
let lastWallboxPollTime = 0;
let lastWallboxPower = 0;

// E3DC Idle-Polling Throttle (Issue #102)
// Wenn Strategie "off" → gesamtes E3DC-Polling auf 30s drosseln statt ~7-10s
const IDLE_E3DC_POLL_INTERVAL_S = 30;
let idleThrottleOverride = false;

// Außentemperatur-Cache (Issue #81)
// FHEM nur alle 60s abfragen statt jeden Poll-Zyklus
const OUTSIDE_TEMP_POLL_INTERVAL_MS = 60_000;
let lastOutsideTempPollTime = 0;
let cachedOutsideTemp: number | null = null;

/**
 * Einzelner Poll-Durchlauf (mit Promise-Tracking und Exponential Backoff)
 * 
 * @returns true wenn erfolgreich, false bei Fehler
 */
async function pollE3dcData(): Promise<boolean> {
  // Wenn bereits ein Poll läuft, warte darauf (verhindert Overlap)
  if (runningPollPromise) {
    await runningPollPromise;
    return false; // Gibt an, dass Backoff nicht angepasst wurde (war overlapping)
  }

  let pollSuccessful = false;

  runningPollPromise = (async () => {
    try {
      const settings = storage.getSettings();
      
      // E3DC IP erforderlich
      if (!settings?.e3dcIp) {
        log("debug", "e3dc-poller", "E3DC IP nicht konfiguriert - Poller pausiert");
        return;
      }

      const e3dcService = getE3dcModbusService();

      // Verbinde zum E3DC (wiederverwendet bestehende Verbindung)
      await e3dcService.connect(settings.e3dcIp);

      // Hole aktuelle Wallbox-Leistung von KEBA (benötigt für korrekte E3DC-Bilanz)
      // Issue #80: Im Idle (Strategie "off") wird Wallbox nur alle 30s gepollt statt jeden Tick
      let wallboxPower = 0;
      const activeStrategy = settings?.chargingStrategy?.activeStrategy;
      const now = Date.now();
      const isIdle = activeStrategy === "off";
      const wallboxPollDue = !isIdle || (now - lastWallboxPollTime >= IDLE_WALLBOX_POLL_INTERVAL_MS);
      
      if (wallboxPollDue) {
        try {
          const wallboxIp = settings?.wallboxIp || "127.0.0.1";
          const report3 = await sendUdpCommand(wallboxIp, "report 3");
          // Power ist in Report 3 als P (in Milliwatt), dividiert durch 1.000 für Watt
          wallboxPower = (report3.P || 0) / 1000;
          lastWallboxPower = wallboxPower;
          lastWallboxPollTime = now;
        } catch (error) {
          // Wenn Wallbox nicht erreichbar, verwende 0W (non-critical)
          log(
            "debug",
            "e3dc-poller",
            "Wallbox nicht erreichbar, verwende 0W für E3DC-Polling",
            error instanceof Error ? error.message : String(error)
          );
        }
      } else {
        // Im Idle: Verwende gecachten Wert (normalerweise 0W)
        wallboxPower = lastWallboxPower;
        log("debug", "e3dc-poller", `Wallbox-Polling gedrosselt (Idle) - verwende Cache: ${wallboxPower}W`);
      }

      // Lese E3DC-Daten (cached für FHEM-Sync und andere Consumer)
      const liveData = await e3dcService.readLiveData(wallboxPower);

      // Issue #81: Außentemperatur von FHEM abfragen (gecacht, alle 60s)
      const fhemHost = settings?.fhemSync?.host;
      if (fhemHost && settings?.fhemSync?.enabled) {
        const tempPollDue = (now - lastOutsideTempPollTime) >= OUTSIDE_TEMP_POLL_INTERVAL_MS;
        if (tempPollDue) {
          try {
            cachedOutsideTemp = await getOutsideTemp(fhemHost);
            lastOutsideTempPollTime = now;
          } catch {
            // Non-critical: Cache behalten bei Fehler
          }
        }
      }
      if (cachedOutsideTemp !== null) {
        liveData.outsideTemp = cachedOutsideTemp;
      }

      // Event-Emission an alle registrierten Listener (FHEM, etc.)
      const hub = getE3dcLiveDataHub();
      hub.emit(liveData);

      log(
        "debug",
        "e3dc-poller",
        `E3DC-Daten aktualisiert: PV=${liveData.pvPower}W, Batterie=${liveData.batteryPower}W (SOC=${liveData.batterySoc}%), Haus=${liveData.housePower}W, Netz=${liveData.gridPower}W`
      );

      // ✅ Erfolg: Backoff zurücksetzen
      if (backoffLevel > 0) {
        log("info", "e3dc-poller", `E3DC Verbindung wiederhergestellt - Backoff-Level zurück auf 0 (Intervall: ${BACKOFF_INTERVALS[0]}s)`);
        backoffLevel = 0;
        
        // Prowl-Notifikation: Verbindung wiederhergestellt (nur bei Transition >0 → 0)
        if (previousBackoffLevel > 0) {
          log("info", "e3dc-poller", "📱 Sende Prowl-Notification: E3DC Verbindung wiederhergestellt");
          try {
            const notifier = getProwlNotifier();
            void notifier.sendE3dcConnectionRestored();
          } catch (error) {
            log("debug", "e3dc-poller", "Prowl-Notifier nicht verfügbar");
          }
        }
      }

      pollSuccessful = true;
    } catch (error) {
      // ❌ Fehler: Backoff erhöhen
      const wasConnected = backoffLevel === 0;
      
      if (backoffLevel < MAX_BACKOFF_LEVEL) {
        backoffLevel++;
      }

      const nextIntervalSeconds = BACKOFF_INTERVALS[backoffLevel];
      log(
        "warning",
        "e3dc-poller",
        `E3DC-Polling fehlgeschlagen (Backoff Level ${backoffLevel}/${MAX_BACKOFF_LEVEL}, nächster Versuch in ${nextIntervalSeconds}s)`,
        error instanceof Error ? error.message : String(error)
      );
      
      // Prowl-Notifikation: Verbindung verloren (nur bei Transition 0 → >0)
      if (wasConnected && backoffLevel > 0 && previousBackoffLevel === 0) {
        log("info", "e3dc-poller", "📱 Sende Prowl-Notification: E3DC Verbindung verloren");
        try {
          const notifier = getProwlNotifier();
          void notifier.sendE3dcConnectionLost();
        } catch (e) {
          log("debug", "e3dc-poller", "Prowl-Notifier nicht verfügbar");
        }
      }
      
      pollSuccessful = false;
    }
  })().finally(() => {
    runningPollPromise = null;
    // Update previousBackoffLevel für nächsten Poll
    previousBackoffLevel = backoffLevel;
  });

  await runningPollPromise;
  return pollSuccessful;
}

/**
 * Recursiver Poll-Scheduler mit dynamischem Backoff-Intervall
 * 
 * Statt setInterval verwenden wir setTimeout in einer Rekursion,
 * damit das nächste Intervall basierend auf backoffLevel berechnet werden kann.
 */
async function scheduleNextPoll(): Promise<void> {
  // Issue #102: Im Idle (Strategie "off") gesamtes Polling auf 30s drosseln
  const settings = storage.getSettings();
  const isIdle = settings?.chargingStrategy?.activeStrategy === "off";
  const wasIdle = idleThrottleOverride;
  idleThrottleOverride = isIdle;
  
  // Berechne nächstes Intervall basierend auf Backoff-Level und Idle-Status
  const backoffInterval = BACKOFF_INTERVALS[backoffLevel];
  const nextIntervalSeconds = (isIdle && backoffLevel === 0) 
    ? Math.max(backoffInterval, IDLE_E3DC_POLL_INTERVAL_S)
    : backoffInterval;
  const nextIntervalMs = nextIntervalSeconds * 1000;
  
  if (isIdle && !wasIdle) {
    log("info", "e3dc-poller", `Idle-Modus aktiv → E3DC-Polling gedrosselt auf ${nextIntervalSeconds}s`);
  } else if (!isIdle && wasIdle) {
    log("info", "e3dc-poller", `Idle-Modus beendet → E3DC-Polling zurück auf ${backoffInterval}s`);
  }

  // Starte nächsten Poll nach Intervall
  initialPollerTimeout = setTimeout(async () => {
    initialPollerTimeout = null;
    await pollE3dcData();
    
    // Plane nächsten Poll (rekursiv)
    await scheduleNextPoll();
  }, nextIntervalMs);
}

/**
 * Startet den E3DC-Background-Poller mit adaptivem Backoff
 */
export function startE3dcPoller(): NodeJS.Timeout {
  // Lese Polling-Intervall aus Einstellungen (Default: 10 Sekunden)
  const settings = storage.getSettings();
  basePollingIntervalSeconds = settings?.e3dc?.pollingIntervalSeconds ?? 10;
  
  // Stelle sicher, dass basePollingIntervalSeconds mit Level 0 übereinstimmt
  BACKOFF_INTERVALS[0] = basePollingIntervalSeconds;
  
  log("info", "e3dc-poller", "E3DC-Background-Poller wird gestartet mit Exponential Backoff", `Basis-Intervall: ${basePollingIntervalSeconds}s, Backoff-Stufen: ${BACKOFF_INTERVALS.join(', ')}s`);

  // Backoff-State und Idle-Throttle zurücksetzen
  backoffLevel = 0;
  lastWallboxPollTime = 0;
  lastWallboxPower = 0;

  // Initialer Poll nach 2s (lässt Server-Start Zeit für Initialisierung)
  initialPollerTimeout = setTimeout(async () => {
    initialPollerTimeout = null;
    await pollE3dcData();
    
    // Plane nächsten Poll
    await scheduleNextPoll();
  }, 2000);

  // Rückgabe eines Dummy-Timers (wird nicht wirklich verwendet, aber API kompatibel)
  pollerInterval = initialPollerTimeout;
  return pollerInterval;
}

/**
 * Gibt den aktuellen Backoff-Level zurück
 * 0 = Normal (10s), 1-4 = Backoff aktiv
 */
export function getE3dcBackoffLevel(): number {
  return backoffLevel;
}

/**
 * Setzt den Wallbox-Idle-Polling-Throttle zurück (Issue #80).
 * Wird aufgerufen wenn sich der Wallbox-State ändert (z.B. via Broadcast),
 * damit der nächste E3DC-Poll sofort die Wallbox abfragt.
 */
export function resetWallboxIdleThrottle(): void {
  lastWallboxPollTime = 0;
  lastWallboxPower = 0;
  idleThrottleOverride = false;  // Issue #102: Idle-Throttle sofort zurücksetzen
  log("debug", "e3dc-poller", "Wallbox-Idle-Throttle zurückgesetzt (State-/Strategie-Änderung)");
}

/**
 * Triggert sofort einen E3DC-Poll (Issue #67).
 * Wird aufgerufen nach Demo-Modus-Toggle, damit das Frontend sofort
 * aktuelle Daten bekommt statt bis zum nächsten Polling-Intervall (bis zu 30s) zu warten.
 * Bricht den ausstehenden Timer ab und führt den Poll unmittelbar aus.
 */
export function triggerImmediateE3dcPoll(): void {
  // Ausstehenden Timer abbrechen (verhindert doppelten Poll)
  if (initialPollerTimeout) {
    clearTimeout(initialPollerTimeout);
    initialPollerTimeout = null;
    log("debug", "e3dc-poller", "Ausstehender Poll-Timer abgebrochen für sofortigen Poll (Issue #67)");
  }

  log("info", "e3dc-poller", "Sofortiger E3DC-Poll angefordert (Demo-Mode-Toggle, Issue #67)");

  // Asynchron ausführen ohne auf Ergebnis zu warten (fire-and-forget mit Fehlerbehandlung)
  void (async () => {
    await pollE3dcData();
    await scheduleNextPoll();
  })().catch((err) => {
    log("warning", "e3dc-poller", "Sofortiger E3DC-Poll fehlgeschlagen", err instanceof Error ? err.message : String(err));
  });
}

/**
 * Stoppt den E3DC-Background-Poller und wartet auf laufenden Poll
 */
export async function stopE3dcPoller(): Promise<void> {
  // Wenn bereits ein Stop läuft, warte darauf
  if (runningStopPromise) {
    log("debug", "e3dc-poller", "E3DC-Poller: Stop bereits aktiv, warte darauf");
    await runningStopPromise;
    return;
  }

  runningStopPromise = (async () => {
    try {
      // Stoppe Intervall
      if (pollerInterval) {
        clearInterval(pollerInterval);
        pollerInterval = null;
        log("info", "e3dc-poller", "E3DC-Background-Poller gestoppt");
      }

      // Cancele initialen Poll falls noch pending
      if (initialPollerTimeout) {
        clearTimeout(initialPollerTimeout);
        initialPollerTimeout = null;
        log("debug", "e3dc-poller", "E3DC initialer Poll gecancelt");
      }

      // Warte auf laufenden Poll
      if (runningPollPromise) {
        log("debug", "e3dc-poller", "Warte auf laufenden E3DC-Poll...");
        await runningPollPromise;
        log("debug", "e3dc-poller", "Laufender E3DC-Poll abgeschlossen");
      }
    } finally {
      runningStopPromise = null;
    }
  })();

  await runningStopPromise;
}

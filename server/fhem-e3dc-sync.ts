import { Socket } from "net";
import { log } from "./logger";
import { storage } from "./storage";
import { getE3dcModbusService, getE3dcLiveDataHub } from "./e3dc-modbus";
import { getE3dcBackoffLevel } from "./e3dc-poller";
import type { FhemSync } from "@shared/schema";

/**
 * Validiert Host für FHEM-Kommunikation
 */
function validateFhemHost(host: string): void {
  if (!host || host.trim() === "") {
    throw new Error("FHEM Host ist nicht konfiguriert - bitte IP-Adresse in Settings angeben");
  }
}

/**
 * Validiert Port für FHEM-Kommunikation
 */
function validateFhemPort(port: number): void {
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`Ungültiger FHEM Port: ${port}`);
  }
}

/**
 * Sendet Befehle an FHEM via TCP-Socket (sicher ohne Command-Injection)
 * Explizite Lifecycle-Sequenz: connect -> write -> drain -> end -> finish -> close
 * Verifiziert bytesWritten für zuverlässige Datenübertragung
 */
async function sendToFhemSocket(host: string, port: number, commands: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const socket = new Socket();
    const timeout = 5000; // 5 Sekunden Timeout
    const payload = commands + "\n";
    const expectedBytes = Buffer.byteLength(payload);
    
    let timeoutHandle: NodeJS.Timeout;
    let hasErrored = false;
    
    const clearTimeoutIfSet = () => {
      if (timeoutHandle) {
        clearTimeout(timeoutHandle);
      }
    };
    
    // Timeout: Abbruch mit RST
    timeoutHandle = setTimeout(() => {
      hasErrored = true;
      socket.destroy();
      reject(new Error(`FHEM-Socket-Timeout nach ${timeout}ms`));
    }, timeout);
    
    // Error: Abbruch mit destroy
    socket.on('error', (err) => {
      clearTimeoutIfSet();
      hasErrored = true;
      socket.destroy();
      reject(err);
    });
    
    // Finish: Alle Daten gesendet, jetzt bytesWritten prüfen
    socket.on('finish', () => {
      const actualBytes = socket.bytesWritten;
      
      if (actualBytes < expectedBytes) {
        hasErrored = true;
        clearTimeoutIfSet();
        const msg = `FHEM-Socket: Partial Write (${actualBytes}/${expectedBytes} bytes)`;
        log("error", "fhem", msg);
        socket.destroy();
        reject(new Error(msg));
      }
      // Erfolg wird in 'close' Event resolved
    });
    
    // Close: Normale oder fehlerhafte Beendigung
    socket.on('close', () => {
      clearTimeoutIfSet();
      if (!hasErrored) {
        resolve();
      }
      // Bei hasErrored wurde bereits reject() aufgerufen
    });
    
    // Connect -> Write -> Drain -> End (Graceful FIN)
    socket.on('connect', () => {
      const needsDrain = !socket.write(payload);
      
      // Wenn write() false zurückgibt, warten wir auf 'drain'
      if (needsDrain) {
        socket.once('drain', () => {
          // Alle Daten gesendet -> Graceful shutdown
          socket.end();
          // Verifizierung in 'finish', Resolve in 'close'
        });
      } else {
        // Buffer war nicht voll, Daten sofort gesendet -> Graceful shutdown
        socket.end();
        // Verifizierung in 'finish', Resolve in 'close'
      }
    });
    
    socket.connect(port, host);
  });
}

/**
 * Sendet E3DC-Live-Daten an FHEM via TCP-Socket
 * Verwendet cached E3DC-Daten (keine extra Modbus-Abfrage)
 */
export async function syncE3dcToFhem(): Promise<void> {
  const settings = storage.getSettings();
  const fhemConfig = settings?.fhemSync;

  if (!fhemConfig?.enabled) {
    return;
  }

  try {
    // Validiere FHEM-Konfiguration
    validateFhemHost(fhemConfig.host);
    validateFhemPort(fhemConfig.port);
    
    // Hole cached E3DC-Live-Daten (KEINE neue Modbus-Abfrage!)
    const e3dcModbus = getE3dcModbusService();
    const liveData = e3dcModbus.getLastReadLiveData();
    
    if (!liveData) {
      // Wenn E3DC gerade im Backoff-Modus ist, schweige still (Sync pausiert)
      // Backoff Level > 0 bedeutet: E3DC-Verbindung fehlt, kein Grund für Warnung
      if (getE3dcBackoffLevel() > 0) {
        log(
          "debug",
          "fhem",
          "E3DC im Backoff-Modus - FHEM-Sync pausiert",
          `Backoff Level ${getE3dcBackoffLevel()}/4`
        );
        return;
      }
      
      // Backoff Level 0 aber keine Daten = echtes Problem (erste Abfrage noch nicht fertig)
      log(
        "warning",
        "fhem",
        "Keine E3DC-Daten im Cache - warte auf erste Modbus-Abfrage",
        "FHEM-Sync übersprungen"
      );
      return;
    }

    // Baue FHEM-Befehle (gerundete Werte)
    const commands = [
      `setreading S10 sonne ${Math.round(liveData.pvPower)}`,
      `setreading S10 haus ${Math.round(liveData.housePower)}`,
      `setreading S10 soc ${Math.round(liveData.batterySoc)}`,
      `setreading S10 netz ${Math.round(liveData.gridPower)}`,
      `setreading S10 speicher ${Math.round(liveData.batteryPower)}`,
    ].join("\n");

    log(
      "debug",
      "fhem",
      "Sende cached E3DC-Daten an FHEM",
      `Host: ${fhemConfig.host}:${fhemConfig.port}, PV: ${liveData.pvPower}W, Haus: ${liveData.housePower}W, SOC: ${liveData.batterySoc}%`
    );

    // Sende via TCP-Socket (keine Command-Injection möglich)
    await sendToFhemSocket(fhemConfig.host, fhemConfig.port, commands);

    log(
      "debug",
      "fhem",
      "E3DC-Daten erfolgreich an FHEM gesendet",
      `PV: ${liveData.pvPower}W, Haus: ${liveData.housePower}W, SOC: ${liveData.batterySoc}%, Netz: ${liveData.gridPower}W, Speicher: ${liveData.batteryPower}W`
    );
  } catch (error) {
    log(
      "error",
      "fhem",
      "Fehler beim Senden an FHEM",
      error instanceof Error ? error.message : String(error)
    );
  }
}

// Handle für initialen Sync-Timeout (kann bei Shutdown gecancelt werden)
let initialSyncTimeout: NodeJS.Timeout | null = null;

// Track running sync promise for graceful shutdown
let runningSyncPromise: Promise<void> | null = null;

// Track running stop-operation for concurrent shutdown calls
let runningStopPromise: Promise<void> | null = null;

// Event-Listener Unsubscribe-Handle (für graceful shutdown)
let unsubscribeFromHub: (() => void) | null = null;

/**
 * Wrapper für syncE3dcToFhem mit Promise-Tracking
 */
async function syncWithTracking(): Promise<void> {
  // Wenn bereits ein Sync läuft, warte darauf (verhindert Overlap)
  if (runningSyncPromise) {
    await runningSyncPromise;
    return;
  }
  
  runningSyncPromise = syncE3dcToFhem().finally(() => {
    runningSyncPromise = null;
  });
  
  await runningSyncPromise;
}

/**
 * Startet den FHEM-Sync-Scheduler (Event-Listener + 10s Fallback)
 * 
 * Strategie:
 * - Primär: Event-driven via E3dcLiveDataHub (sofort bei neuen Daten)
 * - Sekundär: 10s-Timer als Health-Check/Fallback
 */
export function startFhemSyncScheduler(): NodeJS.Timeout {
  log(
    "info", 
    "fhem", 
    "FHEM-E3DC-Sync wird gestartet",
    "Strategie: Event-Listener (primär) + 10s-Timer (Fallback)"
  );
  
  // Registriere Event-Listener für sofortige Updates
  const hub = getE3dcLiveDataHub();
  unsubscribeFromHub = hub.subscribe(async (data) => {
    log(
      "debug",
      "fhem",
      "Event empfangen: Neue E3DC-Daten verfügbar",
      `PV=${data.pvPower}W, SOC=${data.batterySoc}%`
    );
    await syncWithTracking();
  });
  
  log("info", "fhem", "Event-Listener registriert", "FHEM wird sofort bei neuen E3DC-Daten aktualisiert");
  
  // Führe initialen Sync aus (nach 5s Verzögerung für Startup)
  initialSyncTimeout = setTimeout(async () => {
    initialSyncTimeout = null;
    await syncWithTracking();
  }, 5000);
  
  // 10s-Timer als Fallback/Health-Check (falls Events verloren gehen)
  const fallbackInterval = setInterval(async () => {
    log("debug", "fhem", "Fallback-Timer: Health-Check FHEM-Sync");
    await syncWithTracking();
  }, 10000);
  
  return fallbackInterval;
}

/**
 * Stoppt den FHEM-Sync-Scheduler und wartet auf laufenden Sync
 * Wenn bereits ein Stop läuft, wartet dieser Call darauf (verhindert Race-Conditions)
 */
export async function stopFhemSyncScheduler(interval: NodeJS.Timeout | null): Promise<void> {
  // Wenn bereits ein Stop läuft, warte darauf (verhindert Overlap)
  if (runningStopPromise) {
    log("debug", "fhem", "FHEM-Scheduler: Stop bereits aktiv, warte darauf");
    await runningStopPromise;
    return;
  }
  
  // Markiere Stop als laufend
  runningStopPromise = (async () => {
    try {
      // Deregistriere Event-Listener
      if (unsubscribeFromHub) {
        unsubscribeFromHub();
        unsubscribeFromHub = null;
        log("info", "fhem", "Event-Listener deregistriert");
      }
      
      // Stoppe Fallback-Intervall
      if (interval) {
        clearInterval(interval);
        log("info", "fhem", "FHEM-E3DC-Sync-Scheduler gestoppt");
      }
      
      // Cancele initialen Sync falls noch pending
      if (initialSyncTimeout) {
        clearTimeout(initialSyncTimeout);
        initialSyncTimeout = null;
        log("debug", "fhem", "FHEM-E3DC initialer Sync gecancelt");
      }
      
      // Warte auf laufenden Sync (verhindert Abbruch während Datenübertragung)
      if (runningSyncPromise) {
        log("debug", "fhem", "Warte auf laufenden FHEM-Sync...");
        await runningSyncPromise;
        log("debug", "fhem", "Laufender FHEM-Sync abgeschlossen");
      }
    } finally {
      // Cleanup: Markiere Stop als abgeschlossen
      runningStopPromise = null;
    }
  })();
  
  await runningStopPromise;
}

import { log } from "./logger";
import { storage } from "./storage";
import { getE3dcModbusService, getE3dcLiveDataHub } from "./e3dc-modbus";
import { sendUdpCommand } from "./wallbox-transport";

/**
 * E3DC-Background-Poller
 * 
 * Liest alle 5 Sekunden E3DC-Daten im Hintergrund, damit FHEM und andere
 * Consumer immer aktuelle Werte bekommen - unabhängig von aktiven Clients
 * oder laufenden Charging-Strategien.
 */

// Module-scope handles
let pollerInterval: NodeJS.Timeout | null = null;
let initialPollerTimeout: NodeJS.Timeout | null = null;
let runningPollPromise: Promise<void> | null = null;
let runningStopPromise: Promise<void> | null = null;

/**
 * Einzelner Poll-Durchlauf (mit Promise-Tracking)
 */
async function pollE3dcData(): Promise<void> {
  // Wenn bereits ein Poll läuft, warte darauf (verhindert Overlap)
  if (runningPollPromise) {
    await runningPollPromise;
    return;
  }

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
      let wallboxPower = 0;
      try {
        const wallboxIp = settings?.wallboxIp || "127.0.0.1";
        const report3 = await sendUdpCommand(wallboxIp, "report 3");
        wallboxPower = report3.P || 0;
      } catch (error) {
        // Wenn Wallbox nicht erreichbar, verwende 0W (non-critical)
        log(
          "debug",
          "e3dc-poller",
          "Wallbox nicht erreichbar, verwende 0W für E3DC-Polling",
          error instanceof Error ? error.message : String(error)
        );
      }

      // Lese E3DC-Daten (cached für FHEM-Sync und andere Consumer)
      const liveData = await e3dcService.readLiveData(wallboxPower);

      // Event-Emission an alle registrierten Listener (FHEM, etc.)
      const hub = getE3dcLiveDataHub();
      hub.emit(liveData);

      log(
        "debug",
        "e3dc-poller",
        `E3DC-Daten aktualisiert: PV=${liveData.pvPower}W, Batterie=${liveData.batteryPower}W (SOC=${liveData.batterySoc}%), Haus=${liveData.housePower}W, Netz=${liveData.gridPower}W`
      );
    } catch (error) {
      log(
        "warning",
        "e3dc-poller",
        "E3DC-Polling fehlgeschlagen (wird bei nächstem Intervall erneut versucht)",
        error instanceof Error ? error.message : String(error)
      );
    }
  })().finally(() => {
    runningPollPromise = null;
  });

  await runningPollPromise;
}

/**
 * Startet den E3DC-Background-Poller (alle 5 Sekunden)
 */
export function startE3dcPoller(): NodeJS.Timeout {
  log("info", "e3dc-poller", "E3DC-Background-Poller wird gestartet", "Update-Intervall: 5 Sekunden");

  // Initialer Poll nach 2s (lässt Server-Start Zeit für Initialisierung)
  initialPollerTimeout = setTimeout(async () => {
    initialPollerTimeout = null;
    await pollE3dcData();
  }, 2000);

  // Danach alle 5 Sekunden
  const interval = setInterval(async () => {
    await pollE3dcData();
  }, 5000);
  
  pollerInterval = interval;
  return interval;
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

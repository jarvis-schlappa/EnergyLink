import { log } from "../core/logger";
import type { GarageStatus } from "@shared/schema";

const FHEM_HTTP_PORT = 8083;

/**
 * Garage-Status von FHEM abfragen (HTTP-Port 8083)
 * Parst die jsonlist2-Antwort und liefert state + lastChanged.
 */
export async function getGarageStatus(host: string): Promise<GarageStatus> {
  const url = `http://${host}:${FHEM_HTTP_PORT}/fhem?cmd=jsonlist2%20garagentor&XHR=1`;

  try {
    log("debug", "garage", "Frage Garage-Status ab", `Host: ${host}`);

    const response = await fetch(url, {
      method: "GET",
      signal: AbortSignal.timeout(5000),
    });

    if (!response.ok) {
      log("warning", "garage", "FHEM-Statusabfrage fehlgeschlagen", `Status: ${response.status}`);
      return { state: "unknown" };
    }

    const json = await response.json();
    const device = json?.Results?.[0];
    const state = device?.Readings?.state?.Value;
    const lastChanged = device?.Readings?.state?.Time;

    if (state === "open" || state === "closed") {
      log("debug", "garage", "Garage-Status empfangen", `State: ${state}`);
      return { state, lastChanged };
    }

    log("warning", "garage", "Unbekannter Garage-Status", `Value: ${state}`);
    return { state: "unknown", lastChanged };
  } catch (error) {
    log("error", "garage", "Fehler beim Abrufen des Garage-Status",
      error instanceof Error ? error.message : String(error));
    return { state: "unknown" };
  }
}

/**
 * Garagentor-Taster auslösen (Toggle).
 * Sendet on-for-timer 1 an den FHEM-Aktor.
 */
export async function toggleGarage(host: string): Promise<void> {
  const url = `http://${host}:${FHEM_HTTP_PORT}/fhem?cmd=set%20aktor_garagentor%20on-for-timer%201&XHR=1`;

  log("info", "garage", "Garagentor-Taster wird ausgelöst", `Host: ${host}`);

  const response = await fetch(url, {
    method: "GET",
    signal: AbortSignal.timeout(5000),
  });

  if (!response.ok) {
    throw new Error(`FHEM-Befehl fehlgeschlagen: HTTP ${response.status}`);
  }

  log("info", "garage", "Garagentor-Taster erfolgreich ausgelöst");
}

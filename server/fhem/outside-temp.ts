import { log } from "../core/logger";

const FHEM_HTTP_PORT = 8083;

/**
 * Außentemperatur von FHEM abfragen (heatronic Device, Reading ch_Toutside).
 * Gibt null zurück wenn FHEM nicht erreichbar oder Reading nicht vorhanden.
 */
export async function getOutsideTemp(host: string): Promise<number | null> {
  const url = `http://${host}:${FHEM_HTTP_PORT}/fhem?cmd=jsonlist2%20heatronic%20ch_Toutside&XHR=1`;

  try {
    const response = await fetch(url, {
      method: "GET",
      signal: AbortSignal.timeout(3000),
    });

    if (!response.ok) {
      log("debug", "fhem", "FHEM Außentemperatur-Abfrage fehlgeschlagen", `Status: ${response.status}`);
      return null;
    }

    const json = await response.json();
    const device = json?.Results?.[0];
    const value = device?.Readings?.ch_Toutside?.Value;

    if (value === undefined || value === null) {
      log("debug", "fhem", "FHEM heatronic.ch_Toutside nicht vorhanden");
      return null;
    }

    const temp = parseFloat(value);
    if (isNaN(temp)) {
      log("debug", "fhem", "FHEM Außentemperatur nicht parsebar", `Value: ${value}`);
      return null;
    }

    log("debug", "fhem", `Außentemperatur: ${temp}°C`);
    return temp;
  } catch (error) {
    log("debug", "fhem", "Fehler beim Abrufen der Außentemperatur",
      error instanceof Error ? error.message : String(error));
    return null;
  }
}

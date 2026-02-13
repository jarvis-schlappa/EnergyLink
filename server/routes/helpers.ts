import { log } from "../logger";

/**
 * Prüft ob eine URL für SmartHome-Aufrufe erlaubt ist (SSRF-Schutz).
 *
 * - Nur http/https-Schemes erlaubt
 * - Wenn ALLOWED_SMARTHOME_ORIGINS gesetzt: URL muss mit einer der Origins beginnen
 * - Sonst: Blockiert Link-Local (169.254.x.x) und Metadata-Endpunkte
 */
export function isSmartHomeUrlAllowed(url: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }

  // Nur http/https erlauben
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return false;
  }

  // Allowlist aus Umgebungsvariable (kommaseparierte Origins, z.B. "http://192.168.40.11:8083,http://192.168.40.11:8084")
  const allowedOrigins = process.env.ALLOWED_SMARTHOME_ORIGINS;
  if (allowedOrigins) {
    const origins = allowedOrigins.split(",").map((o) => o.trim()).filter(Boolean);
    return origins.some((origin) => url.startsWith(origin));
  }

  // Ohne Allowlist: Blockiere bekannte gefährliche Ziele
  const hostname = parsed.hostname;

  // Link-Local / Cloud-Metadata (169.254.x.x)
  if (hostname.startsWith("169.254.")) {
    return false;
  }

  // Null-Adresse
  if (hostname === "0.0.0.0") {
    return false;
  }

  return true;
}

/**
 * Ruft eine SmartHome-URL auf (z.B. FHEM-Befehle)
 */
export async function callSmartHomeUrl(url: string | undefined): Promise<void> {
  if (!url) return;

  if (!isSmartHomeUrlAllowed(url)) {
    log(
      "warning",
      "webhook",
      "SmartHome-URL blockiert (SSRF-Schutz)",
      `URL: ${url}`,
    );
    return;
  }

  try {
    log("info", "webhook", `Rufe SmartHome-URL auf`, `URL: ${url}`);
    const response = await fetch(url, { method: "GET" });
    log(
      "info",
      "webhook",
      `SmartHome-URL erfolgreich aufgerufen`,
      `Status: ${response.status}, URL: ${url}`,
    );
  } catch (error) {
    log(
      "error",
      "webhook",
      "Fehler beim Aufruf der SmartHome-URL",
      `URL: ${url}, Fehler: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

/**
 * Fragt den Status eines FHEM-Geräts ab (on/off → true/false)
 */
export async function getFhemDeviceState(
  baseUrl: string,
  deviceName: string,
): Promise<boolean | null> {
  try {
    const url = `${baseUrl}?detail=${deviceName}`;
    log(
      "debug",
      "webhook",
      `Frage FHEM-Gerätestatus ab`,
      `URL: ${url}, Gerät: ${deviceName}`,
    );

    const response = await fetch(url, { method: "GET" });
    if (!response.ok) {
      log(
        "warning",
        "webhook",
        `FHEM-Statusabfrage fehlgeschlagen`,
        `Status: ${response.status}, URL: ${url}`,
      );
      return null;
    }

    const html = await response.text();

    // Suche nach <div informId="deviceName-state">on/off</div>
    const regex = new RegExp(
      `<div informId="${deviceName}-state">([^<]*)`,
      "i",
    );
    const match = html.match(regex);

    if (match && match[1]) {
      const state = match[1].trim().toLowerCase();
      log(
        "debug",
        "webhook",
        `FHEM-Gerätestatus empfangen`,
        `Gerät: ${deviceName}, Status: ${state}`,
      );
      return state === "on";
    }

    log(
      "warning",
      "webhook",
      `FHEM-Status nicht gefunden im HTML`,
      `Gerät: ${deviceName}`,
    );
    return null;
  } catch (error) {
    log(
      "error",
      "webhook",
      "Fehler beim Abrufen des FHEM-Status",
      `Gerät: ${deviceName}, Fehler: ${error instanceof Error ? error.message : String(error)}`,
    );
    return null;
  }
}

/**
 * Extrahiert den Gerätenamen aus einer FHEM-URL
 */
export function extractDeviceNameFromUrl(url: string | undefined): string | null {
  if (!url) return null;
  try {
    // Versuche zuerst detail= Parameter
    let match = url.match(/detail=([^&]+)/);
    if (match && match[1]) {
      return match[1];
    }

    // Fallback: Versuche cmd.DEVICE= Format
    match = url.match(/cmd\.([^=]+)=/);
    if (match && match[1]) {
      return match[1];
    }

    // Fallback: Versuche set%20DEVICE%20 Format (URL-encoded)
    match = url.match(/set%20([^%]+)%20/);
    if (match && match[1]) {
      return match[1];
    }

    // Fallback: Versuche set DEVICE Format (decoded)
    match = url.match(/set\s+(\S+)\s+/);
    if (match && match[1]) {
      return match[1];
    }

    return null;
  } catch {
    return null;
  }
}

/**
 * Extrahiert die Basis-URL (ohne Query-Parameter) aus einer URL
 */
export function extractBaseUrlFromUrl(url: string | undefined): string | null {
  if (!url) return null;
  try {
    const match = url.match(/^(https?:\/\/[^?]+)/);
    return match ? match[1] : null;
  } catch {
    return null;
  }
}

/**
 * Gibt die aktuelle Uhrzeit in der konfigurierten Zeitzone zurück (HH:MM)
 */
export function getCurrentTimeInTimezone(
  timezone: string = "Europe/Berlin",
): string {
  const now = new Date();
  const formatter = new Intl.DateTimeFormat("de-DE", {
    timeZone: timezone,
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });

  const parts = formatter.formatToParts(now);
  const hours = parts.find((p) => p.type === "hour")?.value || "00";
  const minutes = parts.find((p) => p.type === "minute")?.value || "00";

  return `${hours}:${minutes}`;
}

/**
 * Prüft ob eine Zeit (HH:MM) in einem Zeitfenster liegt.
 * Unterstützt Übernacht-Fenster (z.B. 23:00 - 05:00).
 */
export function isTimeInRange(
  current: string,
  start: string,
  end: string,
): boolean {
  const [currentH, currentM] = current.split(":").map(Number);
  const [startH, startM] = start.split(":").map(Number);
  const [endH, endM] = end.split(":").map(Number);

  const currentMinutes = currentH * 60 + currentM;
  const startMinutes = startH * 60 + startM;
  const endMinutes = endH * 60 + endM;

  // Handle overnight time windows (e.g., 23:00 - 05:00)
  if (endMinutes < startMinutes) {
    return currentMinutes >= startMinutes || currentMinutes < endMinutes;
  }

  return currentMinutes >= startMinutes && currentMinutes < endMinutes;
}

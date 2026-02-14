/**
 * Wallbox UDP Transport Layer
 * 
 * Zentrales Modul für die UDP-Kommunikation mit der KEBA Wallbox.
 * Verwaltet Command-Queue und bietet Funktionen für synchrone und asynchrone UDP-Befehle.
 * Nutzt wallboxUdpChannel als zentrale Socket-Instanz.
 * 
 * Wird verwendet von:
 * - server/routes.ts (API-Endpoints)
 * - server/wallbox-broadcast-listener.ts (Input-Broadcast-Handler)
 * - server/charging-strategy-controller.ts (Ladesteuerung)
 */

import { log } from "../core/logger";
import { wallboxUdpChannel, type WallboxMessage } from "./udp-channel";

const UDP_TIMEOUT = 6000;

// Retry-Konfiguration für UDP-Befehle
export interface UdpRetryConfig {
  /** Maximale Anzahl Versuche (inkl. erster Versuch). Default: 3 */
  maxAttempts: number;
  /** Basis-Wartezeit zwischen Versuchen in ms. Default: 500 */
  baseDelayMs: number;
  /** Exponentieller Backoff-Faktor. Default: 2 */
  backoffFactor: number;
}

const DEFAULT_RETRY_CONFIG: UdpRetryConfig = {
  maxAttempts: 3,
  baseDelayMs: 500,
  backoffFactor: 2,
};

// Command Queue für Request/Response-Kommunikation
let currentRequest: { command: string, targetIp: string, resolve: (data: any) => void, reject: (error: Error) => void, timeout: NodeJS.Timeout } | null = null;
let commandQueue: Array<{ ip: string, command: string, resolve: (data: any) => void, reject: (error: Error) => void }> = [];

// Persistenter Message-Handler (wird nur einmal registriert)
let isHandlerRegistered = false;
let messageHandler: ((message: WallboxMessage) => void) | null = null;
let stopListener: (() => void) | null = null;

function parseKebaResponse(response: string): Record<string, any> {
  const trimmed = response.trim();
  
  // Spezialfall: TCH-OK :done Antwort
  if (trimmed.includes("TCH-OK")) {
    const colonIndex = trimmed.indexOf(':');
    if (colonIndex > 0) {
      const key = trimmed.substring(0, colonIndex).trim();
      const value = trimmed.substring(colonIndex + 1).trim();
      return { [key]: value };
    }
    return { "TCH-OK": "done" };
  }
  
  // KEBA Wallbox sendet JSON-Format - versuche zuerst JSON zu parsen
  try {
    if (trimmed.startsWith('{') && trimmed.endsWith('}')) {
      return JSON.parse(trimmed);
    }
  } catch (error) {
    // Kein gültiges JSON - versuche Key=Value Format
  }
  
  // Fallback: Parse Key=Value Format (für ältere Wallbox-Modelle)
  const result: Record<string, any> = {};
  const lines = response.split(/[\n]/);
  
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    
    const colonIndex = trimmed.indexOf(':');
    if (colonIndex > 0) {
      const header = trimmed.substring(0, colonIndex).trim();
      const content = trimmed.substring(colonIndex + 1).trim();
      
      const pairs = content.split(';');
      for (const pair of pairs) {
        const pairTrimmed = pair.trim();
        if (!pairTrimmed) continue;
        
        const equalIndex = pairTrimmed.indexOf('=');
        if (equalIndex > 0) {
          const key = pairTrimmed.substring(0, equalIndex).trim();
          const value = pairTrimmed.substring(equalIndex + 1).trim();
          const numValue = parseFloat(value);
          result[key] = isNaN(numValue) ? value : numValue;
        }
      }
      continue;
    }
    
    const equalIndex = trimmed.indexOf('=');
    if (equalIndex > 0) {
      const key = trimmed.substring(0, equalIndex).trim();
      const value = trimmed.substring(equalIndex + 1).trim();
      const numValue = parseFloat(value);
      result[key] = isNaN(numValue) ? value : numValue;
    }
  }
  
  return result;
}

function isValidReportResponse(command: string, parsed: Record<string, any>): boolean {
  // Prüfe ob die Antwort zum erwarteten Report passt
  // WICHTIG: parsed.ID ist eine Number (parseKebaResponse konvertiert numerische Werte)
  if (command === "report 1") {
    // Report 1 muss ID=1 und Product/Serial/Firmware enthalten
    return (parsed.ID === 1 || String(parsed.ID) === "1") && (parsed.Product || parsed.Serial || parsed.Firmware);
  }
  
  if (command === "report 2") {
    // Report 2 muss ID=2 und State/Plug/"Max curr" enthalten
    return (parsed.ID === 2 || String(parsed.ID) === "2") && (parsed.State !== undefined || parsed.Plug !== undefined || parsed["Max curr"] !== undefined);
  }
  
  if (command === "report 3") {
    // Report 3 muss ID=3 und U1/I1/P enthalten
    return (parsed.ID === 3 || String(parsed.ID) === "3") && (parsed.U1 !== undefined || parsed.I1 !== undefined || parsed.P !== undefined);
  }
  
  // Für ena/curr Befehle: Akzeptiere nur TCH-OK :done
  if (command.startsWith("ena") || command.startsWith("curr")) {
    const responseStr = JSON.stringify(parsed);
    return responseStr.includes("TCH-OK") || parsed["TCH-OK"] !== undefined;
  }
  
  // Für andere Befehle akzeptieren wir jede Antwort
  return true;
}

/**
 * Registriert den persistenten Message-Handler beim UDP-Channel.
 * Wird nur einmal beim ersten Aufruf ausgeführt.
 */
function registerPersistentHandler(): void {
  if (isHandlerRegistered) {
    return; // Handler bereits registriert
  }
  
  // Erstelle persistenten Message-Handler für Command-Responses
  messageHandler = (msg: WallboxMessage) => {
    // Ignoriere Messages wenn kein Request aktiv (verhindert dass unsolicited Broadcasts verarbeitet werden)
    if (!currentRequest) {
      return;
    }
    
    // Zusätzliche Filterung: Ignoriere Broadcast-Messages (Adresse 255.255.255.255 oder nicht von Wallbox-IP)
    // Dies verhindert dass async report 3 Broadcasts (die alle Felder enthalten können) den Request resolven
    const isFromWallbox = msg.rinfo.address === currentRequest.targetIp || msg.rinfo.address === '127.0.0.1';
    if (!isFromWallbox) {
      log("debug", "wallbox", `Antwort ignoriert (nicht von Wallbox-IP ${currentRequest.targetIp})`, `Von: ${msg.rinfo.address}`);
      return;
    }
    
    try {
      log("trace", "wallbox", `UDP-Roh-Antwort empfangen für "${currentRequest.command}"`, `Rohdaten: ${msg.raw.substring(0, 200)}`);
      const parsed = parseKebaResponse(msg.raw);
      
      // Validiere ob die Antwort zum erwarteten Befehl passt
      if (!isValidReportResponse(currentRequest.command, parsed)) {
        log("debug", "wallbox", `Antwort ignoriert (passt nicht zu "${currentRequest.command}")`, `Daten: ${JSON.stringify(parsed).substring(0, 100)}`);
        // Nicht den Timeout clearen - wir warten weiter auf die richtige Antwort
        return;
      }
      
      log("debug", "wallbox", `UDP-Antwort geparst für "${currentRequest.command}"`, `Daten: ${JSON.stringify(parsed).substring(0, 200)}`);
      clearTimeout(currentRequest.timeout);
      const resolve = currentRequest.resolve;
      currentRequest = null;
      resolve(parsed);
      // Kürzere Pause zwischen erfolgreichen Befehlen (100ms reicht jetzt)
      setTimeout(() => processCommandQueue(), 100);
    } catch (error) {
      log("error", "wallbox", "Fehler beim Parsen der UDP-Antwort", error instanceof Error ? error.message : String(error));
      if (currentRequest) {
        clearTimeout(currentRequest.timeout);
        const reject = currentRequest.reject;
        currentRequest = null;
        reject(new Error("Failed to parse UDP response"));
        setTimeout(() => processCommandQueue(), 100);
      }
    }
  };
  
  wallboxUdpChannel.on('message', messageHandler as any);
  
  // Erstelle Stop-Listener der Handler bei Channel-Stop deregistriert
  stopListener = () => {
    log("debug", "system", "[Wallbox-Transport] UDP-Channel gestoppt - Handler wird deregistriert");
    
    // Deregistriere Message-Handler
    if (messageHandler) {
      wallboxUdpChannel.off('message', messageHandler as any);
    }
    
    // KRITISCH: Deregistriere mich selbst um Listener-Leaks zu vermeiden
    const currentStopListener = stopListener;
    if (currentStopListener) {
      wallboxUdpChannel.off('stop', currentStopListener);
    }
    
    // Reset Flags und Variablen
    isHandlerRegistered = false;
    messageHandler = null;
    stopListener = null;
    
    // Reject alle wartenden Requests
    if (currentRequest) {
      clearTimeout(currentRequest.timeout);
      const reject = currentRequest.reject;
      currentRequest = null;
      reject(new Error("UDP channel stopped"));
    }
    
    // Reject alle Requests in der Queue
    while (commandQueue.length > 0) {
      const cmd = commandQueue.shift();
      if (cmd) {
        cmd.reject(new Error("UDP channel stopped"));
      }
    }
  };
  
  wallboxUdpChannel.on('stop', stopListener);
  
  isHandlerRegistered = true;
  log("debug", "system", "[Wallbox-Transport] Persistenter Message-Handler registriert");
}

export async function initWallboxSocket(): Promise<void> {
  // Starte wallboxUdpChannel (Single-Socket-Architektur)
  // Falls bereits gestartet (z.B. von unified-mock), macht start() nichts
  await wallboxUdpChannel.start();
  
  // Registriere Handler nur einmal (bei erstem Aufruf oder nach Channel-Neustart)
  registerPersistentHandler();
}

function processCommandQueue(): void {
  if (currentRequest || commandQueue.length === 0) {
    return;
  }
  
  const nextCommand = commandQueue.shift();
  if (!nextCommand) return;
  
  const { ip, command, resolve, reject } = nextCommand;
  const startTime = Date.now();
  
  log("debug", "wallbox", `Sende UDP-Befehl an ${ip}`, `Befehl: ${command}`);
  
  const timeout = setTimeout(() => {
    const duration = Date.now() - startTime;
    log("error", "wallbox", `UDP-Timeout nach ${duration}ms`, `IP: ${ip}, Befehl: ${command}`);
    currentRequest = null;
    reject(new Error("UDP request timeout"));
    setTimeout(() => processCommandQueue(), 100);
  }, UDP_TIMEOUT);

  currentRequest = { command, targetIp: ip, resolve, reject, timeout };

  wallboxUdpChannel.sendCommand(command, ip)
    .catch((error) => {
      clearTimeout(timeout);
      log("error", "wallbox", "Fehler beim Senden des UDP-Befehls", error instanceof Error ? error.message : String(error));
      currentRequest = null;
      reject(error);
      setTimeout(() => processCommandQueue(), 100);
    });
}

/**
 * Einzelner UDP-Befehl ohne Retry (interne Hilfsfunktion).
 * Wird in die Command-Queue eingereiht um Race-Conditions zu vermeiden.
 */
function sendUdpCommandOnce(ip: string, command: string): Promise<any> {
  return new Promise((resolve, reject) => {
    commandQueue.push({ ip, command, resolve, reject });
    processCommandQueue();
  });
}

/**
 * Sendet einen UDP-Befehl an die Wallbox und wartet auf Antwort.
 * Bei Timeout wird der Befehl mit exponentiellem Backoff wiederholt.
 */
export async function sendUdpCommand(ip: string, command: string, retryConfig?: Partial<UdpRetryConfig>): Promise<any> {
  await initWallboxSocket();
  
  const config = { ...DEFAULT_RETRY_CONFIG, ...retryConfig };
  
  for (let attempt = 1; attempt <= config.maxAttempts; attempt++) {
    try {
      return await sendUdpCommandOnce(ip, command);
    } catch (error) {
      const isTimeout = error instanceof Error && error.message.includes("timeout");
      const isLastAttempt = attempt >= config.maxAttempts;
      
      if (!isTimeout || isLastAttempt) {
        // Nicht-Timeout-Fehler oder letzter Versuch: sofort werfen
        if (isTimeout && isLastAttempt) {
          log("error", "wallbox", `UDP-Befehl fehlgeschlagen nach ${config.maxAttempts} Versuchen`, `IP: ${ip}, Befehl: ${command}`);
        }
        throw error;
      }
      
      // Retry mit exponentiellem Backoff
      const delay = config.baseDelayMs * Math.pow(config.backoffFactor, attempt - 1);
      log("warning", "wallbox", `UDP-Timeout, Retry ${attempt}/${config.maxAttempts - 1}`, `IP: ${ip}, Befehl: ${command}, nächster Versuch in ${delay}ms`);
      await new Promise(resolve => setTimeout(resolve, delay));
    }
  }
  
  // Sollte nie erreicht werden, aber TypeScript braucht es
  throw new Error("UDP retry logic error");
}

/**
 * Sendet einen Fire-and-Forget UDP-Befehl (ohne auf Antwort zu warten).
 * Wird für ena/curr-Befehle verwendet, die nur TCH-OK antworten.
 */
export async function sendUdpCommandNoResponse(ip: string, command: string): Promise<void> {
  await initWallboxSocket();
  
  log("debug", "wallbox", `Sende Fire-and-Forget UDP-Befehl an ${ip}`, `Befehl: ${command}`);
  
  try {
    await wallboxUdpChannel.sendCommand(command, ip);
    log("debug", "wallbox", `Fire-and-Forget Befehl gesendet`, `Befehl: ${command}`);
  } catch (error) {
    log("error", "wallbox", "Fehler beim Senden des UDP-Befehls", error instanceof Error ? error.message : String(error));
    throw error;
  }
}

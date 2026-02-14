/**
 * Server-Sent Events (SSE) Manager für Echtzeit-Status-Updates
 * 
 * Nutzt SSE statt WebSocket, da SSE normale HTTP-Requests verwendet
 * und daher mit Vite's Dev-Server kompatibel ist (kein Proxy nötig).
 */

import { Response } from "express";
import { log } from "../core/logger";
import type { WallboxStatus } from "@shared/schema";

interface SSEClient {
  id: string;
  res: Response;
  lastPing: number;
}

const connectedClients = new Map<string, SSEClient>();
let pingInterval: NodeJS.Timeout | null = null;

/**
 * Initialisiert einen SSE-Client
 */
export function initSSEClient(res: Response): string {
  const clientId = Math.random().toString(36).slice(2, 9);
  
  // SSE Headers setzen
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  
  // Client registrieren
  connectedClients.set(clientId, {
    id: clientId,
    res,
    lastPing: Date.now(),
  });
  
  log("debug", "system", `[SSE] Client verbunden: ${clientId} (${connectedClients.size} gesamt)`);
  
  // Cleanup bei Disconnect
  res.on('close', () => {
    connectedClients.delete(clientId);
    log("debug", "system", `[SSE] Client getrennt: ${clientId} (${connectedClients.size} übrig)`);
  });
  
  // Initiales Keep-Alive senden
  res.write(`:ok\n\n`);
  
  // Ping-System starten (falls noch nicht aktiv)
  if (!pingInterval && connectedClients.size > 0) {
    startPingSystem();
  }
  
  return clientId;
}

/**
 * Sendet Status-Update an alle verbundenen Clients
 */
export function broadcastWallboxStatus(status: WallboxStatus): void {
  if (connectedClients.size === 0) {
    return;
  }

  const data = JSON.stringify({
    type: "wallbox-status",
    data: status,
    timestamp: Date.now(),
  });

  let successCount = 0;
  const failedClients: string[] = [];

  connectedClients.forEach((client) => {
    try {
      client.res.write(`data: ${data}\n\n`);
      successCount++;
    } catch (error) {
      log("debug", "system", `[SSE] Fehler beim Senden an ${client.id}:`, error instanceof Error ? error.message : String(error));
      failedClients.push(client.id);
    }
  });

  // Entferne fehlerhafte Clients
  failedClients.forEach((id) => {
    connectedClients.delete(id);
  });

  if (successCount > 0) {
    log("debug", "system", `[SSE] Status an ${successCount} Clients gesendet`);
  }
}

/**
 * Sendet ein partielles Status-Update an alle verbundenen Clients.
 * Verwendet für spontane Wallbox-Broadcasts (E pres, State) ohne vollständigen Poll.
 */
export function broadcastPartialUpdate(partialStatus: Partial<WallboxStatus>): void {
  if (connectedClients.size === 0) {
    return;
  }

  const data = JSON.stringify({
    type: "wallbox-partial",
    data: { ...partialStatus, lastUpdated: new Date().toISOString() },
    timestamp: Date.now(),
  });

  const failedClients: string[] = [];

  connectedClients.forEach((client) => {
    try {
      client.res.write(`data: ${data}\n\n`);
    } catch (error) {
      failedClients.push(client.id);
    }
  });

  failedClients.forEach((id) => connectedClients.delete(id));
}

/**
 * Ping-System zum Halten der Verbindung
 */
function startPingSystem(): void {
  if (pingInterval) return;
  
  pingInterval = setInterval(() => {
    if (connectedClients.size === 0) {
      stopPingSystem();
      return;
    }
    
    const now = Date.now();
    const failedClients: string[] = [];
    
    connectedClients.forEach((client) => {
      try {
        // Ping alle 30 Sekunden
        if (now - client.lastPing > 30000) {
          client.res.write(`:ping\n\n`);
          client.lastPing = now;
        }
      } catch (error) {
        failedClients.push(client.id);
      }
    });
    
    failedClients.forEach((id) => connectedClients.delete(id));
  }, 15000); // Prüfe alle 15s
  
  log("debug", "system", "[SSE] Ping-System gestartet");
}

function stopPingSystem(): void {
  if (pingInterval) {
    clearInterval(pingInterval);
    pingInterval = null;
    log("debug", "system", "[SSE] Ping-System gestoppt");
  }
}

export function getConnectedClientCount(): number {
  return connectedClients.size;
}

/**
 * Schließt alle SSE-Verbindungen (Graceful Shutdown).
 * Sendet ein Close-Event an alle Clients bevor die Verbindung beendet wird.
 */
export function closeAllSSEClients(): void {
  if (connectedClients.size === 0) {
    return;
  }

  const clientCount = connectedClients.size;

  connectedClients.forEach((client) => {
    try {
      client.res.write(`event: shutdown\ndata: {}\n\n`);
      client.res.end();
    } catch {
      // Client already disconnected - ignore
    }
  });

  connectedClients.clear();
  stopPingSystem();

  log("info", "system", `[SSE] ${clientCount} Client(s) geschlossen (Shutdown)`);
}

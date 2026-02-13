/**
 * Wallbox UDP Channel
 * 
 * Zentrale UDP-Kommunikationsschicht für Port 7090.
 * Besitzt den einzigen Socket und routet Nachrichten an die richtigen Consumer.
 * 
 * Event-Typen:
 * - 'command': KEBA-Befehle wie "report 1", "report 2", "report 3"
 * - 'broadcast': JSON-Broadcasts wie {"Input": 1}, {"E pres": 1234}
 */

import dgram from 'dgram';
import type { Socket, RemoteInfo } from 'dgram';
import { EventEmitter } from 'events';
import { log } from './logger';

const WALLBOX_UDP_PORT = 7090;

export interface WallboxMessage {
  raw: string;
  parsed: any | null;
  rinfo: RemoteInfo;
  isJson: boolean;
  hasId: boolean;
  hasTchToken: boolean;
}

type MessageHandler = (message: WallboxMessage) => void;
type CommandHandler = (command: string, rinfo: RemoteInfo) => void;
type BroadcastHandler = (data: any, rinfo: RemoteInfo) => void;

class WallboxUdpChannel extends EventEmitter {
  private socket: Socket | null = null;
  private isRunning = false;

  async start(): Promise<void> {
    if (this.isRunning) {
      log("debug", "system", "[UDP-Channel] Läuft bereits");
      return;
    }

    try {
      this.socket = dgram.createSocket({ type: 'udp4', reuseAddr: true });

      this.socket.on('error', (err) => {
        log("error", "system", "[UDP-Channel] Socket Error:", err.message);
      });

      this.socket.on('message', (msg, rinfo) => {
        const raw = msg.toString().trim();
        let parsed: any | null = null;
        let isJson = false;
        let hasId = false;
        let hasTchToken = false;
        
        // Parse JSON falls möglich
        if (raw.startsWith('{')) {
          try {
            parsed = JSON.parse(raw);
            isJson = true;
            hasId = parsed.ID !== undefined;
            hasTchToken = parsed["TCH-OK"] !== undefined || parsed["TCH-ERR"] !== undefined;
          } catch (err) {
            log("debug", "system", "[UDP-Channel] JSON-Parse-Fehler:", raw.substring(0, 50));
          }
        }
        
        // Emittiere unified message event mit Metadata
        const wallboxMessage: WallboxMessage = {
          raw,
          parsed,
          rinfo,
          isJson,
          hasId,
          hasTchToken
        };
        
        this.emit('message', wallboxMessage);
        
        // Backward-Compatibility: Emittiere auch alte Events
        // ABER: JSON-Messages werden IMMER als 'broadcast' emittiert, damit unsolicited Broadcasts empfangen werden
        if (isJson) {
          this.emit('broadcast', parsed, rinfo);
        }
        // Nicht-JSON oder TCH-Tokens als 'command'
        if (!isJson || hasTchToken) {
          this.emit('command', raw, rinfo);
        }
      });

      // Bind auf Port 7090
      await new Promise<void>((resolve, reject) => {
        this.socket!.once('error', reject);
        this.socket!.bind(WALLBOX_UDP_PORT, () => {
          this.socket!.removeListener('error', reject);
          resolve();
        });
      });

      this.isRunning = true;
      log("info", "system", "✅ [UDP-Channel] Wallbox UDP-Kanal läuft auf Port 7090");
    } catch (error) {
      log("error", "system", "[UDP-Channel] Start fehlgeschlagen:", error instanceof Error ? error.message : String(error));
      if (this.socket) {
        this.socket.close();
        this.socket = null;
      }
      throw error;
    }
  }

  async stop(): Promise<void> {
    if (!this.isRunning || !this.socket) {
      return;
    }

    return new Promise<void>((resolve) => {
      // Emit 'stop' event BEFORE removing listeners so consumers can cleanup
      this.emit('stop');
      
      this.socket!.close(() => {
        log("info", "system", "✅ [UDP-Channel] Wallbox UDP-Kanal gestoppt");
        this.socket = null;
        this.isRunning = false;
        this.removeAllListeners();
        resolve();
      });
    });
  }

  sendCommandResponse(data: any, address: string, port: number): void {
    if (!this.socket) {
      log("error", "system", "[UDP-Channel] Socket nicht verfügbar");
      return;
    }

    const response = JSON.stringify(data);
    const buffer = Buffer.from(response);

    this.socket.send(buffer, 0, buffer.length, port, address, (err) => {
      if (err) {
        log("error", "system", "[UDP-Channel] Senden fehlgeschlagen:", err.message);
      }
    });
  }

  sendBroadcast(data: any): void {
    if (!this.socket) {
      log("error", "system", "[UDP-Channel] Socket nicht verfügbar");
      return;
    }

    const broadcast = JSON.stringify(data);
    const buffer = Buffer.from(broadcast);

    // Broadcast an 255.255.255.255:7090
    this.socket.setBroadcast(true);
    this.socket.send(buffer, 0, buffer.length, WALLBOX_UDP_PORT, '255.255.255.255', (err) => {
      if (err) {
        log("error", "system", "[UDP-Channel] Broadcast fehlgeschlagen:", err.message);
      }
    });

    // Emittiere 'message' und 'broadcast'-Event auch lokal (Socket empfängt eigenen Broadcast nicht)
    const rinfo = { address: '127.0.0.1', port: WALLBOX_UDP_PORT, family: 'IPv4' as const, size: buffer.length };
    const wallboxMessage: WallboxMessage = {
      raw: broadcast,
      parsed: data,
      rinfo,
      isJson: true,
      hasId: data.ID !== undefined,
      hasTchToken: data["TCH-OK"] !== undefined || data["TCH-ERR"] !== undefined
    };
    this.emit('message', wallboxMessage);
    this.emit('broadcast', data, rinfo);
  }

  sendCommand(command: string, ip: string): Promise<void> {
    if (!this.socket) {
      return Promise.reject(new Error("Socket nicht verfügbar"));
    }

    return new Promise((resolve, reject) => {
      const commandWithNewline = command + "\n";
      this.socket!.send(commandWithNewline, WALLBOX_UDP_PORT, ip, (error) => {
        if (error) {
          reject(error);
        } else {
          resolve();
        }
      });
    });
  }

  onCommand(handler: CommandHandler): void {
    this.on('command', handler);
  }

  onBroadcast(handler: BroadcastHandler): void {
    this.on('broadcast', handler);
  }

  offCommand(handler: CommandHandler): void {
    this.off('command', handler);
  }

  offBroadcast(handler: BroadcastHandler): void {
    this.off('broadcast', handler);
  }
}

// Singleton-Instanz
export const wallboxUdpChannel = new WallboxUdpChannel();

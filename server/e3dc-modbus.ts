import ModbusRTU from "modbus-serial";
import type { E3dcLiveData } from "@shared/schema";
import { storage } from "./storage";
import { log } from "./logger";

/**
 * E3DC S10 Modbus TCP Register Mapping (Simple Mode)
 * 
 * Quelle: Offizielle E3DC Modbus/TCP-Schnittstelle Dokumentation
 * Alle Leistungswerte sind INT32 (2 Register).
 * 
 * WICHTIG: modbus-serial nutzt 0-basierte Offsets, nicht die Holding-Register-Nummern.
 * Holding Register 40068 → Offset 67 (40068 - 40001 = 67)
 * 
 * HINWEIS: Wallbox-Leistung wird NICHT aus E3DC gelesen, sondern immer von KEBA UDP Report 3
 */
const E3DC_REGISTERS = {
  PV_POWER: 67,              // Holding Register 40068, INT32, Watt
  BATTERY_POWER: 69,         // Holding Register 40070, INT32, Watt (negativ = Entladung)
  HOUSE_POWER: 71,           // Holding Register 40072, INT32, Watt
  GRID_POWER: 73,            // Holding Register 40074, INT32, Watt (negativ = Einspeisung)
  AUTARKY_SELFCONS: 81,      // Holding Register 40082, UINT16, High Byte = Autarkie %, Low Byte = Eigenverbrauch %
  BATTERY_SOC: 82,           // Holding Register 40083, UINT16, Prozent
} as const;

const MODBUS_PORT = 502;
const MODBUS_TIMEOUT = 5000; // 5 Sekunden Timeout

/**
 * E3DC Live Data Hub - Event-basierte Pub/Sub-Architektur
 * 
 * Ermöglicht Event-driven Benachrichtigungen an Consumer (FHEM, Frontend, etc.)
 * wenn neue E3DC-Daten verfügbar sind, ohne dass diese selbst pollen müssen.
 * 
 * Features:
 * - Subscribe/Unsubscribe Pattern für Listener
 * - Isolation: Try/Catch um jeden Callback verhindert Kettenreaktionen
 * - Non-blocking: Callbacks laufen in setImmediate für asynchrone Ausführung
 * - Fallback-kompatibel: getLast() für polling-basierte Consumer
 */
class E3dcLiveDataHub {
  private lastData: E3dcLiveData | null = null;
  private subscribers: Set<(data: E3dcLiveData) => void> = new Set();

  /**
   * Registriert einen Listener für neue E3DC-Daten
   * 
   * @param callback - Wird aufgerufen wenn neue Daten verfügbar sind
   * @returns Unsubscribe-Funktion zum Deregistrieren
   */
  subscribe(callback: (data: E3dcLiveData) => void): () => void {
    this.subscribers.add(callback);
    log("debug", "e3dc-hub", `Listener registriert (insgesamt: ${this.subscribers.size})`);
    
    // Sofort mit letzten Daten benachrichtigen, falls vorhanden
    if (this.lastData) {
      setImmediate(() => {
        try {
          callback(this.lastData!);
        } catch (error) {
          log(
            "error",
            "e3dc-hub",
            "Fehler beim initialen Callback eines Listeners",
            error instanceof Error ? error.message : String(error)
          );
        }
      });
    }
    
    // Unsubscribe-Handle zurückgeben
    return () => {
      this.subscribers.delete(callback);
      log("debug", "e3dc-hub", `Listener deregistriert (verbleibend: ${this.subscribers.size})`);
    };
  }

  /**
   * Broadcastet neue E3DC-Daten an alle registrierten Listener
   * 
   * @param data - Die neuen Live-Daten vom E3DC
   */
  emit(data: E3dcLiveData): void {
    this.lastData = data;
    
    if (this.subscribers.size === 0) {
      return; // Keine Listener, nichts zu tun
    }

    log("debug", "e3dc-hub", `Broadcasting an ${this.subscribers.size} Listener`, `PV=${data.pvPower}W, SOC=${data.batterySoc}%`);
    
    // Benachrichtige alle Listener (isoliert und async)
    this.subscribers.forEach((callback) => {
      setImmediate(() => {
        try {
          callback(data);
        } catch (error) {
          log(
            "error",
            "e3dc-hub",
            "Fehler in Listener-Callback (Listener wird fortgesetzt)",
            error instanceof Error ? error.message : String(error)
          );
        }
      });
    });
  }

  /**
   * Gibt die zuletzt empfangenen Live-Daten zurück (Fallback für Polling)
   * 
   * @returns Die letzten Live-Daten oder null wenn noch keine Daten vorhanden
   */
  getLast(): E3dcLiveData | null {
    return this.lastData;
  }

  /**
   * Gibt die Anzahl der registrierten Listener zurück (für Debugging)
   */
  getSubscriberCount(): number {
    return this.subscribers.size;
  }
}

// Singleton-Instanz des Event-Hubs
const e3dcLiveDataHub = new E3dcLiveDataHub();

/**
 * E3DC Live Data Hub-Instanz abrufen (Singleton)
 * 
 * Verwende dies um auf neue E3DC-Daten zu reagieren statt zu pollen:
 * 
 * @example
 * const unsubscribe = getE3dcLiveDataHub().subscribe((data) => {
 *   console.log(`Neue Daten: PV=${data.pvPower}W`);
 * });
 * // Später: unsubscribe();
 */
export function getE3dcLiveDataHub(): E3dcLiveDataHub {
  return e3dcLiveDataHub;
}

/**
 * E3DC Modbus Service
 * 
 * Stellt Verbindung zum E3DC S10 über Modbus TCP her und liest Live-Daten aus.
 */
export class E3dcModbusService {
  private client: ModbusRTU;
  private isConnected: boolean = false;
  private lastError: string | null = null;
  private lastReadData: E3dcLiveData | null = null;

  constructor() {
    this.client = new ModbusRTU();
    this.client.setTimeout(MODBUS_TIMEOUT);
  }

  /**
   * Verbindung zum E3DC S10 herstellen (oder wiederherstellen)
   */
  async connect(ipAddress: string): Promise<void> {
    // Wenn bereits verbunden, keine neue Connection aufbauen
    if (this.isConnected) {
      return;
    }

    try {
      // Schließe alte Connection falls vorhanden (z.B. nach Fehler)
      try {
        this.client.close(() => {});
      } catch {
        // Ignoriere Fehler beim Schließen
      }

      // IP und Port trennen (falls IP:Port Format verwendet wird, z.B. "127.0.0.1:5502")
      let host = ipAddress;
      let port = MODBUS_PORT;
      
      if (ipAddress.includes(':')) {
        const parts = ipAddress.split(':');
        host = parts[0];
        port = parseInt(parts[1], 10) || MODBUS_PORT;
      }

      // Neue Connection aufbauen
      await this.client.connectTCP(host, { port });
      this.client.setID(1); // Modbus Unit ID (Standard: 1)
      this.isConnected = true;
      this.lastError = null;
      log("debug", "system", `E3DC Modbus TCP Verbindung zu ${host}:${port} hergestellt`);
    } catch (error) {
      this.isConnected = false;
      this.lastError = error instanceof Error ? error.message : "Unbekannter Fehler";
      log("error", "system", `E3DC Modbus TCP Verbindungsfehler zu ${ipAddress}`, this.lastError);
      throw new Error(`E3DC Modbus-Verbindung fehlgeschlagen: ${this.lastError}`);
    }
  }

  /**
   * Verbindung trennen
   */
  async disconnect(): Promise<void> {
    if (this.isConnected) {
      this.client.close(() => {
        log("debug", "system", "E3DC Modbus TCP Verbindung getrennt");
      });
      this.isConnected = false;
    }
  }

  /**
   * INT32-Wert aus 2 Modbus-Registern lesen (Little-Endian / LSW first)
   */
  private async readInt32(registerAddress: number): Promise<number> {
    try {
      const data = await this.client.readHoldingRegisters(registerAddress, 2);
      const low = data.data[0];   // LSW (Low Significant Word) zuerst
      const high = data.data[1];  // MSW (Most Significant Word) danach
      
      // INT32 aus 2x UINT16 zusammensetzen (Little-Endian: LSW first)
      const uint32 = (high << 16) | low;
      
      // Konvertierung zu INT32 (Zweier-Komplement)
      return uint32 > 0x7FFFFFFF ? uint32 - 0x100000000 : uint32;
    } catch (error) {
      // Bei Lese-Fehler: Connection als ungültig markieren
      this.isConnected = false;
      this.client.close(() => {});
      
      // Bessere Fehlermeldung mit Details
      const errorMsg = error instanceof Error ? error.message : String(error);
      const detailedMsg = `Modbus Read INT32 @ Register ${registerAddress}: ${errorMsg}`;
      log("error", "system", detailedMsg);
      throw new Error(detailedMsg);
    }
  }

  /**
   * UINT16-Wert aus 1 Modbus-Register lesen
   */
  private async readUint16(registerAddress: number): Promise<number> {
    try {
      const data = await this.client.readHoldingRegisters(registerAddress, 1);
      return data.data[0];
    } catch (error) {
      // Bei Lese-Fehler: Connection als ungültig markieren
      this.isConnected = false;
      this.client.close(() => {});
      
      // Bessere Fehlermeldung mit Details
      const errorMsg = error instanceof Error ? error.message : String(error);
      const detailedMsg = `Modbus Read UINT16 @ Register ${registerAddress}: ${errorMsg}`;
      log("error", "system", detailedMsg);
      throw new Error(detailedMsg);
    }
  }

  /**
   * Live-Daten vom E3DC S10 abrufen
   * 
   * @param kebaWallboxPower - Wallbox-Leistung von KEBA UDP Report 3 (immer verwendet, da E3DC keine Wallbox hat)
   */
  async readLiveData(kebaWallboxPower: number = 0): Promise<E3dcLiveData> {
    // Timestamp SOFORT setzen (bevor Modbus-Reads starten)
    const timestamp = new Date().toISOString();
    
    // Keine explizite Connection-Prüfung - wenn nicht connected, 
    // werden die readInt32/readUint16 Methoden einen Fehler werfen

    try {
      // Alle E3DC Register parallel auslesen (OHNE Wallbox - die kommt von KEBA)
      const [pvPower, batteryPower, housePower, gridPower, autarkySelfCons, batterySoc] = await Promise.all([
        this.readInt32(E3DC_REGISTERS.PV_POWER),
        this.readInt32(E3DC_REGISTERS.BATTERY_POWER),
        this.readInt32(E3DC_REGISTERS.HOUSE_POWER),
        this.readInt32(E3DC_REGISTERS.GRID_POWER),
        this.readUint16(E3DC_REGISTERS.AUTARKY_SELFCONS),
        this.readUint16(E3DC_REGISTERS.BATTERY_SOC),
      ]);

      // Register 40082: Autarkie (High Byte) & Eigenverbrauch (Low Byte)
      const autarky = (autarkySelfCons >> 8) & 0xFF;
      const selfConsumption = autarkySelfCons & 0xFF;

      // DEBUG: Kompakte einzeilige Ausgabe bei LogLevel DEBUG
      log("debug", "system", `E3DC Register gelesen: PV=${pvPower}W, Batterie=${batteryPower}W (SOC=${batterySoc}%), Haus=${housePower}W, Netz=${gridPower}W, Autarkie=${autarky}%, Eigenverbrauch=${selfConsumption}%, Wallbox=${kebaWallboxPower}W`);

      const liveData: E3dcLiveData = {
        pvPower,
        batteryPower,
        batterySoc,
        housePower,
        gridPower,
        wallboxPower: kebaWallboxPower,
        autarky,
        selfConsumption,
        timestamp,
      };
      
      // Cache für FHEM-Sync und andere Consumer
      this.lastReadData = liveData;
      
      return liveData;
    } catch (error) {
      this.lastError = error instanceof Error ? error.message : String(error);
      log("error", "system", "E3DC Fehler beim Lesen der Modbus Register", this.lastError);
      throw error; // Original-Fehler werfen (mit Details aus readInt32/readUint16)
    }
  }
  
  /**
   * Gibt die zuletzt erfolgreich gelesenen Live-Daten zurück (Cache)
   * Nützlich für FHEM-Sync und andere Consumer, die keine extra Modbus-Abfragen machen sollen
   * 
   * @returns Die letzten Live-Daten oder null wenn noch keine Daten gelesen wurden
   */
  getLastReadLiveData(): E3dcLiveData | null {
    return this.lastReadData;
  }

  /**
   * Verbindungsstatus prüfen
   */
  getConnectionStatus(): { connected: boolean; lastError: string | null } {
    return {
      connected: this.isConnected,
      lastError: this.lastError,
    };
  }
}

// Singleton-Instanz für die gesamte Anwendung
let e3dcService: E3dcModbusService | null = null;

/**
 * E3DC Modbus Service-Instanz abrufen (Singleton)
 */
export function getE3dcModbusService(): E3dcModbusService {
  if (!e3dcService) {
    e3dcService = new E3dcModbusService();
  }
  return e3dcService;
}

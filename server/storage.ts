import type { Settings, ControlState, LogEntry, LogSettings, LogLevel, PlugStatusTracking } from "@shared/schema";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { join } from "path";

export interface IStorage {
  getSettings(): Settings | null;
  saveSettings(settings: Settings): void;
  getControlState(): ControlState;
  saveControlState(state: ControlState): void;
  updateControlState(updates: Partial<ControlState>): void;
  getPlugStatusTracking(): PlugStatusTracking;
  savePlugStatusTracking(tracking: PlugStatusTracking): void;
  getLogs(): LogEntry[];
  addLog(entry: Omit<LogEntry, "id" | "timestamp">): void;
  clearLogs(): void;
  getLogSettings(): LogSettings;
  saveLogSettings(settings: LogSettings): void;
}

export class MemStorage implements IStorage {
  private settingsFilePath = join(process.cwd(), "data", "settings.json");
  private controlStateFilePath = join(process.cwd(), "data", "control-state.json");
  private plugTrackingFilePath = join(process.cwd(), "data", "plug-tracking.json");
  private settings: Settings | null = null;
  private controlState: ControlState = {
    pvSurplus: false,
    nightCharging: false,
    batteryLock: false,
    gridCharging: false,
  };
  private plugStatusTracking: PlugStatusTracking = {};
  private logs: LogEntry[] = [];
  private logSettings: LogSettings = {
    level: "info" as LogLevel,
  };
  private maxLogs = 1000;

  constructor() {
    // Erstelle data-Verzeichnis falls nicht vorhanden
    const dataDir = join(process.cwd(), "data");
    if (!existsSync(dataDir)) {
      mkdirSync(dataDir, { recursive: true });
    }

    // Lade Settings aus Datei oder verwende Defaults
    this.settings = this.loadSettingsFromFile();
    
    // Lade Control State aus Datei
    this.controlState = this.loadControlStateFromFile();
    
    // Lade Plug Status Tracking aus Datei
    this.plugStatusTracking = this.loadPlugTrackingFromFile();
  }

  private loadSettingsFromFile(): Settings {
    if (existsSync(this.settingsFilePath)) {
      try {
        const data = readFileSync(this.settingsFilePath, "utf-8");
        const loaded = JSON.parse(data);
        console.log("[Storage] Einstellungen geladen aus:", this.settingsFilePath);
        return loaded;
      } catch (error) {
        console.error("[Storage] Fehler beim Laden der Einstellungen:", error);
      }
    }

    // Default-Einstellungen
    const defaults: Settings = {
      wallboxIp: "192.168.40.16",
      pvSurplusOnUrl: "http://192.168.40.11:8083/fhem?detail=autoWallboxPV&cmd.autoWallboxPV=set%20autoWallboxPV%20on",
      pvSurplusOffUrl: "http://192.168.40.11:8083/fhem?detail=autoWallboxPV&cmd.autoWallboxPV=set%20autoWallboxPV%20off",
      nightChargingSchedule: {
        enabled: false,
        startTime: "00:00",
        endTime: "05:00",
      },
    };
    
    // Speichere Defaults in Datei
    this.saveSettingsToFile(defaults);
    return defaults;
  }

  private saveSettingsToFile(settings: Settings): void {
    try {
      writeFileSync(this.settingsFilePath, JSON.stringify(settings, null, 2), "utf-8");
      console.log("[Storage] Einstellungen gespeichert in:", this.settingsFilePath);
    } catch (error) {
      console.error("[Storage] Fehler beim Speichern der Einstellungen:", error);
    }
  }

  private loadControlStateFromFile(): ControlState {
    if (existsSync(this.controlStateFilePath)) {
      try {
        const data = readFileSync(this.controlStateFilePath, "utf-8");
        const loaded = JSON.parse(data);
        console.log("[Storage] Control State geladen aus:", this.controlStateFilePath);
        
        // Stelle sicher, dass alle Felder vorhanden sind (Backward Compatibility)
        return {
          pvSurplus: false,
          nightCharging: false,
          batteryLock: false,
          gridCharging: false,
          ...loaded,
        };
      } catch (error) {
        console.error("[Storage] Fehler beim Laden des Control States:", error);
      }
    }

    // Default Control State
    return {
      pvSurplus: false,
      nightCharging: false,
      batteryLock: false,
      gridCharging: false,
    };
  }

  private saveControlStateToFile(state: ControlState): void {
    try {
      writeFileSync(this.controlStateFilePath, JSON.stringify(state, null, 2), "utf-8");
      console.log("[Storage] Control State gespeichert in:", this.controlStateFilePath);
    } catch (error) {
      console.error("[Storage] Fehler beim Speichern des Control States:", error);
    }
  }

  private loadPlugTrackingFromFile(): PlugStatusTracking {
    if (existsSync(this.plugTrackingFilePath)) {
      try {
        const data = readFileSync(this.plugTrackingFilePath, "utf-8");
        const loaded = JSON.parse(data);
        console.log("[Storage] Plug Tracking geladen aus:", this.plugTrackingFilePath);
        return loaded;
      } catch (error) {
        console.error("[Storage] Fehler beim Laden des Plug Trackings:", error);
      }
    }
    
    // Default Plug Tracking (leer)
    return {};
  }

  private savePlugTrackingToFile(tracking: PlugStatusTracking): void {
    try {
      writeFileSync(this.plugTrackingFilePath, JSON.stringify(tracking, null, 2), "utf-8");
      console.log("[Storage] Plug Tracking gespeichert in:", this.plugTrackingFilePath);
    } catch (error) {
      console.error("[Storage] Fehler beim Speichern des Plug Trackings:", error);
    }
  }

  getSettings(): Settings | null {
    return this.settings;
  }

  saveSettings(settings: Settings): void {
    this.settings = settings;
    this.saveSettingsToFile(settings);
  }

  getControlState(): ControlState {
    // Stelle sicher, dass immer alle Felder vorhanden sind (wichtig für Migration von alten Daten)
    const defaults: ControlState = {
      pvSurplus: false,
      nightCharging: false,
      batteryLock: false,
      gridCharging: false,
    };
    
    return {
      ...defaults,
      ...this.controlState,
    };
  }

  saveControlState(state: ControlState): void {
    this.controlState = state;
    this.saveControlStateToFile(state);
  }

  updateControlState(updates: Partial<ControlState>): void {
    // Atomar: Lese aktuellen State, merge nur die angegebenen Felder, speichere
    this.controlState = {
      ...this.controlState,
      ...updates,
    };
    this.saveControlStateToFile(this.controlState);
  }

  getPlugStatusTracking(): PlugStatusTracking {
    // Defensive Kopie um Race Conditions zu vermeiden
    return { ...this.plugStatusTracking };
  }

  savePlugStatusTracking(tracking: PlugStatusTracking): void {
    this.plugStatusTracking = tracking;
    this.savePlugTrackingToFile(tracking);
  }

  getLogs(): LogEntry[] {
    return [...this.logs];
  }

  addLog(entry: Omit<LogEntry, "id" | "timestamp">): void {
    const logEntry: LogEntry = {
      id: `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
      timestamp: new Date().toISOString(),
      ...entry,
    };
    
    this.logs.push(logEntry);
    
    if (this.logs.length > this.maxLogs) {
      this.logs = this.logs.slice(-this.maxLogs);
    }
  }

  clearLogs(): void {
    this.logs = [];
  }

  getLogSettings(): LogSettings {
    return this.logSettings;
  }

  saveLogSettings(settings: LogSettings): void {
    this.logSettings = settings;
  }
}

export const storage = new MemStorage();

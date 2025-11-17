import type { Settings } from "@shared/schema";
import { log } from "./logger";

export class ProwlNotifier {
  private apiKey: string;
  private enabled: boolean;

  constructor(settings: Settings | null) {
    this.apiKey = settings?.prowl?.apiKey || "";
    this.enabled = settings?.prowl?.enabled || false;
  }

  updateSettings(settings: Settings | null): void {
    this.apiKey = settings?.prowl?.apiKey || "";
    this.enabled = settings?.prowl?.enabled || false;
  }

  async send(event: string, description: string, priority: number = 0): Promise<boolean> {
    if (!this.enabled) {
      return false;
    }

    if (!this.apiKey) {
      log("warning", "system", "Prowl: API Key nicht konfiguriert");
      return false;
    }

    try {
      const url = new URL('https://api.prowlapp.com/publicapi/add');
      url.searchParams.set('apikey', this.apiKey);
      url.searchParams.set('application', 'EnergyLink');
      url.searchParams.set('event', event);
      url.searchParams.set('description', description);
      url.searchParams.set('priority', priority.toString());

      const response = await fetch(url.toString());

      if (!response.ok) {
        const errorText = await response.text();
        log("warning", "system", `Prowl-Benachrichtigung fehlgeschlagen: ${response.status}`, errorText);
        return false;
      }

      log("debug", "system", `Prowl-Benachrichtigung gesendet: ${event}`);
      return true;
    } catch (error) {
      log("warning", "system", "Prowl-Benachrichtigung fehlgeschlagen", error instanceof Error ? error.message : String(error));
      return false;
    }
  }

  async sendChargingStarted(ampere: number, phases: number, strategy: string): Promise<void> {
    await this.send(
      "Ladung gestartet",
      `${ampere}A @ ${phases} Phase${phases > 1 ? 'n' : ''}\nStrategie: ${this.strategyDisplayName(strategy)}`,
      0
    );
  }

  async sendChargingStopped(reason: string): Promise<void> {
    await this.send(
      "Ladung gestoppt",
      reason,
      0
    );
  }

  async sendCurrentAdjusted(oldAmpere: number, newAmpere: number, phases: number): Promise<void> {
    await this.send(
      "Ladestrom angepasst",
      `${oldAmpere}A → ${newAmpere}A @ ${phases} Phase${phases > 1 ? 'n' : ''}`,
      0
    );
  }

  async sendPlugConnected(): Promise<void> {
    await this.send(
      "Auto angesteckt",
      "",
      0
    );
  }

  async sendPlugDisconnected(): Promise<void> {
    await this.send(
      "Auto abgesteckt",
      "",
      0
    );
  }

  async sendBatteryLockActivated(): Promise<void> {
    await this.send(
      "Batterie-Sperre aktiviert",
      "Hausbatterie wird vor Entladung geschützt",
      0
    );
  }

  async sendBatteryLockDeactivated(): Promise<void> {
    await this.send(
      "Batterie-Sperre deaktiviert",
      "Hausbatterie kann wieder entladen werden",
      0
    );
  }

  async sendGridChargingActivated(): Promise<void> {
    await this.send(
      "Netzstrom-Laden aktiviert",
      "Hausbatterie wird aus dem Netz geladen",
      0
    );
  }

  async sendGridChargingDeactivated(): Promise<void> {
    await this.send(
      "Netzstrom-Laden deaktiviert",
      "Hausbatterie wird nicht mehr aus dem Netz geladen",
      0
    );
  }

  async sendStrategyChanged(oldStrategy: string, newStrategy: string): Promise<void> {
    await this.send(
      "Strategie gewechselt",
      `${this.strategyDisplayName(oldStrategy)} → ${this.strategyDisplayName(newStrategy)}`,
      0
    );
  }

  async sendError(error: string, details?: string): Promise<void> {
    await this.send(
      "Fehler",
      details ? `${error}\n${details}` : error,
      1 // High priority
    );
  }

  async sendTestNotification(): Promise<boolean> {
    return await this.send(
      "EnergyLink Test",
      "Prowl-Benachrichtigungen sind korrekt konfiguriert!",
      0
    );
  }

  private strategyDisplayName(strategy: string): string {
    const names: Record<string, string> = {
      off: "Aus",
      surplus_battery_prio: "PV-Überschuss (Batterie-Priorisierung)",
      surplus_vehicle_prio: "PV-Überschuss (Fahrzeug-Priorisierung)",
      max_with_battery: "Max Power (mit Batterie)",
      max_without_battery: "Max Power (ohne Batterie)",
    };
    return names[strategy] || strategy;
  }
}

let prowlNotifier: ProwlNotifier | null = null;

export function initializeProwlNotifier(settings: Settings | null): void {
  prowlNotifier = new ProwlNotifier(settings);
}

export function getProwlNotifier(): ProwlNotifier {
  if (!prowlNotifier) {
    throw new Error("ProwlNotifier not initialized");
  }
  return prowlNotifier;
}

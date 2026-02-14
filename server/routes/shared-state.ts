import type { Settings } from "@shared/schema";
import { log } from "../core/logger";
import { e3dcClient } from "../e3dc/client";
import { getE3dcModbusService } from "../e3dc/modbus";
import { sendUdpCommand } from "../wallbox/transport";
import { ChargingStrategyController } from "../strategy/charging-strategy-controller";
import { triggerProwlEvent, extractTargetWh } from "../monitoring/prowl-notifier";
import { RealPhaseProvider, MockPhaseProvider } from "../strategy/phase-provider";
import { storage } from "../core/storage";

// Module-scope Scheduler Handles (überleben Hot-Reload)
export let chargingStrategyInterval: NodeJS.Timeout | null = null;
export let nightChargingSchedulerInterval: NodeJS.Timeout | null = null;
export let fhemSyncInterval: NodeJS.Timeout | null = null;
export let e3dcPollerInterval: NodeJS.Timeout | null = null;
export let strategyController: ChargingStrategyController | null = null;

export function setChargingStrategyInterval(v: NodeJS.Timeout | null) { chargingStrategyInterval = v; }
export function setNightChargingSchedulerInterval(v: NodeJS.Timeout | null) { nightChargingSchedulerInterval = v; }
export function setFhemSyncInterval(v: NodeJS.Timeout | null) { fhemSyncInterval = v; }
export function setE3dcPollerInterval(v: NodeJS.Timeout | null) { e3dcPollerInterval = v; }
export function setStrategyController(v: ChargingStrategyController | null) { strategyController = v; }

export function getOrCreateStrategyController(): ChargingStrategyController {
  if (!strategyController) {
    const isDemoMode = process.env.DEMO_AUTOSTART === 'true' || storage.getSettings()?.demoMode;
    const phaseProvider = isDemoMode ? new MockPhaseProvider() : new RealPhaseProvider();
    strategyController = new ChargingStrategyController(sendUdpCommand, phaseProvider);
  }
  return strategyController;
}

// Hilfsfunktion für Batterie-Entladesperre (E3DC)
export async function lockBatteryDischarge(settings: Settings | null): Promise<void> {
  if (settings?.e3dc?.enabled && e3dcClient.isConfigured()) {
    log(
      "info",
      "system",
      `Batterie-Entladesperre: Verwende E3DC-Integration${settings?.demoMode ? " (Demo-Modus)" : ""}`,
    );
    await e3dcClient.lockDischarge();
    
    triggerProwlEvent(settings, "batteryLockActivated", (notifier) =>
      notifier.sendBatteryLockActivated()
    );
  } else {
    log(
      "warning",
      "system",
      `Batterie-Entladesperre: E3DC nicht konfiguriert`,
    );
  }
}

export async function unlockBatteryDischarge(settings: Settings | null): Promise<void> {
  if (settings?.e3dc?.enabled && e3dcClient.isConfigured()) {
    log(
      "info",
      "system",
      `Batterie-Entladesperre aufheben: Verwende E3DC-Integration${settings?.demoMode ? " (Demo-Modus)" : ""}`,
    );
    await e3dcClient.unlockDischarge();
    
    triggerProwlEvent(settings, "batteryLockDeactivated", (notifier) =>
      notifier.sendBatteryLockDeactivated()
    );
  } else {
    log(
      "warning",
      "system",
      `Batterie-Entladesperre aufheben: E3DC nicht konfiguriert`,
    );
  }
}

// Hilfsfunktion für Netzstrom-Laden (E3DC)
export async function enableGridCharging(settings: Settings | null): Promise<void> {
  if (settings?.e3dc?.enabled && e3dcClient.isConfigured()) {
    try {
      log(
        "info",
        "system",
        `Netzstrom-Laden: Verwende E3DC-Integration${settings?.demoMode ? " (Demo-Modus)" : ""}`,
      );
      await e3dcClient.enableGridCharge();
      
      const e3dcData = getE3dcModbusService().getLastReadLiveData();
      const socStart = e3dcData?.batterySoc;
      const targetWh = settings?.e3dc?.gridChargeEnableCommand 
        ? extractTargetWh(settings.e3dc.gridChargeEnableCommand)
        : undefined;
      triggerProwlEvent(settings, "gridChargingActivated", (notifier) =>
        notifier.sendGridChargingActivated(socStart, targetWh)
      );
      
      return;
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : JSON.stringify(error);
      log(
        "error",
        "system",
        `E3DC-Fehler beim Aktivieren des Netzstrom-Ladens`,
        errorMessage,
      );
    }
  } else {
    log("warning", "system", `Netzstrom-Laden: E3DC nicht konfiguriert`);
  }
}

export async function disableGridCharging(settings: Settings | null): Promise<void> {
  if (settings?.e3dc?.enabled && e3dcClient.isConfigured()) {
    try {
      log(
        "info",
        "system",
        `Netzstrom-Laden deaktivieren: Verwende E3DC-Integration${settings?.demoMode ? " (Demo-Modus)" : ""}`,
      );
      await e3dcClient.disableGridCharge();
      
      const e3dcData = getE3dcModbusService().getLastReadLiveData();
      const socEnd = e3dcData?.batterySoc;
      triggerProwlEvent(settings, "gridChargingDeactivated", (notifier) =>
        notifier.sendGridChargingDeactivated(socEnd)
      );
      
      return;
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : JSON.stringify(error);
      log(
        "error",
        "system",
        `E3DC-Fehler beim Deaktivieren des Netzstrom-Ladens`,
        errorMessage,
      );
    }
  } else {
    log(
      "warning",
      "system",
      `Netzstrom-Laden deaktivieren: E3DC nicht konfiguriert`,
    );
  }
}

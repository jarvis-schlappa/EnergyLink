/**
 * Netzfrequenz-Monitor
 * 
 * Überwacht die Netzfrequenz (Normwert 50 Hz) und reagiert auf Abweichungen:
 * 
 * Tier 0: 0 Hz (Messfehler/E3DC nicht verfügbar) → Keine Aktion
 * Tier 1: ±0.1 Hz Abweichung → Grüner Haken (alles OK)
 * Tier 2: >±0.1 Hz Abweichung → Gelbes Warndreieck, Warn-Log, Prowl-Benachrichtigung
 * Tier 3: >±0.2 Hz Abweichung → Rotes Symbol, Warn-Log, Prowl-Benachrichtigung, Batterie auf 90% laden
 */

import { log } from "./logger";
import { storage } from "./storage";
import { getE3dcLiveDataHub } from "./e3dc-modbus";
import { triggerProwlEvent, getProwlNotifier } from "./prowl-notifier";
import { e3dcClient } from "./e3dc-client";
import type { GridFrequencyStatus, E3dcLiveData } from "@shared/schema";

const NOMINAL_FREQUENCY = 50.0;
const TIER_2_THRESHOLD = 0.1;
const TIER_3_THRESHOLD = 0.2;
const HYSTERESIS_COUNT = 2;

interface GridFrequencyState {
  currentTier: 0 | 1 | 2 | 3;
  currentFrequency: number;
  lastTierChange: string | null;
  tier2NotificationSent: boolean;
  tier3NotificationSent: boolean;
  tier3ChargingActive: boolean;
  consecutiveTierReadings: number;
  pendingTier: 0 | 1 | 2 | 3;
}

let state: GridFrequencyState = {
  currentTier: 1,
  currentFrequency: 50.0,
  lastTierChange: null,
  tier2NotificationSent: false,
  tier3NotificationSent: false,
  tier3ChargingActive: false,
  consecutiveTierReadings: 0,
  pendingTier: 1,
};

let listenerRegistered = false;
let unsubscribeFunction: (() => void) | null = null;

function calculateTier(frequency: number, tier2Threshold: number = TIER_2_THRESHOLD, tier3Threshold: number = TIER_3_THRESHOLD): 0 | 1 | 2 | 3 {
  if (frequency === 0) {
    return 0;
  }
  
  const deviation = Math.abs(frequency - NOMINAL_FREQUENCY);
  
  if (deviation > tier3Threshold) {
    return 3;
  } else if (deviation > tier2Threshold) {
    return 2;
  } else {
    return 1;
  }
}

async function handleTierTransition(newTier: 0 | 1 | 2 | 3, frequency: number, soc: number): Promise<void> {
  const oldTier = state.currentTier;
  const deviation = Math.abs(frequency - NOMINAL_FREQUENCY);
  const settings = storage.getSettings();
  
  log("debug", "grid-frequency", `Tier-Wechsel: ${oldTier} → ${newTier} (${frequency.toFixed(2)} Hz, Abweichung: ${deviation.toFixed(3)} Hz)`);
  
  state.currentTier = newTier;
  state.currentFrequency = frequency;
  state.lastTierChange = new Date().toISOString();
  
  if (newTier === 1) {
    state.tier2NotificationSent = false;
    state.tier3NotificationSent = false;
    state.tier3ChargingActive = false;
  }
  
  if (newTier === 2 && !state.tier2NotificationSent) {
    log("warning", "grid-frequency", `Netzfrequenz-Warnung: ${frequency.toFixed(2)} Hz (Abweichung: ${deviation.toFixed(3)} Hz)`);
    
    triggerProwlEvent(settings, "gridFrequencyWarning", async (notifier) => {
      await notifier.send(
        "Netzfrequenz-Warnung",
        `Frequenz: ${frequency.toFixed(2)} Hz\nAbweichung: ${deviation.toFixed(3)} Hz vom Normwert`,
        1
      );
    });
    
    state.tier2NotificationSent = true;
  }
  
  if (newTier === 3 && !state.tier3NotificationSent) {
    log("warning", "grid-frequency", `Netzfrequenz KRITISCH: ${frequency.toFixed(2)} Hz (Abweichung: ${deviation.toFixed(3)} Hz)`);
    
    triggerProwlEvent(settings, "gridFrequencyCritical", async (notifier) => {
      await notifier.send(
        "Netzfrequenz KRITISCH",
        `Frequenz: ${frequency.toFixed(2)} Hz\nAbweichung: ${deviation.toFixed(3)} Hz\n\nNotladung der Hausbatterie wird gestartet.`,
        2
      );
    });
    
    state.tier3NotificationSent = true;
    
    if (!state.tier3ChargingActive && settings?.gridFrequencyMonitor?.enableEmergencyCharging) {
      log("warning", "grid-frequency", `Starte Notladung (aktueller SOC: ${soc}%)`);
      
      try {
        if (settings?.e3dc?.enabled) {
          await e3dcClient.enableGridCharge();
          state.tier3ChargingActive = true;
        } else {
          log("warning", "grid-frequency", "E3DC nicht aktiviert - Notladung nicht möglich");
        }
      } catch (error) {
        log("error", "grid-frequency", "Fehler beim Starten der Notladung", error instanceof Error ? error.message : String(error));
      }
    } else if (!state.tier3ChargingActive && !settings?.gridFrequencyMonitor?.enableEmergencyCharging) {
      log("info", "grid-frequency", "Tier 3 erreicht, aber Notladung ist deaktiviert");
    }
  }
}

function onLiveData(data: E3dcLiveData): void {
  const settings = storage.getSettings();
  
  // Überwachung ist deaktiviert
  if (!settings?.gridFrequencyMonitor?.enabled) {
    return;
  }
  
  const frequency = data.gridFrequency ?? 0;
  const soc = data.batterySoc;
  const tier2Threshold = settings.gridFrequencyMonitor.tier2Threshold ?? TIER_2_THRESHOLD;
  const tier3Threshold = settings.gridFrequencyMonitor.tier3Threshold ?? TIER_3_THRESHOLD;
  const newTier = calculateTier(frequency, tier2Threshold, tier3Threshold);
  
  state.currentFrequency = frequency;
  
  const deviation = Math.abs(frequency - NOMINAL_FREQUENCY);
  
  if (newTier >= 2) {
    const tierLabel = newTier === 3 ? "KRITISCH (Tier 3)" : "Warnung (Tier 2)";
    log("info", "grid-frequency", `Frequenz ${tierLabel}: ${frequency.toFixed(2)} Hz (Abweichung: ${deviation.toFixed(3)} Hz)`);
  }
  
  if (newTier === state.pendingTier) {
    state.consecutiveTierReadings++;
  } else {
    state.pendingTier = newTier;
    state.consecutiveTierReadings = 1;
  }
  
  if (state.consecutiveTierReadings >= HYSTERESIS_COUNT && newTier !== state.currentTier) {
    void handleTierTransition(newTier, frequency, soc);
    state.consecutiveTierReadings = 0;
  }
}

export function startGridFrequencyMonitor(): void {
  if (listenerRegistered) {
    log("debug", "grid-frequency", "Bereits gestartet");
    return;
  }
  
  const settings = storage.getSettings();
  
  // Überwachung ist deaktiviert in den Einstellungen
  if (!settings?.gridFrequencyMonitor?.enabled) {
    log("info", "grid-frequency", "Überwachung ist deaktiviert in den Einstellungen");
    return;
  }
  
  const hub = getE3dcLiveDataHub();
  unsubscribeFunction = hub.subscribe(onLiveData);
  listenerRegistered = true;
  
  const tier2Threshold = settings.gridFrequencyMonitor.tier2Threshold ?? TIER_2_THRESHOLD;
  const tier3Threshold = settings.gridFrequencyMonitor.tier3Threshold ?? TIER_3_THRESHOLD;
  const emergencyChargingEnabled = settings.gridFrequencyMonitor.enableEmergencyCharging ?? true;
  
  log("info", "grid-frequency", "Netzfrequenz-Überwachung gestartet");
  log("info", "grid-frequency", `Schwellwerte: Tier 2 = ±${tier2Threshold} Hz, Tier 3 = ±${tier3Threshold} Hz`);
  log("info", "grid-frequency", `Notladung bei Tier 3: ${emergencyChargingEnabled ? 'aktiviert' : 'deaktiviert'}`);
}

export function stopGridFrequencyMonitor(): void {
  if (!listenerRegistered) {
    return;
  }
  
  if (unsubscribeFunction) {
    unsubscribeFunction();
    unsubscribeFunction = null;
  }
  listenerRegistered = false;
  
  log("info", "grid-frequency", "Netzfrequenz-Überwachung gestoppt");
}

export function getGridFrequencyState(): GridFrequencyStatus {
  return {
    tier: state.currentTier,
    frequency: state.currentFrequency,
    deviation: Math.abs(state.currentFrequency - NOMINAL_FREQUENCY),
    chargingActive: state.tier3ChargingActive,
    lastUpdate: state.lastTierChange || new Date().toISOString(),
  };
}

export function resetGridFrequencyState(): void {
  state = {
    currentTier: 1,
    currentFrequency: 50.0,
    lastTierChange: null,
    tier2NotificationSent: false,
    tier3NotificationSent: false,
    tier3ChargingActive: false,
    consecutiveTierReadings: 0,
    pendingTier: 1,
  };
  log("debug", "grid-frequency", "State zurückgesetzt");
}

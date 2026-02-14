import type { ChargingStrategyConfig } from "@shared/schema";
import { storage } from "./storage";

/**
 * Interface für die Bestimmung der Phasenzahl beim Ladestart.
 * Entkoppelt die Demo/Real-Logik vom ChargingStrategyController.
 */
export interface PhaseProvider {
  /**
   * Bestimmt die Phasenzahl für den Ladestart (wenn Wallbox noch nicht aktiv ist).
   * 
   * @param isSurplusStrategy true bei surplus_battery_prio / surplus_vehicle_prio
   * @param config aktuelle Ladestrategie-Konfiguration
   * @returns Phasenzahl (1 oder 3)
   */
  getStartPhases(isSurplusStrategy: boolean, config: ChargingStrategyConfig): number;
}

/**
 * Produktiv-Modus: Phasen aus physicalPhaseSwitch (User-Konfiguration).
 * Bei Surplus-Strategien immer 1P (niedrige Startleistung).
 */
export class RealPhaseProvider implements PhaseProvider {
  getStartPhases(isSurplusStrategy: boolean, config: ChargingStrategyConfig): number {
    return isSurplusStrategy ? 1 : (config.physicalPhaseSwitch ?? 3);
  }
}

/**
 * Demo-Modus: Phasen aus mockWallboxPhases in Settings.
 */
export class MockPhaseProvider implements PhaseProvider {
  getStartPhases(_isSurplusStrategy: boolean, _config: ChargingStrategyConfig): number {
    const settings = storage.getSettings();
    return settings?.mockWallboxPhases ?? 3;
  }
}

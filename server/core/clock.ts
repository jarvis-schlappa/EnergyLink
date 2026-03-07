/**
 * Zentrale Zeitquelle für EnergyLink.
 * Im Demo-Modus mit mockTimeEnabled wird die konfigurierte mockDateTime als Basis genommen,
 * aber die Echtzeit tickt weiter (Offset-basiert).
 * So funktionieren Delays, Timer und Intervalle korrekt.
 */
import { storage } from "./storage";

let mockOffset: number | null = null;
let lastMockDateTime: string | null = null;

export function getNow(): Date {
  const settings = storage.getSettings();

  if (settings?.demoMode && settings?.mockTimeEnabled && settings?.mockDateTime) {
    // Offset nur neu berechnen wenn sich mockDateTime ändert
    if (settings.mockDateTime !== lastMockDateTime) {
      const mockDate = new Date(settings.mockDateTime);
      if (!isNaN(mockDate.getTime())) {
        mockOffset = mockDate.getTime() - Date.now();
        lastMockDateTime = settings.mockDateTime;
      }
    }

    if (mockOffset !== null) {
      return new Date(Date.now() + mockOffset);
    }
  }

  return new Date();
}

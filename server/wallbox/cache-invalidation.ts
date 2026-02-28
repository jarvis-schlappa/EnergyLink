import { resetStatusPollThrottle } from "../routes/wallbox-routes";
import { resetWallboxIdleThrottle } from "../e3dc/poller";

/**
 * Invalidiert alle Wallbox-bezogenen Caches.
 * Muss bei jeder State-/Strategie-Änderung aufgerufen werden.
 * Verhindert Bugs wie #73 und #74.
 *
 * Bündelt:
 * - resetStatusPollThrottle() → nächster /api/wallbox/status liefert frische UDP-Daten
 * - resetWallboxIdleThrottle() → nächster E3DC-Poll fragt sofort die Wallbox ab
 */
export function invalidateWallboxCaches(): void {
  resetStatusPollThrottle();
  resetWallboxIdleThrottle();
}

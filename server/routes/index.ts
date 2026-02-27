import type { Express } from "express";

import { log } from "../core/logger";
import { registerWallboxRoutes } from "./wallbox-routes";
import { registerE3dcRoutes } from "./e3dc-routes";
import { registerSettingsRoutes } from "./settings-routes";
import { registerStatusRoutes } from "./status-routes";
import { registerDemoRoutes } from "./demo-routes";
import { registerGarageRoutes } from "./garage-routes";
import { startSchedulers, shutdownSchedulers } from "./scheduler";

// Re-export helpers for direct import by tests
export { isTimeInRange, getCurrentTimeInTimezone } from "./helpers";
export { callSmartHomeUrl, isSmartHomeUrlAllowed, getFhemDeviceState, extractDeviceNameFromUrl, extractBaseUrlFromUrl } from "./helpers";

// Re-export shutdownSchedulers for index.ts
export { shutdownSchedulers };

export async function registerRoutes(app: Express): Promise<void> {
  // Register all route groups
  registerWallboxRoutes(app);
  registerE3dcRoutes(app);
  registerSettingsRoutes(app);
  registerStatusRoutes(app);
  registerGarageRoutes(app);

  // Demo-Routes immer registrieren (Runtime-Check auf demoMode erfolgt in den Routes selbst)
  // Dies ermöglicht Demo-Modus-Toggle zur Laufzeit ohne Server-Neustart
  registerDemoRoutes(app);
  log("debug", "system", "Demo-Routes registriert (/api/wallbox/demo-input, /api/wallbox/demo-plug)");

  // Start all schedulers (night charging, charging strategy, E3DC poller, FHEM sync, grid frequency)
  await startSchedulers();

  // SSE-Server für Echtzeit-Wallbox-Updates ist bereits via /api/wallbox/stream konfiguriert
  log("info", "system", "SSE-Server für Wallbox-Status-Updates bereit");
}

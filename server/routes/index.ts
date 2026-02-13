import type { Express } from "express";
import { createServer, type Server } from "http";
import { log } from "../logger";
import { registerWallboxRoutes } from "./wallbox-routes";
import { registerE3dcRoutes } from "./e3dc-routes";
import { registerSettingsRoutes } from "./settings-routes";
import { startSchedulers, shutdownSchedulers } from "./scheduler";

// Re-export helpers for direct import by tests
export { isTimeInRange, getCurrentTimeInTimezone } from "./helpers";
export { callSmartHomeUrl, getFhemDeviceState, extractDeviceNameFromUrl, extractBaseUrlFromUrl } from "./helpers";

// Re-export shutdownSchedulers for index.ts
export { shutdownSchedulers };

export async function registerRoutes(app: Express): Promise<Server> {
  // Register all route groups
  registerWallboxRoutes(app);
  registerE3dcRoutes(app);
  registerSettingsRoutes(app);

  // Start all schedulers (night charging, charging strategy, E3DC poller, FHEM sync, grid frequency)
  await startSchedulers();

  const httpServer = createServer(app);

  // SSE-Server für Echtzeit-Wallbox-Updates ist bereits via /api/wallbox/stream konfiguriert
  log("info", "system", "SSE-Server für Wallbox-Status-Updates bereit");

  return httpServer;
}

import type { LogLevel } from "@shared/schema";
import { storage } from "./storage";

const logLevelPriority: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warning: 2,
  error: 3,
};

export function log(level: LogLevel, category: "wallbox" | "webhook" | "system", message: string, details?: string): void {
  const currentSettings = storage.getLogSettings();
  const currentLevelPriority = logLevelPriority[currentSettings.level];
  const messageLevelPriority = logLevelPriority[level];
  
  if (messageLevelPriority >= currentLevelPriority) {
    storage.addLog({ level, category, message, details });
    console.log(`[${level.toUpperCase()}] [${category}] ${message}${details ? ` - ${details}` : ""}`);
  }
}

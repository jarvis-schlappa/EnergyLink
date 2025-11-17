import type { LogLevel } from "@shared/schema";
import { storage } from "./storage";

const logLevelPriority: Record<LogLevel, number> = {
  trace: 0,
  debug: 1,
  info: 2,
  warning: 3,
  error: 4,
};

export function log(
  level: LogLevel, 
  category: "wallbox" | "wallbox-mock" | "e3dc" | "e3dc-mock" | "e3dc-poller" | "e3dc-hub" | "fhem" | "fhem-mock" | "webhook" | "system" | "storage" | "strategy", 
  message: string, 
  details?: string
): void {
  const currentSettings = storage.getLogSettings();
  const currentLevelPriority = logLevelPriority[currentSettings.level];
  const messageLevelPriority = logLevelPriority[level];
  
  if (messageLevelPriority >= currentLevelPriority) {
    const now = new Date();
    const timestamp = now.toLocaleTimeString('de-DE', { 
      hour: '2-digit', 
      minute: '2-digit', 
      second: '2-digit',
      fractionalSecondDigits: 3 
    });
    
    storage.addLog({ level, category, message, details });
    console.log(`[${timestamp}] [${level.toUpperCase()}] [${category}] ${message}${details ? ` - ${details}` : ""}`);
  }
}

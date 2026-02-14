import { log } from "./logger";

type LogLevel = "warning" | "info" | "debug";

interface EnvVarConfig {
  name: string;
  required: boolean;
  defaultValue?: string;
  description: string;
  /** Log level when not set (default: "warning") */
  missingLogLevel?: LogLevel;
}

const ENV_VARS: EnvVarConfig[] = [
  {
    name: "PORT",
    required: false,
    defaultValue: "3000",
    description: "HTTP-Server-Port",
    missingLogLevel: "info",
  },
  {
    name: "API_KEY",
    required: false,
    description: "API-Schlüssel für Authentifizierung (ohne: ungeschützter Legacy-Modus)",
    missingLogLevel: "warning",
  },
  {
    name: "NODE_ENV",
    required: false,
    defaultValue: "development",
    description: "Umgebung (development/production)",
  },
  {
    name: "DEMO_AUTOSTART",
    required: false,
    description: "Demo-Modus beim Start aktivieren (true/false)",
    missingLogLevel: "debug",
  },
  {
    name: "BUILD_BRANCH",
    required: false,
    description: "Git-Branch (Build-Zeit, Fallback: git CLI)",
    missingLogLevel: "debug",
  },
  {
    name: "BUILD_COMMIT",
    required: false,
    description: "Git-Commit-Hash (Build-Zeit, Fallback: git CLI)",
    missingLogLevel: "debug",
  },
  {
    name: "BUILD_TIME",
    required: false,
    description: "Build-Zeitstempel (Fallback: Startzeit)",
    missingLogLevel: "debug",
  },
];

export interface EnvMessage {
  level: LogLevel;
  message: string;
}

export interface ValidationResult {
  valid: boolean;
  missing: string[];
  warnings: string[];
  messages: EnvMessage[];
}

/**
 * Validates environment variables at startup.
 * Required vars → error + process exit.
 * Optional vars without value → warning log.
 */
export function validateEnvironment(): ValidationResult {
  const missing: string[] = [];
  const warnings: string[] = [];
  const messages: EnvMessage[] = [];

  for (const envVar of ENV_VARS) {
    const value = process.env[envVar.name];

    if (!value) {
      if (envVar.required) {
        missing.push(`${envVar.name} – ${envVar.description}`);
      } else {
        const defaultInfo = envVar.defaultValue
          ? ` (Default: ${envVar.defaultValue})`
          : "";
        const msg = `${envVar.name} nicht gesetzt${defaultInfo} – ${envVar.description}`;
        const level = envVar.missingLogLevel ?? "warning";
        messages.push({ level, message: msg });
        if (level === "warning") {
          warnings.push(msg);
        }
      }
    }
  }

  // Log messages at their appropriate levels
  for (const { level, message } of messages) {
    const prefix = level === "warning" ? "⚠️ " : "";
    log(level, "system", `${prefix}${message}`);
  }

  // Log errors and exit if required vars missing
  if (missing.length > 0) {
    log("error", "system", "❌ Fehlende Pflicht-Environment-Variablen:");
    for (const m of missing) {
      log("error", "system", `   → ${m}`);
    }
    log("error", "system", "Server kann nicht starten. Bitte setze die fehlenden Variablen.");
  }

  return { valid: missing.length === 0, missing, warnings, messages };
}

import { log } from "./logger";

interface EnvVarConfig {
  name: string;
  required: boolean;
  defaultValue?: string;
  description: string;
}

const ENV_VARS: EnvVarConfig[] = [
  {
    name: "PORT",
    required: false,
    defaultValue: "5000",
    description: "HTTP-Server-Port",
  },
  {
    name: "API_KEY",
    required: false,
    description: "API-Schlüssel für Authentifizierung (ohne: ungeschützter Legacy-Modus)",
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
  },
  {
    name: "BUILD_BRANCH",
    required: false,
    description: "Git-Branch (Build-Zeit, Fallback: git CLI)",
  },
  {
    name: "BUILD_COMMIT",
    required: false,
    description: "Git-Commit-Hash (Build-Zeit, Fallback: git CLI)",
  },
  {
    name: "BUILD_TIME",
    required: false,
    description: "Build-Zeitstempel (Fallback: Startzeit)",
  },
];

export interface ValidationResult {
  valid: boolean;
  missing: string[];
  warnings: string[];
}

/**
 * Validates environment variables at startup.
 * Required vars → error + process exit.
 * Optional vars without value → warning log.
 */
export function validateEnvironment(): ValidationResult {
  const missing: string[] = [];
  const warnings: string[] = [];

  for (const envVar of ENV_VARS) {
    const value = process.env[envVar.name];

    if (!value) {
      if (envVar.required) {
        missing.push(`${envVar.name} – ${envVar.description}`);
      } else {
        const defaultInfo = envVar.defaultValue
          ? ` (Default: ${envVar.defaultValue})`
          : "";
        warnings.push(`${envVar.name} nicht gesetzt${defaultInfo} – ${envVar.description}`);
      }
    }
  }

  // Log warnings
  for (const warning of warnings) {
    log("warning", "system", `⚠️ ${warning}`);
  }

  // Log errors and exit if required vars missing
  if (missing.length > 0) {
    log("error", "system", "❌ Fehlende Pflicht-Environment-Variablen:");
    for (const m of missing) {
      log("error", "system", `   → ${m}`);
    }
    log("error", "system", "Server kann nicht starten. Bitte setze die fehlenden Variablen.");
  }

  return { valid: missing.length === 0, missing, warnings };
}

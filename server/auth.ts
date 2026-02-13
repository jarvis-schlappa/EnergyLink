import { timingSafeEqual } from "crypto";
import type { Request, Response, NextFunction } from "express";
import { log } from "./logger";

const API_KEY = process.env.API_KEY;

if (!API_KEY) {
  log("warning", "system", "⚠️ API_KEY nicht gesetzt – API ist ungeschützt (Legacy-Modus)");
}

/**
 * Middleware für API-Key-basierte Authentifizierung.
 * 
 * Akzeptiert den Key via:
 * - `Authorization: Bearer <key>` Header
 * - `X-API-Key: <key>` Header
 * 
 * Wenn keine API_KEY Environment-Variable gesetzt ist, wird alles durchgelassen
 * (Rückwärtskompatibilität für bestehende LAN-Installationen).
 */
export function requireApiKey(req: Request, res: Response, next: NextFunction): void {
  // Kein API_KEY konfiguriert → Legacy-Modus, alles erlaubt
  if (!API_KEY) {
    return next();
  }

  const authHeader = req.headers["authorization"];
  const apiKeyHeader = req.headers["x-api-key"];

  let providedKey: string | undefined;

  if (typeof authHeader === "string" && authHeader.startsWith("Bearer ")) {
    providedKey = authHeader.slice(7);
  } else if (typeof apiKeyHeader === "string") {
    providedKey = apiKeyHeader;
  }

  if (!providedKey) {
    res.status(401).json({ error: "Authentication required" });
    return;
  }

  const keyBuffer = Buffer.from(API_KEY, "utf8");
  const providedBuffer = Buffer.from(providedKey, "utf8");

  if (keyBuffer.length !== providedBuffer.length || !timingSafeEqual(keyBuffer, providedBuffer)) {
    res.status(401).json({ error: "Invalid API key" });
    return;
  }

  next();
}

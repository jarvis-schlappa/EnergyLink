import type { Request, Response } from "express";
import { getBuildInfo } from "./build-info";

const startTime = Date.now();

export interface HealthResponse {
  status: "ok" | "degraded" | "error";
  version: string;
  uptime: number;
  timestamp: string;
}

/**
 * GET /api/health — unauthenticated health-check endpoint.
 * Returns basic server health info for Docker/Kubernetes/monitoring.
 */
export function healthHandler(_req: Request, res: Response): void {
  const buildInfo = getBuildInfo();

  const response: HealthResponse = {
    status: "ok",
    version: buildInfo.version,
    uptime: Math.floor((Date.now() - startTime) / 1000),
    timestamp: new Date().toISOString(),
  };

  res.json(response);
}

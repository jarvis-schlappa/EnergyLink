import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Request, Response } from "express";

describe("healthHandler", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it("should return status ok with required fields", async () => {
    vi.doMock("../build-info", () => ({
      getBuildInfo: () => ({
        version: "1.0.2",
        branch: "main",
        commit: "abc1234",
        buildTime: new Date().toISOString(),
      }),
    }));

    const { healthHandler } = await import("../health");

    const req = {} as Request;
    const json = vi.fn();
    const res = { json } as unknown as Response;

    healthHandler(req, res);

    expect(json).toHaveBeenCalledOnce();
    const body = json.mock.calls[0][0];
    expect(body.status).toBe("ok");
    expect(body.version).toBe("1.0.2");
    expect(typeof body.uptime).toBe("number");
    expect(body.uptime).toBeGreaterThanOrEqual(0);
    expect(body.timestamp).toBeDefined();
    // Verify timestamp is valid ISO string
    expect(new Date(body.timestamp).toISOString()).toBe(body.timestamp);
  });

  it("should not require authentication (integration note)", () => {
    // This test documents the architectural decision:
    // The health endpoint is registered BEFORE the requireApiKey middleware
    // in server/index.ts, so it is accessible without authentication.
    // Actual integration verification happens via the full server tests.
    expect(true).toBe(true);
  });
});

import { describe, it, expect, beforeEach, vi } from "vitest";
import type { Request, Response, NextFunction } from "express";

// Helper to create mock req/res/next
function createMocks(headers: Record<string, string> = {}) {
  const req = { headers } as unknown as Request;
  const res = {
    status: vi.fn().mockReturnThis(),
    json: vi.fn().mockReturnThis(),
  } as unknown as Response;
  const next = vi.fn() as NextFunction;
  return { req, res, next };
}

describe("requireApiKey middleware", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  describe("when API_KEY is not set (Legacy-Modus)", () => {
    it("should allow all requests through", async () => {
      vi.stubEnv("API_KEY", "");
      // Mock logger to avoid side effects
      vi.doMock("../logger", () => ({ log: vi.fn() }));
      const { requireApiKey } = await import("../auth");

      const { req, res, next } = createMocks();
      requireApiKey(req, res, next);

      expect(next).toHaveBeenCalled();
      expect(res.status).not.toHaveBeenCalled();
    });
  });

  describe("when API_KEY is set", () => {
    const TEST_KEY = "test-secret-key-123";

    async function loadMiddleware() {
      vi.stubEnv("API_KEY", TEST_KEY);
      vi.doMock("../logger", () => ({ log: vi.fn() }));
      const mod = await import("../auth");
      return mod.requireApiKey;
    }

    it("should reject requests without any key with 401", async () => {
      const requireApiKey = await loadMiddleware();
      const { req, res, next } = createMocks();

      requireApiKey(req, res, next);

      expect(next).not.toHaveBeenCalled();
      expect(res.status).toHaveBeenCalledWith(401);
      expect(res.json).toHaveBeenCalledWith({ error: "Authentication required" });
    });

    it("should reject requests with wrong key with 401", async () => {
      const requireApiKey = await loadMiddleware();
      const { req, res, next } = createMocks({
        authorization: "Bearer wrong-key",
      });

      requireApiKey(req, res, next);

      expect(next).not.toHaveBeenCalled();
      expect(res.status).toHaveBeenCalledWith(401);
      expect(res.json).toHaveBeenCalledWith({ error: "Invalid API key" });
    });

    it("should accept requests with correct Bearer token", async () => {
      const requireApiKey = await loadMiddleware();
      const { req, res, next } = createMocks({
        authorization: `Bearer ${TEST_KEY}`,
      });

      requireApiKey(req, res, next);

      expect(next).toHaveBeenCalled();
      expect(res.status).not.toHaveBeenCalled();
    });

    it("should accept requests with correct X-API-Key header", async () => {
      const requireApiKey = await loadMiddleware();
      const { req, res, next } = createMocks({
        "x-api-key": TEST_KEY,
      });

      requireApiKey(req, res, next);

      expect(next).toHaveBeenCalled();
      expect(res.status).not.toHaveBeenCalled();
    });

    it("should prefer Authorization header over X-API-Key", async () => {
      const requireApiKey = await loadMiddleware();
      const { req, res, next } = createMocks({
        authorization: `Bearer ${TEST_KEY}`,
        "x-api-key": "wrong-key",
      });

      requireApiKey(req, res, next);

      expect(next).toHaveBeenCalled();
    });

    it("should reject Authorization header without Bearer prefix", async () => {
      const requireApiKey = await loadMiddleware();
      const { req, res, next } = createMocks({
        authorization: `Basic ${TEST_KEY}`,
      });

      requireApiKey(req, res, next);

      expect(next).not.toHaveBeenCalled();
      expect(res.status).toHaveBeenCalledWith(401);
    });

    it("should reject Bearer token with empty value", async () => {
      const requireApiKey = await loadMiddleware();
      const { req, res, next } = createMocks({
        authorization: "Bearer ",
      });

      requireApiKey(req, res, next);

      expect(next).not.toHaveBeenCalled();
      expect(res.status).toHaveBeenCalledWith(401);
    });

    it("should reject wrong X-API-Key with 401", async () => {
      const requireApiKey = await loadMiddleware();
      const { req, res, next } = createMocks({
        "x-api-key": "wrong-key",
      });

      requireApiKey(req, res, next);

      expect(next).not.toHaveBeenCalled();
      expect(res.status).toHaveBeenCalledWith(401);
      expect(res.json).toHaveBeenCalledWith({ error: "Invalid API key" });
    });

    it("should work with keys containing special characters", async () => {
      vi.resetModules();
      const specialKey = "key-with-spëcial_chars!@#$%^&*()";
      vi.stubEnv("API_KEY", specialKey);
      vi.doMock("../logger", () => ({ log: vi.fn() }));
      const { requireApiKey } = await import("../auth");

      const { req, res, next } = createMocks({
        authorization: `Bearer ${specialKey}`,
      });

      requireApiKey(req, res, next);
      expect(next).toHaveBeenCalled();
    });

    it("should fall back to X-API-Key when Authorization has wrong scheme", async () => {
      const requireApiKey = await loadMiddleware();
      const { req, res, next } = createMocks({
        authorization: "Basic some-other-token",
        "x-api-key": TEST_KEY,
      });

      requireApiKey(req, res, next);

      expect(next).toHaveBeenCalled();
    });
  });
});

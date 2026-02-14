import { describe, it, expect, beforeEach, vi } from "vitest";

// Mock logger to avoid side effects
vi.mock("../core/logger", () => ({
  log: vi.fn(),
}));

describe("validateEnvironment", () => {
  const originalEnv = process.env;

  beforeEach(() => {
    vi.resetModules();
    process.env = { ...originalEnv };
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  it("should return valid when all optional vars are missing (all have defaults)", async () => {
    // Clear all known env vars
    delete process.env.PORT;
    delete process.env.API_KEY;
    delete process.env.NODE_ENV;
    delete process.env.DEMO_AUTOSTART;
    delete process.env.BUILD_BRANCH;
    delete process.env.BUILD_COMMIT;
    delete process.env.BUILD_TIME;

    const { validateEnvironment } = await import("../core/env-validation");
    const result = validateEnvironment();

    expect(result.valid).toBe(true);
    expect(result.missing).toHaveLength(0);
    expect(result.warnings.length).toBeGreaterThan(0);
  });

  it("should produce no warnings when all vars are set", async () => {
    process.env.PORT = "3000";
    process.env.API_KEY = "test-key";
    process.env.NODE_ENV = "production";
    process.env.DEMO_AUTOSTART = "false";
    process.env.BUILD_BRANCH = "main";
    process.env.BUILD_COMMIT = "abc123";
    process.env.BUILD_TIME = "2026-01-01";

    const { validateEnvironment } = await import("../core/env-validation");
    const result = validateEnvironment();

    expect(result.valid).toBe(true);
    expect(result.missing).toHaveLength(0);
    expect(result.warnings).toHaveLength(0);
  });

  it("should warn about API_KEY when not set", async () => {
    delete process.env.API_KEY;
    process.env.PORT = "5000";
    process.env.NODE_ENV = "production";

    const { validateEnvironment } = await import("../core/env-validation");
    const result = validateEnvironment();

    expect(result.valid).toBe(true);
    const apiKeyWarning = result.warnings.find((w) => w.includes("API_KEY"));
    expect(apiKeyWarning).toBeDefined();
  });

  it("should include default info in warnings", async () => {
    delete process.env.PORT;

    const { validateEnvironment } = await import("../core/env-validation");
    const result = validateEnvironment();

    const portWarning = result.warnings.find((w) => w.includes("PORT"));
    expect(portWarning).toContain("Default: 3000");
  });
});

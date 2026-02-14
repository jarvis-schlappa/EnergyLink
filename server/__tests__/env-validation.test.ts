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
    expect(result.messages.length).toBeGreaterThan(0);
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

  it("should include default info in messages for PORT", async () => {
    delete process.env.PORT;

    const { validateEnvironment } = await import("../core/env-validation");
    const result = validateEnvironment();

    const portMsg = result.messages.find((m) => m.message.includes("PORT"));
    expect(portMsg).toBeDefined();
    expect(portMsg!.message).toContain("Default: 3000");
  });

  it("should log PORT as info level, not warning", async () => {
    delete process.env.PORT;

    const { validateEnvironment } = await import("../core/env-validation");
    const result = validateEnvironment();

    const portMsg = result.messages.find((m) => m.message.includes("PORT"));
    expect(portMsg).toBeDefined();
    expect(portMsg!.level).toBe("info");
    // PORT should NOT appear in warnings array
    expect(result.warnings.find((w) => w.includes("PORT"))).toBeUndefined();
  });

  it("should log BUILD_* and DEMO_AUTOSTART as debug level", async () => {
    delete process.env.BUILD_BRANCH;
    delete process.env.BUILD_COMMIT;
    delete process.env.BUILD_TIME;
    delete process.env.DEMO_AUTOSTART;

    const { validateEnvironment } = await import("../core/env-validation");
    const result = validateEnvironment();

    const debugVars = ["BUILD_BRANCH", "BUILD_COMMIT", "BUILD_TIME", "DEMO_AUTOSTART"];
    for (const varName of debugVars) {
      const msg = result.messages.find((m) => m.message.includes(varName));
      expect(msg).toBeDefined();
      expect(msg!.level).toBe("debug");
    }
    // None should be in warnings
    for (const varName of debugVars) {
      expect(result.warnings.find((w) => w.includes(varName))).toBeUndefined();
    }
  });

  it("should keep API_KEY as warning level", async () => {
    delete process.env.API_KEY;

    const { validateEnvironment } = await import("../core/env-validation");
    const result = validateEnvironment();

    const apiMsg = result.messages.find((m) => m.message.includes("API_KEY"));
    expect(apiMsg).toBeDefined();
    expect(apiMsg!.level).toBe("warning");
    expect(result.warnings.find((w) => w.includes("API_KEY"))).toBeDefined();
  });
});

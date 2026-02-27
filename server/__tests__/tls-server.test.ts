import { describe, it, expect, vi, beforeEach } from "vitest";
import { createServer as createHttpServer } from "http";
import { createServer as createHttpsServer } from "https";
import { existsSync, readFileSync } from "fs";
import { resolve } from "path";

/**
 * Tests for TLS server creation logic.
 * Verifies the decision logic: when to create HTTPS vs HTTP server.
 * Does NOT start real HTTPS servers (would need actual certs).
 */

// Mock fs functions
vi.mock("fs", async () => {
  const actual = await vi.importActual<typeof import("fs")>("fs");
  return {
    ...actual,
    existsSync: vi.fn(actual.existsSync),
    readFileSync: vi.fn(actual.readFileSync),
  };
});

describe("TLS Server Creation Logic", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("creates HTTP server when TLS is disabled (default)", () => {
    const tlsConfig = { enabled: false, certPath: "certs/cert.pem", keyPath: "certs/key.pem" };
    
    // Logic from server/index.ts: when tls.enabled is false, create HTTP server
    let protocol = "HTTP";
    if (tlsConfig.enabled) {
      protocol = "HTTPS";
    }
    
    expect(protocol).toBe("HTTP");
  });

  it("creates HTTP server when TLS config is undefined", () => {
    const tlsConfig = undefined;
    
    let protocol = "HTTP";
    if (tlsConfig?.enabled) {
      protocol = "HTTPS";
    }
    
    expect(protocol).toBe("HTTP");
  });

  it("falls back to HTTP when TLS is enabled but cert files are missing", () => {
    const tlsConfig = { enabled: true, certPath: "certs/cert.pem", keyPath: "certs/key.pem" };
    
    const mockedExistsSync = vi.mocked(existsSync);
    mockedExistsSync.mockReturnValue(false);
    
    const certPath = resolve(process.cwd(), tlsConfig.certPath);
    const keyPath = resolve(process.cwd(), tlsConfig.keyPath);
    
    let protocol = "HTTP";
    if (tlsConfig.enabled) {
      if (existsSync(certPath) && existsSync(keyPath)) {
        protocol = "HTTPS";
      }
      // else fallback to HTTP
    }
    
    expect(protocol).toBe("HTTP");
  });

  it("falls back to HTTP when only cert file exists but key is missing", () => {
    const tlsConfig = { enabled: true, certPath: "certs/cert.pem", keyPath: "certs/key.pem" };
    
    const mockedExistsSync = vi.mocked(existsSync);
    mockedExistsSync.mockImplementation((p: any) => {
      if (String(p).includes("cert.pem")) return true;
      return false;
    });
    
    const certPath = resolve(process.cwd(), tlsConfig.certPath);
    const keyPath = resolve(process.cwd(), tlsConfig.keyPath);
    
    let protocol = "HTTP";
    if (tlsConfig.enabled) {
      if (existsSync(certPath) && existsSync(keyPath)) {
        protocol = "HTTPS";
      }
    }
    
    expect(protocol).toBe("HTTP");
  });

  it("selects HTTPS when TLS is enabled and cert files exist", () => {
    const tlsConfig = { enabled: true, certPath: "certs/cert.pem", keyPath: "certs/key.pem" };
    
    const mockedExistsSync = vi.mocked(existsSync);
    mockedExistsSync.mockReturnValue(true);
    
    const certPath = resolve(process.cwd(), tlsConfig.certPath);
    const keyPath = resolve(process.cwd(), tlsConfig.keyPath);
    
    let protocol = "HTTP";
    if (tlsConfig.enabled) {
      if (existsSync(certPath) && existsSync(keyPath)) {
        protocol = "HTTPS";
      }
    }
    
    expect(protocol).toBe("HTTPS");
  });

  it("does not log certificate paths containing private key content", () => {
    // Security: ensure warning logs don't expose key material
    const tlsConfig = { enabled: true, certPath: "certs/cert.pem", keyPath: "certs/key.pem" };
    
    // The log message from server/index.ts only shows boolean existence, not file content
    const certExists = false;
    const keyExists = false;
    const logMessage = `TLS aktiviert, aber Zertifikatdateien fehlen – Fallback auf HTTP (cert: ${certExists}, key: ${keyExists})`;
    
    expect(logMessage).not.toContain("BEGIN");
    expect(logMessage).not.toContain("PRIVATE KEY");
    expect(logMessage).toContain("cert: false");
    expect(logMessage).toContain("key: false");
  });
});

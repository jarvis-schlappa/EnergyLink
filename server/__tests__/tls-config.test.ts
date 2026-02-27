import { describe, it, expect } from "vitest";
import { tlsConfigSchema, settingsSchema } from "@shared/schema";

describe("TLS Config Schema", () => {
  describe("tlsConfigSchema", () => {
    it("accepts valid TLS config", () => {
      const valid = {
        enabled: true,
        certPath: "certs/cert.pem",
        keyPath: "certs/key.pem",
      };
      const result = tlsConfigSchema.safeParse(valid);
      expect(result.success).toBe(true);
    });

    it("accepts disabled TLS config", () => {
      const valid = {
        enabled: false,
        certPath: "certs/cert.pem",
        keyPath: "certs/key.pem",
      };
      const result = tlsConfigSchema.safeParse(valid);
      expect(result.success).toBe(true);
    });

    it("rejects missing enabled field", () => {
      const invalid = {
        certPath: "certs/cert.pem",
        keyPath: "certs/key.pem",
      };
      const result = tlsConfigSchema.safeParse(invalid);
      expect(result.success).toBe(false);
    });

    it("rejects missing certPath", () => {
      const invalid = {
        enabled: true,
        keyPath: "certs/key.pem",
      };
      const result = tlsConfigSchema.safeParse(invalid);
      expect(result.success).toBe(false);
    });

    it("rejects missing keyPath", () => {
      const invalid = {
        enabled: true,
        certPath: "certs/cert.pem",
      };
      const result = tlsConfigSchema.safeParse(invalid);
      expect(result.success).toBe(false);
    });

    it("rejects non-boolean enabled", () => {
      const invalid = {
        enabled: "yes",
        certPath: "certs/cert.pem",
        keyPath: "certs/key.pem",
      };
      const result = tlsConfigSchema.safeParse(invalid);
      expect(result.success).toBe(false);
    });
  });

  describe("settingsSchema with tls", () => {
    it("accepts settings without tls (optional)", () => {
      const settings = {
        wallboxIp: "192.168.1.100",
      };
      const result = settingsSchema.safeParse(settings);
      expect(result.success).toBe(true);
      expect(result.data?.tls).toBeUndefined();
    });

    it("accepts settings with valid tls config", () => {
      const settings = {
        wallboxIp: "192.168.1.100",
        tls: {
          enabled: true,
          certPath: "/etc/ssl/cert.pem",
          keyPath: "/etc/ssl/key.pem",
        },
      };
      const result = settingsSchema.safeParse(settings);
      expect(result.success).toBe(true);
      expect(result.data?.tls?.enabled).toBe(true);
    });

    it("rejects settings with invalid tls config", () => {
      const settings = {
        wallboxIp: "192.168.1.100",
        tls: {
          enabled: true,
          // missing certPath and keyPath
        },
      };
      const result = settingsSchema.safeParse(settings);
      expect(result.success).toBe(false);
    });
  });
});

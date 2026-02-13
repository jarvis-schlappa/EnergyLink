import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  extractDeviceNameFromUrl,
  extractBaseUrlFromUrl,
  isSmartHomeUrlAllowed,
} from "../routes/helpers";

describe("extractDeviceNameFromUrl", () => {
  it("returns null for undefined", () => {
    expect(extractDeviceNameFromUrl(undefined)).toBeNull();
  });

  it("returns null for empty string", () => {
    expect(extractDeviceNameFromUrl("")).toBeNull();
  });

  it("extracts device name from detail= parameter", () => {
    expect(
      extractDeviceNameFromUrl("http://fhem:8083/fhem?detail=myDevice&foo=bar"),
    ).toBe("myDevice");
  });

  it("extracts device name from cmd.DEVICE= format", () => {
    expect(
      extractDeviceNameFromUrl("http://fhem:8083/fhem?cmd.mySwitch=set%20on"),
    ).toBe("mySwitch");
  });

  it("extracts device name from URL-encoded set%20DEVICE%20 format", () => {
    expect(
      extractDeviceNameFromUrl(
        "http://fhem:8083/fhem?cmd=set%20wallbox%20on",
      ),
    ).toBe("wallbox");
  });

  it("extracts device name from decoded set DEVICE format", () => {
    expect(
      extractDeviceNameFromUrl("http://fhem:8083/fhem?cmd=set myRelay on"),
    ).toBe("myRelay");
  });

  it("returns null when no pattern matches", () => {
    expect(extractDeviceNameFromUrl("http://fhem:8083/fhem")).toBeNull();
  });
});

describe("extractBaseUrlFromUrl", () => {
  it("returns null for undefined", () => {
    expect(extractBaseUrlFromUrl(undefined)).toBeNull();
  });

  it("returns null for empty string", () => {
    expect(extractBaseUrlFromUrl("")).toBeNull();
  });

  it("strips query parameters", () => {
    expect(extractBaseUrlFromUrl("http://fhem:8083/fhem?cmd=list")).toBe(
      "http://fhem:8083/fhem",
    );
  });

  it("returns full URL when no query params", () => {
    expect(extractBaseUrlFromUrl("https://example.com/api/v1")).toBe(
      "https://example.com/api/v1",
    );
  });

  it("returns null for non-http URLs", () => {
    expect(extractBaseUrlFromUrl("ftp://server/file")).toBeNull();
  });
});

describe("isSmartHomeUrlAllowed", () => {
  const originalEnv = process.env.ALLOWED_SMARTHOME_ORIGINS;

  afterEach(() => {
    if (originalEnv === undefined) {
      delete process.env.ALLOWED_SMARTHOME_ORIGINS;
    } else {
      process.env.ALLOWED_SMARTHOME_ORIGINS = originalEnv;
    }
  });

  it("allows valid http URLs", () => {
    expect(isSmartHomeUrlAllowed("http://192.168.40.11:8083/fhem?cmd=list")).toBe(true);
  });

  it("allows valid https URLs", () => {
    expect(isSmartHomeUrlAllowed("https://smarthome.example.com/api")).toBe(true);
  });

  it("rejects non-http schemes", () => {
    expect(isSmartHomeUrlAllowed("file:///etc/passwd")).toBe(false);
    expect(isSmartHomeUrlAllowed("ftp://internal/data")).toBe(false);
    expect(isSmartHomeUrlAllowed("gopher://evil.com")).toBe(false);
  });

  it("rejects invalid URLs", () => {
    expect(isSmartHomeUrlAllowed("not-a-url")).toBe(false);
    expect(isSmartHomeUrlAllowed("")).toBe(false);
  });

  it("blocks link-local / metadata addresses (169.254.x.x)", () => {
    expect(isSmartHomeUrlAllowed("http://169.254.169.254/latest/meta-data")).toBe(false);
    expect(isSmartHomeUrlAllowed("http://169.254.0.1/secret")).toBe(false);
  });

  it("blocks 0.0.0.0", () => {
    expect(isSmartHomeUrlAllowed("http://0.0.0.0:8080/admin")).toBe(false);
  });

  it("allows private IPs when no allowlist is set (FHEM use case)", () => {
    delete process.env.ALLOWED_SMARTHOME_ORIGINS;
    expect(isSmartHomeUrlAllowed("http://192.168.40.11:8083/fhem?cmd=list")).toBe(true);
    expect(isSmartHomeUrlAllowed("http://10.0.0.1:8083/fhem")).toBe(true);
    expect(isSmartHomeUrlAllowed("http://127.0.0.1:8083/fhem")).toBe(true);
  });

  describe("with ALLOWED_SMARTHOME_ORIGINS", () => {
    beforeEach(() => {
      process.env.ALLOWED_SMARTHOME_ORIGINS = "http://192.168.40.11:8083,http://192.168.40.11:8084";
    });

    it("allows URLs matching an allowed origin", () => {
      expect(isSmartHomeUrlAllowed("http://192.168.40.11:8083/fhem?cmd=list")).toBe(true);
      expect(isSmartHomeUrlAllowed("http://192.168.40.11:8084/fhem?detail=S10")).toBe(true);
    });

    it("rejects URLs not matching any allowed origin", () => {
      expect(isSmartHomeUrlAllowed("http://evil.com:8083/fhem?cmd=list")).toBe(false);
      expect(isSmartHomeUrlAllowed("http://192.168.40.11:9999/other")).toBe(false);
      expect(isSmartHomeUrlAllowed("http://127.0.0.1:8083/fhem")).toBe(false);
    });
  });
});

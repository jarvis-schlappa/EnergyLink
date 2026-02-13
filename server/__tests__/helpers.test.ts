import { describe, it, expect } from "vitest";
import {
  extractDeviceNameFromUrl,
  extractBaseUrlFromUrl,
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

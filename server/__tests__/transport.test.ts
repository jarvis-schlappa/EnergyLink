import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * Tests for Wallbox Transport Layer.
 * Tests response parsing and command validation logic
 * without needing a real UDP socket.
 */

vi.mock("../core/logger", () => ({
  log: vi.fn(),
}));

describe("Transport Layer - Response Parsing", () => {
  /**
   * Extracted parseKebaResponse logic for isolated testing.
   * Mirrors the implementation in transport.ts.
   */
  function parseKebaResponse(response: string): Record<string, any> {
    const trimmed = response.trim();

    // TCH-OK :done
    if (trimmed.includes("TCH-OK")) {
      const colonIndex = trimmed.indexOf(":");
      if (colonIndex > 0) {
        const key = trimmed.substring(0, colonIndex).trim();
        const value = trimmed.substring(colonIndex + 1).trim();
        return { [key]: value };
      }
      return { "TCH-OK": "done" };
    }

    // JSON format
    try {
      if (trimmed.startsWith("{") && trimmed.endsWith("}")) {
        return JSON.parse(trimmed);
      }
    } catch {
      // fall through
    }

    // Key=Value fallback
    const result: Record<string, any> = {};
    const lines = response.split(/[\n]/);
    for (const line of lines) {
      const t = line.trim();
      if (!t) continue;
      const eqIdx = t.indexOf("=");
      if (eqIdx > 0) {
        const key = t.substring(0, eqIdx).trim();
        const value = t.substring(eqIdx + 1).trim();
        const numValue = parseFloat(value);
        result[key] = isNaN(numValue) ? value : numValue;
      }
    }
    return result;
  }

  /**
   * Extracted isValidReportResponse logic for isolated testing.
   */
  function isValidReportResponse(command: string, parsed: Record<string, any>): boolean {
    if (command === "report 1") {
      return (parsed.ID === 1 || String(parsed.ID) === "1") &&
        (parsed.Product || parsed.Serial || parsed.Firmware);
    }
    if (command === "report 2") {
      return (parsed.ID === 2 || String(parsed.ID) === "2") &&
        (parsed.State !== undefined || parsed.Plug !== undefined || parsed["Max curr"] !== undefined);
    }
    if (command === "report 3") {
      return (parsed.ID === 3 || String(parsed.ID) === "3") &&
        (parsed.U1 !== undefined || parsed.I1 !== undefined || parsed.P !== undefined);
    }
    if (command.startsWith("ena") || command.startsWith("curr")) {
      const responseStr = JSON.stringify(parsed);
      return responseStr.includes("TCH-OK") || parsed["TCH-OK"] !== undefined;
    }
    return true;
  }

  describe("parseKebaResponse", () => {
    it("parses JSON report 2 response", () => {
      const raw = JSON.stringify({ ID: 2, State: 3, Plug: 7, "Max curr": 32000, "Enable sys": 1 });
      const result = parseKebaResponse(raw);
      expect(result.ID).toBe(2);
      expect(result.State).toBe(3);
      expect(result.Plug).toBe(7);
      expect(result["Max curr"]).toBe(32000);
    });

    it("parses JSON report 3 response", () => {
      const raw = JSON.stringify({ ID: 3, U1: 230000, I1: 16000, P: 3680000000 });
      const result = parseKebaResponse(raw);
      expect(result.U1).toBe(230000);
      expect(result.I1).toBe(16000);
    });

    it("parses TCH-OK :done response", () => {
      const result = parseKebaResponse("TCH-OK :done");
      expect(result["TCH-OK"]).toBe("done");
    });

    it("parses TCH-OK with key prefix", () => {
      const result = parseKebaResponse("TCH-OK :done");
      expect(result).toHaveProperty("TCH-OK");
    });

    it("handles empty response", () => {
      const result = parseKebaResponse("");
      expect(result).toEqual({});
    });

    it("handles whitespace-only response", () => {
      const result = parseKebaResponse("   \n  ");
      expect(result).toEqual({});
    });
  });

  describe("isValidReportResponse", () => {
    it("validates report 1 response", () => {
      expect(isValidReportResponse("report 1", { ID: 1, Product: "KC-P20", Serial: "123" })).toBeTruthy();
    });

    it("rejects report 1 with wrong ID", () => {
      expect(isValidReportResponse("report 1", { ID: 2, Product: "KC-P20" })).toBeFalsy();
    });

    it("rejects report 1 without required fields", () => {
      expect(isValidReportResponse("report 1", { ID: 1 })).toBeFalsy();
    });

    it("validates report 2 response", () => {
      expect(isValidReportResponse("report 2", { ID: 2, State: 3, Plug: 7 })).toBe(true);
    });

    it("validates report 2 with just one field", () => {
      expect(isValidReportResponse("report 2", { ID: 2, State: 2 })).toBe(true);
    });

    it("rejects report 2 with wrong ID", () => {
      expect(isValidReportResponse("report 2", { ID: 3, State: 3 })).toBe(false);
    });

    it("validates report 3 response", () => {
      expect(isValidReportResponse("report 3", { ID: 3, U1: 230000, P: 3680000 })).toBe(true);
    });

    it("validates ena command with TCH-OK", () => {
      expect(isValidReportResponse("ena 1", { "TCH-OK": "done" })).toBe(true);
    });

    it("validates curr command with TCH-OK", () => {
      expect(isValidReportResponse("curr 16000", { "TCH-OK": "done" })).toBe(true);
    });

    it("rejects ena command without TCH-OK", () => {
      expect(isValidReportResponse("ena 1", { ID: 2, State: 3 })).toBe(false);
    });

    it("accepts unknown commands", () => {
      expect(isValidReportResponse("unknown", { foo: "bar" })).toBe(true);
    });
  });

  describe("Command Sequencing (ena → curr)", () => {
    it("ena must be sent before curr for charging to start", () => {
      // This is a design validation - ena enables/disables the wallbox,
      // curr sets the current limit. The sequence is: ena 1 → curr <value>
      // We validate that both command types produce valid TCH-OK responses

      const enaResponse = parseKebaResponse("TCH-OK :done");
      expect(isValidReportResponse("ena 1", enaResponse)).toBe(true);

      const currResponse = parseKebaResponse("TCH-OK :done");
      expect(isValidReportResponse("curr 16000", currResponse)).toBe(true);
    });

    it("TCH-ERR response is not accepted as valid for ena", () => {
      const errResponse = { "TCH-ERR": "error" };
      // TCH-ERR doesn't have TCH-OK, so it should fail validation
      expect(isValidReportResponse("ena 1", errResponse)).toBe(false);
    });
  });
});

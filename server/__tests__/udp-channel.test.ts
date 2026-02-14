import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * Tests for WallboxUdpChannel message routing logic.
 * Tests the classification of messages into broadcast vs command events
 * without needing a real UDP socket.
 */

// Mock logger
vi.mock("../core/logger", () => ({
  log: vi.fn(),
}));

describe("UDP Channel Message Routing", () => {
  /**
   * Simulates the message classification logic from WallboxUdpChannel.
   * Extracted here so we can test it without binding a real socket.
   */
  function classifyMessage(raw: string): {
    isJson: boolean;
    hasId: boolean;
    hasTchToken: boolean;
    parsed: any | null;
    shouldEmitBroadcast: boolean;
    shouldEmitCommand: boolean;
  } {
    let parsed: any | null = null;
    let isJson = false;
    let hasId = false;
    let hasTchToken = false;

    if (raw.startsWith("{")) {
      try {
        parsed = JSON.parse(raw);
        isJson = true;
        hasId = parsed.ID !== undefined;
        hasTchToken =
          parsed["TCH-OK"] !== undefined || parsed["TCH-ERR"] !== undefined;
      } catch {
        // not valid JSON
      }
    }

    // Mirrors the routing logic in udp-channel.ts
    const shouldEmitBroadcast = isJson;
    const shouldEmitCommand = !isJson || hasTchToken;

    return { isJson, hasId, hasTchToken, parsed, shouldEmitBroadcast, shouldEmitCommand };
  }

  describe("Report responses (have ID field)", () => {
    it("classifies report 2 response as broadcast (has ID)", () => {
      const raw = JSON.stringify({ ID: 2, State: 3, Plug: 7, "Max curr": 32000 });
      const result = classifyMessage(raw);
      expect(result.isJson).toBe(true);
      expect(result.hasId).toBe(true);
      expect(result.hasTchToken).toBe(false);
      expect(result.shouldEmitBroadcast).toBe(true);
    });

    it("classifies report 1 response correctly", () => {
      const raw = JSON.stringify({ ID: 1, Product: "KC-P20", Serial: "16314582" });
      const result = classifyMessage(raw);
      expect(result.hasId).toBe(true);
      expect(result.shouldEmitBroadcast).toBe(true);
    });
  });

  describe("Spontaneous broadcasts (no ID field)", () => {
    it("classifies Input broadcast as broadcast event", () => {
      const raw = JSON.stringify({ Input: 1 });
      const result = classifyMessage(raw);
      expect(result.isJson).toBe(true);
      expect(result.hasId).toBe(false);
      expect(result.shouldEmitBroadcast).toBe(true);
      // Also emitted as command since no TCH token but still JSON
      // Actually: shouldEmitCommand = !isJson || hasTchToken = false || false = false
      expect(result.shouldEmitCommand).toBe(false);
    });

    it("classifies Plug broadcast correctly", () => {
      const raw = JSON.stringify({ Plug: 7 });
      const result = classifyMessage(raw);
      expect(result.hasId).toBe(false);
      expect(result.shouldEmitBroadcast).toBe(true);
    });

    it("classifies E pres broadcast correctly", () => {
      const raw = JSON.stringify({ "E pres": 12345 });
      const result = classifyMessage(raw);
      expect(result.hasId).toBe(false);
      expect(result.shouldEmitBroadcast).toBe(true);
    });

    it("classifies State broadcast correctly", () => {
      const raw = JSON.stringify({ State: 3 });
      const result = classifyMessage(raw);
      expect(result.hasId).toBe(false);
      expect(result.shouldEmitBroadcast).toBe(true);
    });
  });

  describe("TCH-OK/TCH-ERR responses", () => {
    it("classifies TCH-OK as both broadcast and command", () => {
      const raw = JSON.stringify({ "TCH-OK": "done" });
      const result = classifyMessage(raw);
      expect(result.hasTchToken).toBe(true);
      expect(result.shouldEmitBroadcast).toBe(true);
      expect(result.shouldEmitCommand).toBe(true);
    });

    it("classifies TCH-ERR as both broadcast and command", () => {
      const raw = JSON.stringify({ "TCH-ERR": "error" });
      const result = classifyMessage(raw);
      expect(result.hasTchToken).toBe(true);
      expect(result.shouldEmitBroadcast).toBe(true);
      expect(result.shouldEmitCommand).toBe(true);
    });
  });

  describe("Invalid / malformed messages", () => {
    it("handles invalid JSON starting with {", () => {
      const raw = "{not valid json";
      const result = classifyMessage(raw);
      expect(result.isJson).toBe(false);
      expect(result.parsed).toBeNull();
      expect(result.shouldEmitBroadcast).toBe(false);
      expect(result.shouldEmitCommand).toBe(true);
    });

    it("handles non-JSON text", () => {
      const raw = "some random text";
      const result = classifyMessage(raw);
      expect(result.isJson).toBe(false);
      expect(result.shouldEmitBroadcast).toBe(false);
      expect(result.shouldEmitCommand).toBe(true);
    });

    it("handles empty string", () => {
      const raw = "";
      const result = classifyMessage(raw);
      expect(result.isJson).toBe(false);
      expect(result.shouldEmitCommand).toBe(true);
    });

    it("handles truncated JSON", () => {
      const raw = '{"Input": ';
      const result = classifyMessage(raw);
      expect(result.isJson).toBe(false);
      expect(result.parsed).toBeNull();
    });
  });

  describe("Broadcast vs Report distinction", () => {
    it("report responses have ID, spontaneous broadcasts do not", () => {
      const report = classifyMessage(JSON.stringify({ ID: 2, State: 3, Plug: 7 }));
      const broadcast = classifyMessage(JSON.stringify({ State: 3 }));

      expect(report.hasId).toBe(true);
      expect(broadcast.hasId).toBe(false);

      // Both are emitted as broadcast events
      expect(report.shouldEmitBroadcast).toBe(true);
      expect(broadcast.shouldEmitBroadcast).toBe(true);
    });
  });
});

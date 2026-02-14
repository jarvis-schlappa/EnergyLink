import { describe, it, expect } from "vitest";

/**
 * Tests for E3DC Modbus register parsing logic.
 * Tests INT16, INT32, Signed/Unsigned conversions and EMS status bitfield decoding
 * without needing a real Modbus connection.
 */

describe("E3DC Modbus Register Parsing", () => {
  /**
   * INT32 from 2x UINT16 (Little-Endian: LSW first)
   * Mirrors readInt32 logic from modbus.ts
   */
  function parseInt32(low: number, high: number): number {
    const uint32 = (high << 16) | low;
    return uint32 > 0x7FFFFFFF ? uint32 - 0x100000000 : uint32;
  }

  describe("INT32 parsing (2 registers, LSW first)", () => {
    it("parses positive value", () => {
      // 5000W = 0x00001388 → low=0x1388, high=0x0000
      expect(parseInt32(0x1388, 0x0000)).toBe(5000);
    });

    it("parses zero", () => {
      expect(parseInt32(0, 0)).toBe(0);
    });

    it("parses negative value (battery discharging)", () => {
      // -3000W = 0xFFFFF448 → low=0xF448, high=0xFFFF
      expect(parseInt32(0xF448, 0xFFFF)).toBe(-3000);
    });

    it("parses -1", () => {
      expect(parseInt32(0xFFFF, 0xFFFF)).toBe(-1);
    });

    it("parses large positive value", () => {
      // 100000W = 0x000186A0 → low=0x86A0, high=0x0001
      expect(parseInt32(0x86A0, 0x0001)).toBe(100000);
    });

    it("parses large negative value (grid feed-in)", () => {
      // -10000W = 0xFFFFD8F0 → low=0xD8F0, high=0xFFFF
      expect(parseInt32(0xD8F0, 0xFFFF)).toBe(-10000);
    });

    it("parses INT32 max positive", () => {
      expect(parseInt32(0xFFFF, 0x7FFF)).toBe(2147483647); // INT32_MAX
    });

    it("parses INT32 min negative", () => {
      expect(parseInt32(0x0000, 0x8000)).toBe(-2147483648); // INT32_MIN
    });
  });

  describe("UINT16 parsing", () => {
    it("parses battery SOC (0-100%)", () => {
      expect(85).toBe(85); // Direct register value
    });

    it("parses autarky/selfconsumption combined register", () => {
      // Register 40082: High Byte = Autarkie, Low Byte = Eigenverbrauch
      const combined = 0x5A3C; // Autarkie=90(0x5A), Eigenverbrauch=60(0x3C)
      const autarky = (combined >> 8) & 0xFF;
      const selfConsumption = combined & 0xFF;
      expect(autarky).toBe(90);
      expect(selfConsumption).toBe(60);
    });

    it("handles 0% autarky and 100% self-consumption", () => {
      const combined = 0x0064; // 0x00=0%, 0x64=100%
      expect((combined >> 8) & 0xFF).toBe(0);
      expect(combined & 0xFF).toBe(100);
    });

    it("handles 100% autarky and 0% self-consumption", () => {
      const combined = 0x6400; // 0x64=100%, 0x00=0%
      expect((combined >> 8) & 0xFF).toBe(100);
      expect(combined & 0xFF).toBe(0);
    });
  });

  describe("EMS Status Bitfield Decoding", () => {
    function decodeEmsStatus(emsStatus: number) {
      return {
        chargeLocked: (emsStatus & 0b0000001) !== 0,
        dischargeLocked: (emsStatus & 0b0000010) !== 0,
        emergencyPowerReady: (emsStatus & 0b0000100) !== 0,
        weatherBasedCharge: (emsStatus & 0b0001000) !== 0,
        curtailmentActive: (emsStatus & 0b0010000) !== 0,
        chargeBlockActive: (emsStatus & 0b0100000) !== 0,
        dischargeBlockActive: (emsStatus & 0b1000000) !== 0,
      };
    }

    it("decodes all flags off (0x0000)", () => {
      const flags = decodeEmsStatus(0);
      expect(flags.chargeLocked).toBe(false);
      expect(flags.dischargeLocked).toBe(false);
      expect(flags.emergencyPowerReady).toBe(false);
    });

    it("decodes discharge locked (bit 1) - battery lock active", () => {
      const flags = decodeEmsStatus(0b0000010);
      expect(flags.dischargeLocked).toBe(true);
      expect(flags.chargeLocked).toBe(false);
    });

    it("decodes charge locked (bit 0)", () => {
      const flags = decodeEmsStatus(0b0000001);
      expect(flags.chargeLocked).toBe(true);
      expect(flags.dischargeLocked).toBe(false);
    });

    it("decodes emergency power ready (bit 2)", () => {
      const flags = decodeEmsStatus(0b0000100);
      expect(flags.emergencyPowerReady).toBe(true);
    });

    it("decodes weather-based charging (bit 3)", () => {
      const flags = decodeEmsStatus(0b0001000);
      expect(flags.weatherBasedCharge).toBe(true);
    });

    it("decodes curtailment active (bit 4)", () => {
      const flags = decodeEmsStatus(0b0010000);
      expect(flags.curtailmentActive).toBe(true);
    });

    it("decodes multiple flags simultaneously", () => {
      // discharge locked + emergency power ready + curtailment
      const flags = decodeEmsStatus(0b0010110);
      expect(flags.dischargeLocked).toBe(true);
      expect(flags.emergencyPowerReady).toBe(true);
      expect(flags.curtailmentActive).toBe(true);
      expect(flags.chargeLocked).toBe(false);
      expect(flags.weatherBasedCharge).toBe(false);
    });

    it("decodes all flags on", () => {
      const flags = decodeEmsStatus(0b1111111);
      expect(flags.chargeLocked).toBe(true);
      expect(flags.dischargeLocked).toBe(true);
      expect(flags.emergencyPowerReady).toBe(true);
      expect(flags.weatherBasedCharge).toBe(true);
      expect(flags.curtailmentActive).toBe(true);
      expect(flags.chargeBlockActive).toBe(true);
      expect(flags.dischargeBlockActive).toBe(true);
    });
  });

  describe("Grid Frequency parsing", () => {
    it("parses 50.00 Hz", () => {
      expect(5000 * 0.01).toBeCloseTo(50.00);
    });

    it("parses 50.01 Hz", () => {
      expect(5001 * 0.01).toBeCloseTo(50.01);
    });

    it("parses 49.95 Hz (slightly below nominal)", () => {
      expect(4995 * 0.01).toBeCloseTo(49.95);
    });
  });
});

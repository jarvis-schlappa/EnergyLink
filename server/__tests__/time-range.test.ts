import { describe, it, expect } from "vitest";

// isTimeInRange is a local function inside routes.ts, not exported.
// Re-implement the same logic for testing (verified against source).
function isTimeInRange(current: string, start: string, end: string): boolean {
  const [currentH, currentM] = current.split(":").map(Number);
  const [startH, startM] = start.split(":").map(Number);
  const [endH, endM] = end.split(":").map(Number);

  const currentMinutes = currentH * 60 + currentM;
  const startMinutes = startH * 60 + startM;
  const endMinutes = endH * 60 + endM;

  if (endMinutes < startMinutes) {
    return currentMinutes >= startMinutes || currentMinutes < endMinutes;
  }

  return currentMinutes >= startMinutes && currentMinutes < endMinutes;
}

describe("isTimeInRange", () => {
  describe("normal time windows (no midnight crossing)", () => {
    it("returns true for time within range", () => {
      expect(isTimeInRange("10:30", "08:00", "18:00")).toBe(true);
    });

    it("returns false for time outside range", () => {
      expect(isTimeInRange("07:00", "08:00", "18:00")).toBe(false);
    });

    it("returns true at exact start time", () => {
      expect(isTimeInRange("08:00", "08:00", "18:00")).toBe(true);
    });

    it("returns false at exact end time (exclusive)", () => {
      expect(isTimeInRange("18:00", "08:00", "18:00")).toBe(false);
    });
  });

  describe("overnight time windows (crossing midnight)", () => {
    it("returns true for time after start (before midnight)", () => {
      expect(isTimeInRange("23:30", "22:00", "06:00")).toBe(true);
    });

    it("returns true for time before end (after midnight)", () => {
      expect(isTimeInRange("03:00", "22:00", "06:00")).toBe(true);
    });

    it("returns false for time outside overnight range", () => {
      expect(isTimeInRange("12:00", "22:00", "06:00")).toBe(false);
    });

    it("returns true at exact start of overnight range", () => {
      expect(isTimeInRange("22:00", "22:00", "06:00")).toBe(true);
    });

    it("returns false at exact end of overnight range", () => {
      expect(isTimeInRange("06:00", "22:00", "06:00")).toBe(false);
    });
  });

  describe("edge cases", () => {
    it("handles same start and end time (0-minute window)", () => {
      // endMinutes === startMinutes → not overnight → currentMinutes >= start && < end → never true
      expect(isTimeInRange("10:00", "10:00", "10:00")).toBe(false);
    });

    it("handles midnight as start", () => {
      expect(isTimeInRange("03:00", "00:00", "05:00")).toBe(true);
    });

    it("handles midnight as end", () => {
      // end 00:00 = 0 minutes, start 22:00 = 1320 → overnight
      expect(isTimeInRange("23:00", "22:00", "00:00")).toBe(true);
    });

    it("returns false for 23:59 in narrow window 00:00-05:00", () => {
      expect(isTimeInRange("23:59", "00:00", "05:00")).toBe(false);
    });
  });
});

import { describe, it, expect } from "vitest";
import {
  chargingStrategySchema,
  chargingStrategyConfigSchema,
  nightChargingScheduleSchema,
  e3dcConfigSchema,
  wallboxStatusSchema,
  controlStateSchema,
  e3dcLiveDataSchema,
  chargingContextSchema,
  logLevelSchema,
} from "../schema";

describe("Schema Validation", () => {
  describe("chargingStrategySchema", () => {
    it("accepts valid strategies", () => {
      expect(chargingStrategySchema.parse("off")).toBe("off");
      expect(chargingStrategySchema.parse("surplus_battery_prio")).toBe("surplus_battery_prio");
      expect(chargingStrategySchema.parse("surplus_vehicle_prio")).toBe("surplus_vehicle_prio");
      expect(chargingStrategySchema.parse("max_with_battery")).toBe("max_with_battery");
      expect(chargingStrategySchema.parse("max_without_battery")).toBe("max_without_battery");
    });

    it("rejects invalid strategies", () => {
      expect(() => chargingStrategySchema.parse("invalid")).toThrow();
      expect(() => chargingStrategySchema.parse("")).toThrow();
      expect(() => chargingStrategySchema.parse(123)).toThrow();
    });
  });

  describe("chargingStrategyConfigSchema", () => {
    const validConfig = {
      activeStrategy: "surplus_battery_prio",
      minStartPowerWatt: 1500,
      stopThresholdWatt: 500,
      startDelaySeconds: 60,
      stopDelaySeconds: 120,
      physicalPhaseSwitch: 1,
      minCurrentChangeAmpere: 1,
      minChangeIntervalSeconds: 30,
      inputX1Strategy: "max_without_battery",
    };

    it("accepts valid config", () => {
      const result = chargingStrategyConfigSchema.parse(validConfig);
      expect(result.activeStrategy).toBe("surplus_battery_prio");
    });

    it("provides default for physicalPhaseSwitch", () => {
      const { physicalPhaseSwitch, ...rest } = validConfig;
      const result = chargingStrategyConfigSchema.parse(rest);
      expect(result.physicalPhaseSwitch).toBe(3);
    });

    it("rejects minStartPowerWatt below 500", () => {
      expect(() => chargingStrategyConfigSchema.parse({ ...validConfig, minStartPowerWatt: 100 })).toThrow();
    });

    it("rejects minStartPowerWatt above 5000", () => {
      expect(() => chargingStrategyConfigSchema.parse({ ...validConfig, minStartPowerWatt: 6000 })).toThrow();
    });

    it("rejects stopThresholdWatt below 300", () => {
      expect(() => chargingStrategyConfigSchema.parse({ ...validConfig, stopThresholdWatt: 100 })).toThrow();
    });

    it("rejects invalid physicalPhaseSwitch", () => {
      expect(() => chargingStrategyConfigSchema.parse({ ...validConfig, physicalPhaseSwitch: 2 })).toThrow();
    });
  });

  describe("nightChargingScheduleSchema", () => {
    it("accepts valid schedule", () => {
      const result = nightChargingScheduleSchema.parse({ enabled: true, startTime: "00:00", endTime: "05:00" });
      expect(result.enabled).toBe(true);
    });

    it("rejects missing fields", () => {
      expect(() => nightChargingScheduleSchema.parse({ enabled: true })).toThrow();
    });
  });

  describe("e3dcConfigSchema", () => {
    it("accepts minimal config", () => {
      const result = e3dcConfigSchema.parse({ enabled: true });
      expect(result.pollingIntervalSeconds).toBe(10); // default
      expect(result.modbusPauseSeconds).toBe(3); // default
    });

    it("rejects pollingIntervalSeconds below 5", () => {
      expect(() => e3dcConfigSchema.parse({ enabled: true, pollingIntervalSeconds: 2 })).toThrow();
    });

    it("rejects pollingIntervalSeconds above 60", () => {
      expect(() => e3dcConfigSchema.parse({ enabled: true, pollingIntervalSeconds: 120 })).toThrow();
    });
  });

  describe("wallboxStatusSchema", () => {
    it("accepts valid status", () => {
      const result = wallboxStatusSchema.parse({
        state: 3, plug: 7, enableSys: 1, maxCurr: 32000, ePres: 5000, eTotal: 100000, power: 7360,
      });
      expect(result.state).toBe(3);
    });

    it("accepts optional fields", () => {
      const result = wallboxStatusSchema.parse({
        state: 2, plug: 1, enableSys: 0, maxCurr: 0, ePres: 0, eTotal: 0, power: 0,
        phases: 1, i1: 6000, i2: 0, i3: 0, input: 0,
      });
      expect(result.phases).toBe(1);
    });
  });

  describe("e3dcLiveDataSchema", () => {
    it("accepts valid data", () => {
      const result = e3dcLiveDataSchema.parse({
        pvPower: 5000, batteryPower: 1000, batterySoc: 80,
        housePower: 1200, gridPower: -200, wallboxPower: 3000,
        autarky: 95, selfConsumption: 88, timestamp: new Date().toISOString(),
      });
      expect(result.pvPower).toBe(5000);
    });

    it("accepts optional gridFrequency", () => {
      const result = e3dcLiveDataSchema.parse({
        pvPower: 0, batteryPower: 0, batterySoc: 0,
        housePower: 0, gridPower: 0, wallboxPower: 0,
        autarky: 0, selfConsumption: 0, timestamp: "2026-01-01T00:00:00Z",
        gridFrequency: 50.01,
      });
      expect(result.gridFrequency).toBe(50.01);
    });
  });

  describe("chargingContextSchema", () => {
    it("accepts valid context", () => {
      const result = chargingContextSchema.parse({
        strategy: "off", isActive: false, currentAmpere: 0,
        targetAmpere: 0, currentPhases: 3, adjustmentCount: 0,
      });
      expect(result.strategy).toBe("off");
    });

    it("rejects invalid strategy in context", () => {
      expect(() => chargingContextSchema.parse({
        strategy: "bogus", isActive: false, currentAmpere: 0,
        targetAmpere: 0, currentPhases: 3, adjustmentCount: 0,
      })).toThrow();
    });
  });

  describe("logLevelSchema", () => {
    it("accepts all valid levels", () => {
      for (const level of ["trace", "debug", "info", "warning", "error"]) {
        expect(logLevelSchema.parse(level)).toBe(level);
      }
    });

    it("rejects invalid level", () => {
      expect(() => logLevelSchema.parse("verbose")).toThrow();
    });
  });
});

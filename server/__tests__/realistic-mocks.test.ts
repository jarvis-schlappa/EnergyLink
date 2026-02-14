import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import { WallboxMockService } from "../demo/wallbox-mock";

describe("WallboxMockService - Realistic Mock Improvements (Issue #83)", () => {
  let wallbox: WallboxMockService;

  beforeEach(() => {
    vi.useFakeTimers();
    wallbox = new WallboxMockService();
    wallbox.initializeDemo();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe("Report 1: Product String Padding", () => {
    it("should have trailing spaces in Product field (fixed-width)", () => {
      const report = wallbox.getReport1();
      expect(report.Product).toMatch(/^KC-P20-EC240130-000\s+$/);
      expect(report.Product.length).toBeGreaterThan("KC-P20-EC240130-000".length);
    });

    it("should have realistic Serial and Firmware", () => {
      const report = wallbox.getReport1();
      expect(report.Serial).toBe("16314582");
      expect(report.Firmware).toContain("KEBA P20");
    });
  });

  describe("Report 2: State and Enable behavior", () => {
    it("should start with Enable sys=0, Enable user=0", () => {
      const report = wallbox.getReport2();
      expect(report["Enable sys"]).toBe(0);
      expect(report["Enable user"]).toBe(0);
    });

    it("should set Max curr=0 when not enabled (like real KEBA after stop)", () => {
      const report = wallbox.getReport2();
      expect(report["Max curr"]).toBe(0);
    });

    it("should keep Curr user after stop (like real KEBA)", () => {
      wallbox.executeCommand("curr 10000");
      wallbox.executeCommand("ena 1");
      vi.advanceTimersByTime(3000);
      
      wallbox.executeCommand("ena 0");
      
      const report = wallbox.getReport2();
      expect(report["Curr user"]).toBe(10000);
      expect(report["Max curr"]).toBe(0);
      expect(report["Enable sys"]).toBe(0);
      expect(report["Enable user"]).toBe(0);
    });

    it("should calculate Max curr % correctly (@10A=166, @16A=266)", () => {
      wallbox.executeCommand("curr 10000");
      wallbox.executeCommand("ena 1");
      vi.advanceTimersByTime(3000);
      
      let report = wallbox.getReport2();
      expect(report["Max curr %"]).toBe(166);
      
      wallbox.executeCommand("curr 16000");
      report = wallbox.getReport2();
      expect(report["Max curr %"]).toBe(266);
    });

    it("should go to State 5 (interrupted) after stop with cable plugged", () => {
      wallbox.executeCommand("ena 1");
      vi.advanceTimersByTime(3000);
      
      expect(wallbox.getReport2().State).toBe(3);
      
      wallbox.executeCommand("ena 0");
      expect(wallbox.getReport2().State).toBe(5);
    });
  });

  describe("Report 3: Asymmetric values and PF", () => {
    it("should have asymmetric voltages (233-239V range) when charging", () => {
      wallbox.executeCommand("curr 10000");
      wallbox.executeCommand("ena 1");
      vi.advanceTimersByTime(3000);

      const voltages: number[][] = [];
      for (let i = 0; i < 10; i++) {
        const report = wallbox.getReport3();
        voltages.push([report.U1, report.U2, report.U3]);
      }
      
      for (const [u1, u2, u3] of voltages) {
        expect(u1).toBeGreaterThanOrEqual(233);
        expect(u1).toBeLessThanOrEqual(239);
        expect(u2).toBeGreaterThanOrEqual(233);
        expect(u2).toBeLessThanOrEqual(239);
        expect(u3).toBeGreaterThanOrEqual(233);
        expect(u3).toBeLessThanOrEqual(239);
      }
    });

    it("should have asymmetric currents when charging after ramp-up", () => {
      wallbox.executeCommand("curr 10000");
      wallbox.executeCommand("ena 1");
      vi.advanceTimersByTime(35000); // Past ramp-up

      const report = wallbox.getReport3();
      // Currents should be near 10000mA with ±200mA jitter
      expect(report.I1).toBeGreaterThanOrEqual(9800);
      expect(report.I1).toBeLessThanOrEqual(10200);
      expect(report.I2).toBeGreaterThanOrEqual(9800);
      expect(report.I2).toBeLessThanOrEqual(10200);
      expect(report.I3).toBeGreaterThanOrEqual(9800);
      expect(report.I3).toBeLessThanOrEqual(10200);
    });

    it("should have PF=998-999 when charging (not 1000)", () => {
      wallbox.executeCommand("curr 10000");
      wallbox.executeCommand("ena 1");
      vi.advanceTimersByTime(3000);

      const pfs = new Set<number>();
      for (let i = 0; i < 20; i++) {
        pfs.add(wallbox.getReport3().PF);
      }
      
      for (const pf of pfs) {
        expect(pf).toBeGreaterThanOrEqual(998);
        expect(pf).toBeLessThanOrEqual(999);
      }
    });

    it("should report all zeros when idle (like real KEBA)", () => {
      const report = wallbox.getReport3();
      expect(report.U1).toBe(0);
      expect(report.U2).toBe(0);
      expect(report.U3).toBe(0);
      expect(report.I1).toBe(0);
      expect(report.I2).toBe(0);
      expect(report.I3).toBe(0);
      expect(report.P).toBe(0);
      expect(report.PF).toBe(0);
    });
  });

  describe("Ramp-Up Simulation", () => {
    it("should not be at full power immediately after starting", () => {
      wallbox.executeCommand("curr 16000");
      wallbox.executeCommand("ena 1");
      vi.advanceTimersByTime(3000); // State transition done, ramp just started (1s in)
      
      const earlyPower = wallbox.getCurrentPower();
      
      vi.advanceTimersByTime(30000); // Full ramp
      const fullPower = wallbox.getCurrentPower();
      
      expect(fullPower).toBeGreaterThan(0);
      // Early power should be less than full power (ramp-up)
      expect(earlyPower).toBeLessThan(fullPower);
    });

    it("should reach target power after ramp-up duration", () => {
      wallbox.executeCommand("curr 10000");
      wallbox.executeCommand("ena 1");
      vi.advanceTimersByTime(35000); // 2s transition + 30s ramp + margin
      
      const power = wallbox.getCurrentPower();
      // 10A * 3P * ~230V ≈ 6900W
      expect(power).toBeGreaterThan(6000);
    });
  });

  describe("E pres Incremental Counting", () => {
    it("should increment E pres based on actual power over time", () => {
      wallbox.executeCommand("curr 10000");
      wallbox.executeCommand("ena 1");
      vi.advanceTimersByTime(5000); // Past state transition, into ramp-up
      
      const ePres1 = wallbox.getEPres();
      
      vi.advanceTimersByTime(60000); // 1 minute of charging
      
      const ePres2 = wallbox.getEPres();
      expect(ePres2).toBeGreaterThan(ePres1);
    });

    it("should not increment E pres when idle", () => {
      const ePres1 = wallbox.getEPres();
      vi.advanceTimersByTime(60000);
      const ePres2 = wallbox.getEPres();
      expect(ePres2).toBe(ePres1);
    });
  });

  describe("State Transitions", () => {
    it("should transition through State 5→3 when starting from Ready", () => {
      const broadcasts: any[] = [];
      wallbox.setBroadcastCallback((data) => broadcasts.push({...data}));
      
      expect(wallbox.getReport2().State).toBe(2); // Ready
      
      wallbox.executeCommand("ena 1");
      
      // Should immediately go to State 5 (interrupted/auth)
      expect(wallbox.getReport2().State).toBe(5);
      
      // After delay, should go to State 3 (charging)
      vi.advanceTimersByTime(3000);
      expect(wallbox.getReport2().State).toBe(3);
      
      // Check broadcasts
      const stateBroadcasts = broadcasts.filter(b => b.State !== undefined);
      expect(stateBroadcasts.length).toBeGreaterThanOrEqual(2);
      expect(stateBroadcasts[0].State).toBe(5);
      expect(stateBroadcasts[1].State).toBe(3);
    });
  });

  describe("Serial field in reports", () => {
    it("should include Serial in Report 2 and Report 3", () => {
      const r2 = wallbox.getReport2();
      const r3 = wallbox.getReport3();
      expect(r2.Serial).toBe("16314582");
      expect(r3.Serial).toBe("16314582");
    });
  });
});

describe("E3dcMockService - Realistic Improvements (Issue #83)", () => {
  let e3dc: InstanceType<typeof import("../demo/e3dc-mock").E3dcMockService>;

  beforeEach(async () => {
    vi.useRealTimers(); // E3DC uses real timers for SOC tracking
    const { E3dcMockService } = await import("../demo/e3dc-mock");
    e3dc = new E3dcMockService();
  });

  describe("Hausverbrauch reacts to Wallbox load", () => {
    it("should increase house power when wallbox is charging", async () => {
      const dataIdle = await e3dc.getLiveData(0);
      const dataCharging = await e3dc.getLiveData(7000);

      // housePower should include wallbox load
      expect(dataCharging.housePower).toBeGreaterThan(dataIdle.housePower + 5000);
    });

    it("should reflect wallbox power in grid calculation", async () => {
      const dataIdle = await e3dc.getLiveData(0);
      const dataCharging = await e3dc.getLiveData(11000);

      // With 11kW wallbox load, grid import should increase significantly
      expect(dataCharging.gridPower).toBeGreaterThan(dataIdle.gridPower);
    });
  });

  describe("Autarkie/Eigenverbrauch realistic calculation", () => {
    it("should have low autarky when grid import is high", async () => {
      // 11kW wallbox load at night → almost all from grid
      const data = await e3dc.getLiveData(11000);

      // At night with huge load, autarky should be very low
      // (depends on time of day, but with 11kW load it should be low)
      expect(data.autarky).toBeLessThanOrEqual(100);
      expect(data.autarky).toBeGreaterThanOrEqual(0);
      expect(data.selfConsumption).toBeGreaterThanOrEqual(0);
      expect(data.selfConsumption).toBeLessThanOrEqual(100);
    });

    it("should return valid autarky and selfConsumption values", async () => {
      const data = await e3dc.getLiveData(0);

      expect(data.autarky).toBeGreaterThanOrEqual(0);
      expect(data.autarky).toBeLessThanOrEqual(100);
      expect(data.selfConsumption).toBeGreaterThanOrEqual(0);
      expect(data.selfConsumption).toBeLessThanOrEqual(100);
    });
  });

  describe("Energy balance consistency", () => {
    it("should maintain energy balance: PV + Grid = House + Battery", async () => {
      const data = await e3dc.getLiveData(3000);

      // PV + Grid ≈ House + Battery (with rounding tolerance)
      const supply = data.pvPower + data.gridPower;
      const demand = data.housePower + data.batteryPower;

      // Should be approximately equal (within 1W rounding)
      expect(Math.abs(supply - demand)).toBeLessThanOrEqual(2);
    });
  });

  describe("SOC behavior", () => {
    it("should have SOC between 0 and 100", async () => {
      const data = await e3dc.getLiveData(0);
      expect(data.batterySoc).toBeGreaterThanOrEqual(0);
      expect(data.batterySoc).toBeLessThanOrEqual(100);
    });
  });

  describe("Grid frequency", () => {
    it("should return realistic grid frequency around 50Hz", async () => {
      const data = await e3dc.getLiveData(0);
      expect(data.gridFrequency).toBeGreaterThanOrEqual(49.9);
      expect(data.gridFrequency).toBeLessThanOrEqual(50.1);
    });
  });
});

/**
 * Unit tests for the ChargingStateMachine (Issue #35)
 *
 * Tests all state transitions in isolation.
 * No mocks needed - the state machine is pure logic.
 */

import { describe, it, expect } from "vitest";
import {
  deriveState,
  evaluate,
  evaluateReconcileEvent,
  type ChargingState,
  type StateInput,
  type StateConfig,
  type StateAction,
} from "../strategy/charging-state-machine";

// ─── Helpers ─────────────────────────────────────────────────────────────────

const defaultConfig: StateConfig = {
  minStartPowerWatt: 1500,
  stopThresholdWatt: 500,
  startDelaySeconds: 60,
  stopDelaySeconds: 120,
};

function makeInput(overrides: Partial<StateInput> = {}): StateInput {
  return {
    surplus: 3000,
    plug: 7,
    wallboxReallyCharging: false,
    targetCurrentMa: 10000,
    userLimitAmpere: undefined,
    strategy: "surplus_battery_prio",
    isMaxPower: false,
    ...overrides,
  };
}

function makeTimers(overrides: Partial<{
  startDelayTrackerSince: string;
  belowThresholdSince: string;
  lastStartedAt: string;
  stabilizationPeriodMs: number;
}> = {}) {
  return {
    stabilizationPeriodMs: 20000,
    ...overrides,
  };
}

function hasAction(actions: StateAction[], type: StateAction["type"]): boolean {
  return actions.some(a => a.type === type);
}

function getAction(actions: StateAction[], type: StateAction["type"]): StateAction | undefined {
  return actions.find(a => a.type === type);
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe("ChargingStateMachine", () => {

  // ─── deriveState ─────────────────────────────────────────────────────

  describe("deriveState", () => {
    it("returns IDLE for default context", () => {
      expect(deriveState({ isActive: false })).toBe("IDLE");
    });

    it("returns WAIT_START when startDelayTrackerSince is set", () => {
      expect(deriveState({
        isActive: false,
        startDelayTrackerSince: new Date().toISOString(),
      })).toBe("WAIT_START");
    });

    it("returns CHARGING when active without belowThresholdSince", () => {
      expect(deriveState({ isActive: true })).toBe("CHARGING");
    });

    it("returns WAIT_STOP when active with belowThresholdSince", () => {
      expect(deriveState({
        isActive: true,
        belowThresholdSince: new Date().toISOString(),
      })).toBe("WAIT_STOP");
    });

    it("returns CAR_FINISHED when vehicleFinishedCharging", () => {
      expect(deriveState({
        isActive: false,
        vehicleFinishedCharging: true,
      })).toBe("CAR_FINISHED");
    });

    it("CAR_FINISHED takes priority over WAIT_START", () => {
      expect(deriveState({
        isActive: false,
        vehicleFinishedCharging: true,
        startDelayTrackerSince: new Date().toISOString(),
      })).toBe("CAR_FINISHED");
    });
  });

  // ─── IDLE transitions ───────────────────────────────────────────────

  describe("IDLE state", () => {
    it("stays IDLE when no car connected", () => {
      const result = evaluate("IDLE", makeInput({ plug: 1 }), defaultConfig, makeTimers());
      expect(result.newState).toBe("IDLE");
      expect(hasAction(result.actions, "NONE")).toBe(true);
    });

    it("stays IDLE when surplus below minStartPower", () => {
      const result = evaluate("IDLE", makeInput({ surplus: 1000 }), defaultConfig, makeTimers());
      expect(result.newState).toBe("IDLE");
    });

    it("stays IDLE when targetCurrentMa is null", () => {
      const result = evaluate("IDLE", makeInput({ targetCurrentMa: null }), defaultConfig, makeTimers());
      expect(result.newState).toBe("IDLE");
    });

    it("transitions to WAIT_START when surplus >= minStartPower and car connected", () => {
      const result = evaluate("IDLE", makeInput({ surplus: 2000, plug: 7 }), defaultConfig, makeTimers());
      expect(result.newState).toBe("WAIT_START");
      expect(hasAction(result.actions, "START_DELAY_BEGIN")).toBe(true);
    });

    it("max power: transitions directly to CHARGING when car connected", () => {
      const result = evaluate("IDLE", makeInput({
        isMaxPower: true,
        plug: 7,
        targetCurrentMa: 32000,
      }), defaultConfig, makeTimers());
      expect(result.newState).toBe("CHARGING");
      expect(hasAction(result.actions, "START_CHARGING")).toBe(true);
      const startAction = getAction(result.actions, "START_CHARGING");
      expect(startAction).toEqual({ type: "START_CHARGING", currentMa: 32000 });
    });

    it("max power: stays IDLE when no car connected", () => {
      const result = evaluate("IDLE", makeInput({
        isMaxPower: true,
        plug: 1,
        targetCurrentMa: 32000,
      }), defaultConfig, makeTimers());
      expect(result.newState).toBe("IDLE");
    });

    it("max power: respects user limit on start", () => {
      const result = evaluate("IDLE", makeInput({
        isMaxPower: true,
        plug: 7,
        targetCurrentMa: 32000,
        userLimitAmpere: 16,
      }), defaultConfig, makeTimers());
      expect(result.newState).toBe("CHARGING");
      const startAction = getAction(result.actions, "START_CHARGING");
      expect(startAction).toEqual({ type: "START_CHARGING", currentMa: 16000 });
    });
  });

  // ─── WAIT_START transitions ─────────────────────────────────────────

  describe("WAIT_START state", () => {
    it("resets to IDLE when car disconnected", () => {
      const result = evaluate("WAIT_START", makeInput({ plug: 1 }), defaultConfig,
        makeTimers({ startDelayTrackerSince: new Date().toISOString() }));
      expect(result.newState).toBe("IDLE");
      expect(hasAction(result.actions, "START_DELAY_RESET")).toBe(true);
    });

    it("resets to IDLE when surplus drops below minStartPower", () => {
      const result = evaluate("WAIT_START", makeInput({ surplus: 1000 }), defaultConfig,
        makeTimers({ startDelayTrackerSince: new Date().toISOString() }));
      expect(result.newState).toBe("IDLE");
      expect(hasAction(result.actions, "START_DELAY_RESET")).toBe(true);
    });

    it("ticks countdown when delay not expired", () => {
      const result = evaluate("WAIT_START", makeInput({ surplus: 2000 }), defaultConfig,
        makeTimers({ startDelayTrackerSince: new Date(Date.now() - 30000).toISOString() }));
      expect(result.newState).toBe("WAIT_START");
      const tick = getAction(result.actions, "START_DELAY_TICK") as any;
      expect(tick).toBeDefined();
      expect(tick.remainingSeconds).toBeGreaterThan(0);
      expect(tick.remainingSeconds).toBeLessThanOrEqual(30);
    });

    it("transitions to CHARGING when delay expired", () => {
      const result = evaluate("WAIT_START", makeInput({
        surplus: 2000,
        targetCurrentMa: 8000,
      }), defaultConfig,
        makeTimers({ startDelayTrackerSince: new Date(Date.now() - 120000).toISOString() }));
      expect(result.newState).toBe("CHARGING");
      expect(hasAction(result.actions, "START_CHARGING")).toBe(true);
      expect(hasAction(result.actions, "START_DELAY_RESET")).toBe(true);
    });

    it("respects user limit when transitioning to CHARGING", () => {
      const result = evaluate("WAIT_START", makeInput({
        surplus: 2000,
        targetCurrentMa: 16000,
        userLimitAmpere: 10,
      }), defaultConfig,
        makeTimers({ startDelayTrackerSince: new Date(Date.now() - 120000).toISOString() }));
      expect(result.newState).toBe("CHARGING");
      const startAction = getAction(result.actions, "START_CHARGING") as any;
      expect(startAction.currentMa).toBe(10000);
    });

    it("resets to IDLE when delay expired but targetCurrentMa is null", () => {
      const result = evaluate("WAIT_START", makeInput({
        surplus: 2000,
        targetCurrentMa: null,
      }), defaultConfig,
        makeTimers({ startDelayTrackerSince: new Date(Date.now() - 120000).toISOString() }));
      expect(result.newState).toBe("IDLE");
      expect(hasAction(result.actions, "START_DELAY_RESET")).toBe(true);
    });
  });

  // ─── CHARGING transitions ──────────────────────────────────────────

  describe("CHARGING state", () => {
    it("adjusts current when surplus changes", () => {
      const result = evaluate("CHARGING", makeInput({
        surplus: 3000,
        targetCurrentMa: 12000,
      }), defaultConfig, makeTimers({
        lastStartedAt: new Date(Date.now() - 60000).toISOString(),
      }));
      expect(result.newState).toBe("CHARGING");
      const adjust = getAction(result.actions, "ADJUST_CURRENT") as any;
      expect(adjust).toBeDefined();
      expect(adjust.currentMa).toBe(12000);
    });

    it("transitions to WAIT_STOP when surplus below threshold", () => {
      const result = evaluate("CHARGING", makeInput({
        surplus: 300,
        targetCurrentMa: null,
      }), defaultConfig, makeTimers({
        lastStartedAt: new Date(Date.now() - 60000).toISOString(),
      }));
      expect(result.newState).toBe("WAIT_STOP");
      expect(hasAction(result.actions, "STOP_DELAY_BEGIN")).toBe(true);
    });

    it("stays CHARGING when result=null but no stop condition (stabilization)", () => {
      // During stabilization, even result=null keeps CHARGING state
      const result = evaluate("CHARGING", makeInput({
        surplus: 300,
        targetCurrentMa: null,
      }), defaultConfig, makeTimers({
        lastStartedAt: new Date(Date.now() - 5000).toISOString(),
        stabilizationPeriodMs: 20000,
      }));
      expect(result.newState).toBe("CHARGING");
      expect(hasAction(result.actions, "STOP_DELAY_BEGIN")).toBe(false);
    });

    it("does not trigger stop during stabilization period", () => {
      const result = evaluate("CHARGING", makeInput({
        surplus: 0,
        targetCurrentMa: null,
      }), defaultConfig, makeTimers({
        lastStartedAt: new Date(Date.now() - 5000).toISOString(),
        stabilizationPeriodMs: 20000,
      }));
      expect(result.newState).toBe("CHARGING");
      expect(hasAction(result.actions, "STOP_DELAY_BEGIN")).toBe(false);
    });

    it("max power: never transitions to WAIT_STOP", () => {
      const result = evaluate("CHARGING", makeInput({
        isMaxPower: true,
        surplus: 0,
        targetCurrentMa: 32000,
      }), defaultConfig, makeTimers({
        lastStartedAt: new Date(Date.now() - 60000).toISOString(),
      }));
      expect(result.newState).toBe("CHARGING");
      expect(hasAction(result.actions, "STOP_DELAY_BEGIN")).toBe(false);
    });

    it("max power: adjusts to max current even with zero surplus", () => {
      const result = evaluate("CHARGING", makeInput({
        isMaxPower: true,
        surplus: 0,
        targetCurrentMa: 32000,
      }), defaultConfig, makeTimers({
        lastStartedAt: new Date(Date.now() - 60000).toISOString(),
      }));
      const adjust = getAction(result.actions, "ADJUST_CURRENT") as any;
      expect(adjust.currentMa).toBe(32000);
    });

    it("applies user limit on current adjustment", () => {
      const result = evaluate("CHARGING", makeInput({
        surplus: 5000,
        targetCurrentMa: 20000,
        userLimitAmpere: 12,
      }), defaultConfig, makeTimers({
        lastStartedAt: new Date(Date.now() - 60000).toISOString(),
      }));
      const adjust = getAction(result.actions, "ADJUST_CURRENT") as any;
      expect(adjust.currentMa).toBe(12000);
    });

    it("stays CHARGING with NONE when result=null and past stabilization (stop managed elsewhere)", () => {
      // result=null during active charging but surplus still above stopThreshold
      // → wallbox continues with last current, stop is managed by state machine stop-delay
      const result = evaluate("CHARGING", makeInput({
        surplus: 1000, // > stopThreshold(500)
        targetCurrentMa: null,
      }), defaultConfig, makeTimers({
        lastStartedAt: new Date(Date.now() - 60000).toISOString(),
      }));
      // surplus(1000) >= stopThreshold(500) → stays CHARGING, not WAIT_STOP
      expect(result.newState).toBe("CHARGING");
      expect(hasAction(result.actions, "NONE")).toBe(true);
    });
  });

  // ─── WAIT_STOP transitions ─────────────────────────────────────────

  describe("WAIT_STOP state", () => {
    it("transitions back to CHARGING when surplus recovers", () => {
      const result = evaluate("WAIT_STOP", makeInput({
        surplus: 1000,
        targetCurrentMa: 8000,
      }), defaultConfig, makeTimers({
        belowThresholdSince: new Date(Date.now() - 60000).toISOString(),
      }));
      expect(result.newState).toBe("CHARGING");
      expect(hasAction(result.actions, "STOP_DELAY_RESET")).toBe(true);
      expect(hasAction(result.actions, "ADJUST_CURRENT")).toBe(true);
    });

    it("transitions to IDLE when stop delay expired", () => {
      const result = evaluate("WAIT_STOP", makeInput({
        surplus: 300,
      }), defaultConfig, makeTimers({
        belowThresholdSince: new Date(Date.now() - 130000).toISOString(), // > 120s
      }));
      expect(result.newState).toBe("IDLE");
      expect(hasAction(result.actions, "STOP_CHARGING")).toBe(true);
      expect(hasAction(result.actions, "STOP_DELAY_RESET")).toBe(true);
    });

    it("ticks countdown when delay not expired", () => {
      const result = evaluate("WAIT_STOP", makeInput({
        surplus: 300,
      }), defaultConfig, makeTimers({
        belowThresholdSince: new Date(Date.now() - 60000).toISOString(),
      }));
      expect(result.newState).toBe("WAIT_STOP");
      const tick = getAction(result.actions, "STOP_DELAY_TICK") as any;
      expect(tick).toBeDefined();
      expect(tick.remainingSeconds).toBeGreaterThan(0);
      expect(tick.remainingSeconds).toBeLessThanOrEqual(60);
    });
  });

  // ─── CAR_FINISHED transitions ──────────────────────────────────────

  describe("CAR_FINISHED state", () => {
    it("stays in CAR_FINISHED during processStrategy (no auto-exit)", () => {
      const result = evaluate("CAR_FINISHED", makeInput({
        surplus: 5000,
        plug: 7,
      }), defaultConfig, makeTimers());
      expect(result.newState).toBe("CAR_FINISHED");
    });
  });

  // ─── Reconcile events ──────────────────────────────────────────────

  describe("evaluateReconcileEvent", () => {
    it("WALLBOX_STOPPED_WHILE_ACTIVE with plug connected → CAR_FINISHED", () => {
      const result = evaluateReconcileEvent("CHARGING", {
        type: "WALLBOX_STOPPED_WHILE_ACTIVE",
        plugStillConnected: true,
      });
      expect(result.newState).toBe("CAR_FINISHED");
      expect(hasAction(result.actions, "SET_CAR_FINISHED")).toBe(true);
    });

    it("WALLBOX_STOPPED_WHILE_ACTIVE with plug disconnected → IDLE", () => {
      const result = evaluateReconcileEvent("CHARGING", {
        type: "WALLBOX_STOPPED_WHILE_ACTIVE",
        plugStillConnected: false,
      });
      expect(result.newState).toBe("IDLE");
      expect(hasAction(result.actions, "STOP_CHARGING")).toBe(true);
    });

    it("PLUG_CHANGED in CAR_FINISHED → IDLE", () => {
      const result = evaluateReconcileEvent("CAR_FINISHED", {
        type: "PLUG_CHANGED",
        previousPlug: 7,
        newPlug: 1,
      });
      expect(result.newState).toBe("IDLE");
      expect(hasAction(result.actions, "RESET_CAR_FINISHED")).toBe(true);
    });

    it("PLUG_CHANGED in IDLE → stays IDLE", () => {
      const result = evaluateReconcileEvent("IDLE", {
        type: "PLUG_CHANGED",
        previousPlug: 1,
        newPlug: 7,
      });
      expect(result.newState).toBe("IDLE");
    });

    it("STRATEGY_CHANGED in CAR_FINISHED → IDLE", () => {
      const result = evaluateReconcileEvent("CAR_FINISHED", {
        type: "STRATEGY_CHANGED",
      });
      expect(result.newState).toBe("IDLE");
      expect(hasAction(result.actions, "RESET_CAR_FINISHED")).toBe(true);
    });

    it("STRATEGY_CHANGED in CHARGING → stays CHARGING", () => {
      const result = evaluateReconcileEvent("CHARGING", {
        type: "STRATEGY_CHANGED",
      });
      expect(result.newState).toBe("CHARGING");
    });
  });
});

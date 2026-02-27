/**
 * Charging State Machine (Issue #35)
 *
 * Explicit state machine for the ChargingStrategyController.
 * Manages charging states and transitions without side effects.
 * All side effects (UDP commands, storage updates, notifications) remain in the controller.
 *
 * States:
 *   IDLE          → No charging, waiting for conditions
 *   WAIT_START    → Surplus + car connected, start delay running
 *   CHARGING      → Wallbox is charging, current being adjusted
 *   WAIT_STOP     → Surplus too low, stop delay running
 *   CAR_FINISHED  → Car finished charging, no restart until cable change
 *
 * The state machine is deterministic: given a state and input, the transition is always the same.
 */

export type ChargingState = "IDLE" | "WAIT_START" | "CHARGING" | "WAIT_STOP" | "CAR_FINISHED";

/**
 * Input for state evaluation - collected from various sources before each cycle.
 */
export interface StateInput {
  /** Current calculated surplus in watts */
  surplus: number;
  /** Wallbox plug status (1=no cable, 7=car ready) */
  plug: number;
  /** Whether the wallbox is physically charging (State=3, Power>0) */
  wallboxReallyCharging: boolean;
  /** Target current from calculateTargetCurrent (null = below minimum) */
  targetCurrentMa: number | null;
  /** Whether a user current limit applies */
  userLimitAmpere: number | undefined;
  /** Strategy type */
  strategy: string;
  /** Is this a max power strategy (max_with_battery or max_without_battery)? */
  isMaxPower: boolean;
}

/**
 * Configuration for state transitions - from ChargingStrategyConfig.
 */
export interface StateConfig {
  minStartPowerWatt: number;
  stopThresholdWatt: number;
  startDelaySeconds: number;
  stopDelaySeconds: number;
}

/**
 * Actions the controller should perform based on state transitions.
 */
export type StateAction =
  | { type: "START_CHARGING"; currentMa: number }
  | { type: "STOP_CHARGING"; reason: string }
  | { type: "ADJUST_CURRENT"; currentMa: number }
  | { type: "START_DELAY_BEGIN" }
  | { type: "START_DELAY_TICK"; remainingSeconds: number }
  | { type: "START_DELAY_RESET" }
  | { type: "STOP_DELAY_BEGIN" }
  | { type: "STOP_DELAY_TICK"; remainingSeconds: number }
  | { type: "STOP_DELAY_RESET" }
  | { type: "SET_CAR_FINISHED" }
  | { type: "RESET_CAR_FINISHED" }
  | { type: "NONE" };

/**
 * Transition result: new state + action(s) for the controller.
 */
export interface TransitionResult {
  newState: ChargingState;
  actions: StateAction[];
}

/**
 * Determines the current state from context values.
 * This bridges the implicit state in the current controller to explicit states.
 */
export function deriveState(context: {
  isActive: boolean;
  vehicleFinishedCharging?: boolean;
  startDelayTrackerSince?: string;
  belowThresholdSince?: string;
}): ChargingState {
  if (context.isActive) {
    return context.belowThresholdSince ? "WAIT_STOP" : "CHARGING";
  }
  if (context.vehicleFinishedCharging) {
    return "CAR_FINISHED";
  }
  if (context.startDelayTrackerSince) {
    return "WAIT_START";
  }
  return "IDLE";
}

/**
 * Evaluates the state machine transition for the current cycle.
 *
 * IMPORTANT: This function is PURE - no side effects, no storage access.
 * It takes the current state and input, returns the new state and actions.
 *
 * The controller is responsible for:
 * 1. Deriving the current state (via deriveState)
 * 2. Collecting the input (surplus, plug, etc.)
 * 3. Calling evaluate()
 * 4. Executing the returned actions
 */
export function evaluate(
  currentState: ChargingState,
  input: StateInput,
  config: StateConfig,
  timers: {
    startDelayTrackerSince?: string;
    belowThresholdSince?: string;
    lastStartedAt?: string;
    stabilizationPeriodMs: number;
  },
): TransitionResult {
  const now = Date.now();

  switch (currentState) {
    // ─── IDLE ────────────────────────────────────────────────────────
    case "IDLE": {
      // Max power strategies start immediately (no delay) when car connected
      if (input.isMaxPower) {
        if (input.plug === 7 && input.targetCurrentMa !== null) {
          const effectiveMa = clampToUserLimit(input.targetCurrentMa, input.userLimitAmpere);
          return {
            newState: "CHARGING",
            actions: [{ type: "START_CHARGING", currentMa: effectiveMa }],
          };
        }
        return { newState: "IDLE", actions: [{ type: "NONE" }] };
      }

      // Surplus strategies: need car + sufficient surplus to start delay
      if (input.plug !== 7) {
        return { newState: "IDLE", actions: [{ type: "NONE" }] };
      }

      if (input.targetCurrentMa === null) {
        // Surplus below minimum power - can't even start at 6A
        return { newState: "IDLE", actions: [{ type: "NONE" }] };
      }

      if (input.surplus >= config.minStartPowerWatt) {
        // Surplus high enough → start delay timer
        return {
          newState: "WAIT_START",
          actions: [{ type: "START_DELAY_BEGIN" }],
        };
      }

      return { newState: "IDLE", actions: [{ type: "NONE" }] };
    }

    // ─── WAIT_START ──────────────────────────────────────────────────
    case "WAIT_START": {
      // Car disconnected → back to IDLE
      if (input.plug !== 7) {
        return {
          newState: "IDLE",
          actions: [{ type: "START_DELAY_RESET" }],
        };
      }

      // Surplus dropped below minimum (but calculateTargetCurrent may still return non-null
      // if surplus >= minPower for 6A. We check against minStartPowerWatt here.)
      if (input.surplus < config.minStartPowerWatt) {
        return {
          newState: "IDLE",
          actions: [{ type: "START_DELAY_RESET" }],
        };
      }

      // Check if delay has expired
      if (timers.startDelayTrackerSince) {
        const waitingSince = new Date(timers.startDelayTrackerSince).getTime();
        const elapsed = (now - waitingSince) / 1000;

        if (elapsed >= config.startDelaySeconds) {
          // Delay expired → start charging!
          if (input.targetCurrentMa !== null) {
            const effectiveMa = clampToUserLimit(input.targetCurrentMa, input.userLimitAmpere);
            return {
              newState: "CHARGING",
              actions: [
                { type: "START_DELAY_RESET" },
                { type: "START_CHARGING", currentMa: effectiveMa },
              ],
            };
          }
          // Shouldn't happen (surplus >= minStartPower but targetCurrent=null), but be safe
          return { newState: "IDLE", actions: [{ type: "START_DELAY_RESET" }] };
        }

        // Still waiting
        const remaining = Math.ceil(config.startDelaySeconds - elapsed);
        return {
          newState: "WAIT_START",
          actions: [{ type: "START_DELAY_TICK", remainingSeconds: remaining }],
        };
      }

      // No timer yet - shouldn't happen in WAIT_START state, but handle gracefully
      return {
        newState: "WAIT_START",
        actions: [{ type: "START_DELAY_BEGIN" }],
      };
    }

    // ─── CHARGING ────────────────────────────────────────────────────
    case "CHARGING": {
      // Max power strategies never stop via surplus check
      if (input.isMaxPower) {
        if (input.targetCurrentMa !== null) {
          const effectiveMa = clampToUserLimit(input.targetCurrentMa, input.userLimitAmpere);
          return {
            newState: "CHARGING",
            actions: [{ type: "ADJUST_CURRENT", currentMa: effectiveMa }],
          };
        }
        return { newState: "CHARGING", actions: [{ type: "NONE" }] };
      }

      // Stabilization period: don't evaluate stop conditions right after start
      if (timers.lastStartedAt) {
        const timeSinceStart = now - new Date(timers.lastStartedAt).getTime();
        if (timeSinceStart < timers.stabilizationPeriodMs) {
          // During stabilization, still adjust current if possible
          if (input.targetCurrentMa !== null) {
            const effectiveMa = clampToUserLimit(input.targetCurrentMa, input.userLimitAmpere);
            return {
              newState: "CHARGING",
              actions: [{ type: "ADJUST_CURRENT", currentMa: effectiveMa }],
            };
          }
          return { newState: "CHARGING", actions: [{ type: "NONE" }] };
        }
      }

      // Check stop condition: surplus below threshold
      if (input.surplus < config.stopThresholdWatt) {
        return {
          newState: "WAIT_STOP",
          actions: [{ type: "STOP_DELAY_BEGIN" }],
        };
      }

      // Surplus OK - adjust current
      if (input.targetCurrentMa !== null) {
        const effectiveMa = clampToUserLimit(input.targetCurrentMa, input.userLimitAmpere);
        return {
          newState: "CHARGING",
          actions: [{ type: "ADJUST_CURRENT", currentMa: effectiveMa }],
        };
      }

      // result=null during active charging: wallbox continues with last set current
      // (stop-delay timer manages stop via stopThresholdWatt)
      return { newState: "CHARGING", actions: [{ type: "NONE" }] };
    }

    // ─── WAIT_STOP ───────────────────────────────────────────────────
    case "WAIT_STOP": {
      // Surplus recovered above threshold → back to CHARGING
      if (input.surplus >= config.stopThresholdWatt) {
        const actions: StateAction[] = [{ type: "STOP_DELAY_RESET" }];
        if (input.targetCurrentMa !== null) {
          const effectiveMa = clampToUserLimit(input.targetCurrentMa, input.userLimitAmpere);
          actions.push({ type: "ADJUST_CURRENT", currentMa: effectiveMa });
        }
        return { newState: "CHARGING", actions };
      }

      // Check if stop delay has expired
      if (timers.belowThresholdSince) {
        const belowSince = new Date(timers.belowThresholdSince).getTime();
        const elapsed = (now - belowSince) / 1000;

        if (elapsed >= config.stopDelaySeconds) {
          return {
            newState: "IDLE",
            actions: [
              { type: "STOP_DELAY_RESET" },
              { type: "STOP_CHARGING", reason: "Überschuss zu gering" },
            ],
          };
        }

        const remaining = Math.ceil(config.stopDelaySeconds - elapsed);
        return {
          newState: "WAIT_STOP",
          actions: [{ type: "STOP_DELAY_TICK", remainingSeconds: remaining }],
        };
      }

      // No timer - shouldn't happen but handle gracefully
      return {
        newState: "WAIT_STOP",
        actions: [{ type: "STOP_DELAY_BEGIN" }],
      };
    }

    // ─── CAR_FINISHED ────────────────────────────────────────────────
    case "CAR_FINISHED": {
      // This state is only exited via plug change (handled in reconcile, not here)
      // or strategy change (handled in switchStrategy).
      // Within processStrategy, we just stay in CAR_FINISHED.
      return { newState: "CAR_FINISHED", actions: [{ type: "NONE" }] };
    }

    default:
      return { newState: "IDLE", actions: [{ type: "NONE" }] };
  }
}

/**
 * Handle reconcile-detected events that cause state changes.
 * These are events detected by comparing wallbox status to context.
 */
export function evaluateReconcileEvent(
  currentState: ChargingState,
  event:
    | { type: "WALLBOX_STOPPED_WHILE_ACTIVE"; plugStillConnected: boolean }
    | { type: "PLUG_CHANGED"; previousPlug: number; newPlug: number }
    | { type: "STRATEGY_CHANGED" },
): TransitionResult {
  switch (event.type) {
    case "WALLBOX_STOPPED_WHILE_ACTIVE":
      if (event.plugStillConnected) {
        // Car still connected but stopped charging → car is full
        return {
          newState: "CAR_FINISHED",
          actions: [{ type: "SET_CAR_FINISHED" }],
        };
      }
      // Car disconnected
      return {
        newState: "IDLE",
        actions: [{ type: "STOP_CHARGING", reason: "Wallbox gestoppt (Auto abgesteckt)" }],
      };

    case "PLUG_CHANGED":
      if (currentState === "CAR_FINISHED") {
        return {
          newState: "IDLE",
          actions: [{ type: "RESET_CAR_FINISHED" }],
        };
      }
      return { newState: currentState, actions: [{ type: "NONE" }] };

    case "STRATEGY_CHANGED":
      if (currentState === "CAR_FINISHED") {
        return {
          newState: "IDLE",
          actions: [{ type: "RESET_CAR_FINISHED" }],
        };
      }
      return { newState: currentState, actions: [{ type: "NONE" }] };

    default:
      return { newState: currentState, actions: [{ type: "NONE" }] };
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function clampToUserLimit(currentMa: number, userLimitAmpere: number | undefined): number {
  if (userLimitAmpere && userLimitAmpere * 1000 < currentMa) {
    return userLimitAmpere * 1000;
  }
  return currentMa;
}

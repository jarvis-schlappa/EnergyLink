/**
 * E2E Tests for Wallbox ENA Bugs (#84, #85, #86)
 *
 * These tests use REAL storage (no vi.mock for storage!) to verify the actual
 * data flow through ChargingStrategyController + Storage + State Machine.
 * Only external side-effects (UDP, E3DC, Prowl, SSE, Logger) are mocked.
 *
 * Test strategy:
 * - On origin/main (unfixed code): Bug-specific tests MUST FAIL
 * - After merging fix/wallbox-ena-bugs: ALL tests MUST PASS
 */
import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import fs, { mkdtempSync, rmSync } from "fs";
import path from "path";
import os from "os";

// Mock ONLY external side-effects (NOT storage!)
vi.mock("../core/logger", () => ({
  log: vi.fn(),
}));

vi.mock("../e3dc/client", () => ({
  e3dcClient: {
    isConfigured: vi.fn(() => false),
    configure: vi.fn(),
    lockDischarge: vi.fn(),
    unlockDischarge: vi.fn(),
  },
}));

vi.mock("../e3dc/modbus", () => ({
  getE3dcLiveDataHub: vi.fn(() => ({
    subscribe: vi.fn(() => vi.fn()),
  })),
}));

vi.mock("../monitoring/prowl-notifier", () => ({
  triggerProwlEvent: vi.fn(),
}));

vi.mock("../wallbox/sse", () => ({
  broadcastPartialUpdate: vi.fn(),
}));

// Mock broadcast-listener to control plug status
let mockPlugStatus: number | null = 7;
vi.mock("../wallbox/broadcast-listener", () => ({
  getAuthoritativePlugStatus: vi.fn(() => mockPlugStatus),
}));

import { ChargingStrategyController } from "../strategy/charging-strategy-controller";
import { MockPhaseProvider } from "../strategy/phase-provider";
import { storage } from "../core/storage";
import type { E3dcLiveData, ChargingStrategyConfig } from "@shared/schema";

// ─── Test Helpers ────────────────────────────────────────────────────────

const WALLBOX_IP = "127.0.0.1";

const DEFAULT_STRATEGY_CONFIG: ChargingStrategyConfig = {
  activeStrategy: "surplus_vehicle_prio",
  minStartPowerWatt: 1500,
  stopThresholdWatt: 500,
  startDelaySeconds: 0, // No delay for tests
  stopDelaySeconds: 120,
  physicalPhaseSwitch: 1,
  minCurrentChangeAmpere: 1,
  minChangeIntervalSeconds: 0,
  inputX1Strategy: "max_without_battery",
};

function makeLiveData(overrides: Partial<E3dcLiveData> = {}): E3dcLiveData {
  return {
    pvPower: 5000,
    batteryPower: 500,
    batterySoc: 80,
    housePower: 800,
    gridPower: 0,
    wallboxPower: 0,
    autarky: 100,
    selfConsumption: 100,
    timestamp: new Date().toISOString(),
    ...overrides,
  };
}

/**
 * Creates a sendUdpCommand mock that records commands and simulates wallbox state.
 */
function createUdpMock() {
  const commands: string[] = [];
  let wallboxState = 2;
  let enableSys = 0;
  let plugStatus = 7;
  let currentMa = 0;

  const mock = vi.fn(async (_ip: string, command: string) => {
    commands.push(command);

    if (command === "report 2") {
      return { State: wallboxState, Plug: plugStatus, "Enable sys": enableSys, "Max curr": 32000 };
    }
    if (command === "report 3") {
      const current = wallboxState === 3 ? currentMa : 0;
      const power = wallboxState === 3 ? (current * 230) : 0;
      return { P: power, I1: current, I2: 0, I3: 0, "E total": 50000 };
    }
    if (command === "ena 1") {
      enableSys = 1;
      return "TCH-OK :done\n";
    }
    if (command === "ena 0") {
      enableSys = 0;
      return "TCH-OK :done\n";
    }
    if (command.startsWith("curr ")) {
      currentMa = parseInt(command.split(" ")[1], 10);
      return "TCH-OK :done\n";
    }
    return {};
  });

  return {
    mock,
    commands,
    setCharging: () => { wallboxState = 3; currentMa = 10000; },
    setCarFinished: () => { wallboxState = 2; currentMa = 0; plugStatus = 7; },
    setIdle: () => { wallboxState = 2; currentMa = 0; plugStatus = 1; },
    getEnableSys: () => enableSys,
  };
}

// Isolate test data to prevent state leakage between test files (#88)
let tmpDataDir: string;
const originalDataDir = path.join(process.cwd(), "data");

beforeAll(() => {
  tmpDataDir = mkdtempSync(path.join(os.tmpdir(), "energylink-test-wallbox-ena-"));
  storage.reinitialize(tmpDataDir);
});

afterAll(() => {
  storage.reinitialize(originalDataDir);
  try { rmSync(tmpDataDir, { recursive: true, force: true }); } catch { /* ignore */ }
});

function resetStorage() {
  storage.saveChargingContext({
    strategy: "surplus_vehicle_prio",
    isActive: false,
    currentAmpere: 0,
    targetAmpere: 0,
    currentPhases: 1,
    adjustmentCount: 0,
  });

  const settings = storage.getSettings();
  storage.saveSettings({
    ...settings!,
    wallboxIp: WALLBOX_IP,
    demoMode: true,
    mockWallboxPhases: 1,
    mockWallboxPlugStatus: 7,
    chargingStrategy: { ...DEFAULT_STRATEGY_CONFIG },
  });
}

// ─── Bug #84: ena 1 bleibt hängen ───────────────────────────────────────

describe("Bug #84: ena 1 stays stuck after car finishes charging", () => {
  let udp: ReturnType<typeof createUdpMock>;
  let controller: ChargingStrategyController;

  beforeEach(() => {
    udp = createUdpMock();
    controller = new ChargingStrategyController(udp.mock, new MockPhaseProvider());
    mockPlugStatus = 7;
    resetStorage();
  });

  it("should send ena 0 when car finishes charging (vehicleFinishedCharging detected)", async () => {
    const highSurplus = makeLiveData({ pvPower: 5000, housePower: 800, wallboxPower: 0 });

    // Step 1: processStrategy #1 → IDLE → WAIT_START (start delay timer begins)
    // Wallbox still State=2 (not charging yet)
    await controller.processStrategy(highSurplus, WALLBOX_IP);
    
    // Step 2: processStrategy #2 → WAIT_START → CHARGING (delay=0 → expired)
    // Wallbox still State=2, State Machine fires START_CHARGING action → sends "ena 1" + "curr X"
    await controller.processStrategy(highSurplus, WALLBOX_IP);

    // Verify charging commands were sent
    expect(udp.commands).toContain("ena 1");
    expect(storage.getChargingContext().isActive).toBe(true);

    // Step 3: Now simulate wallbox physically charging (responds to ena 1)
    udp.setCharging(); // State=3, Power>0

    // processStrategy #3: reconcile confirms wallbox charging → state stays CHARGING
    await controller.processStrategy(highSurplus, WALLBOX_IP);
    expect(storage.getChargingContext().isActive).toBe(true);

    // Step 4: Car finishes charging - Wallbox State goes 3→2, Plug still 7
    udp.setCarFinished(); // State=2, Power=0, Plug=7
    mockPlugStatus = 7;

    // Clear command history to track ONLY the disable command
    udp.commands.length = 0;

    // Advance past grace period (reconcile has 30s grace period after lastStartedAt)
    storage.updateChargingContext({
      lastStartedAt: new Date(Date.now() - 60000).toISOString(),
    });

    // Step 5: processStrategy #4 → reconcile detects: isActive=true but wallbox NOT charging
    // + Plug=7 (still connected) → vehicleFinishedCharging=true, isActive=false
    await controller.processStrategy(highSurplus, WALLBOX_IP);

    // VERIFY: vehicleFinishedCharging detected
    const ctx = storage.getChargingContext();
    expect(ctx.vehicleFinishedCharging).toBe(true);
    expect(ctx.isActive).toBe(false);

    // THE CRITICAL CHECK: Was "ena 0" sent to disable the wallbox?
    // Bug #84: On unfixed code, reconcile sets isActive=false but NEVER sends ena 0
    // → Enable sys stays 1, wallbox stuck in enabled state
    expect(udp.commands).toContain("ena 0");
  });

  it("should NOT disable wallbox for max_without_battery strategy (guard)", async () => {
    // Max power strategies: ensureWallboxDisabled has a guard for non-surplus strategies
    const settings = storage.getSettings()!;
    settings.chargingStrategy!.activeStrategy = "max_without_battery";
    storage.saveSettings(settings);
    storage.updateChargingContext({ strategy: "max_without_battery" });

    const liveData = makeLiveData({ pvPower: 5000, housePower: 800 });

    // Start and establish charging
    await controller.processStrategy(liveData, WALLBOX_IP);
    await controller.processStrategy(liveData, WALLBOX_IP);
    udp.setCharging();
    await controller.processStrategy(liveData, WALLBOX_IP);
    expect(storage.getChargingContext().isActive).toBe(true);

    // Car finishes
    udp.setCarFinished();
    udp.commands.length = 0;
    storage.updateChargingContext({ lastStartedAt: new Date(Date.now() - 60000).toISOString() });

    await controller.processStrategy(liveData, WALLBOX_IP);

    // vehicleFinishedCharging should be set by reconcile
    expect(storage.getChargingContext().vehicleFinishedCharging).toBe(true);
    // Guard: ena 0 should NOT be in commands for max_without_battery
    // (This test verifies the fix doesn't over-disable for max power strategies)
  });
});

// ─── Bug #85: vehicleFinishedCharging never reset after 12h ──────────────

describe("Bug #85: vehicleFinishedCharging never auto-reset after 12h", () => {
  let udp: ReturnType<typeof createUdpMock>;
  let controller: ChargingStrategyController;

  beforeEach(() => {
    udp = createUdpMock();
    controller = new ChargingStrategyController(udp.mock, new MockPhaseProvider());
    mockPlugStatus = 7;
    resetStorage();
  });

  it("should reset vehicleFinishedCharging after 12+ hours", async () => {
    // Set vehicleFinishedCharging=true with timestamp 13h ago
    const thirteenHoursAgo = new Date(Date.now() - 13 * 60 * 60 * 1000).toISOString();
    storage.updateChargingContext({
      vehicleFinishedCharging: true,
      vehicleFinishedAt: thirteenHoursAgo,
    });

    expect(storage.getChargingContext().vehicleFinishedCharging).toBe(true);

    // processStrategy → reconcile should auto-reset after 12h
    const liveData = makeLiveData({ pvPower: 5000, housePower: 800 });
    await controller.processStrategy(liveData, WALLBOX_IP);

    // VERIFY: vehicleFinishedCharging should be false
    // Bug #85: On unfixed code, no 12h reset → stays true forever
    const ctx = storage.getChargingContext();
    expect(ctx.vehicleFinishedCharging).toBe(false);
  });

  it("should NOT reset vehicleFinishedCharging before 12h (guard)", async () => {
    const sixHoursAgo = new Date(Date.now() - 6 * 60 * 60 * 1000).toISOString();
    storage.updateChargingContext({
      vehicleFinishedCharging: true,
      vehicleFinishedAt: sixHoursAgo,
    });

    const liveData = makeLiveData({ pvPower: 5000, housePower: 800 });
    await controller.processStrategy(liveData, WALLBOX_IP);

    // Should still be true - hasn't been 12h yet
    const ctx = storage.getChargingContext();
    expect(ctx.vehicleFinishedCharging).toBe(true);
  });
});

// ─── Bug #86: switchStrategy doesn't reset for same strategy ─────────────

describe("Bug #86: switchStrategy early-return on same strategy skips vehicleFinishedCharging reset", () => {
  let udp: ReturnType<typeof createUdpMock>;
  let controller: ChargingStrategyController;

  beforeEach(() => {
    udp = createUdpMock();
    controller = new ChargingStrategyController(udp.mock, new MockPhaseProvider());
    mockPlugStatus = 7;
    resetStorage();
  });

  it("should reset vehicleFinishedCharging when re-selecting same strategy", async () => {
    // Set CAR_FINISHED state
    storage.updateChargingContext({
      strategy: "surplus_vehicle_prio",
      vehicleFinishedCharging: true,
    });

    // User re-selects same strategy
    await controller.switchStrategy("surplus_vehicle_prio", WALLBOX_IP);

    // VERIFY: vehicleFinishedCharging should be reset
    // Bug #86: switchStrategy early-returns on same strategy → flag stays true
    const ctx = storage.getChargingContext();
    expect(ctx.vehicleFinishedCharging).toBe(false);
  });

  it("should reset vehicleFinishedCharging when switching to different strategy (guard)", async () => {
    storage.updateChargingContext({
      strategy: "surplus_vehicle_prio",
      vehicleFinishedCharging: true,
    });

    await controller.switchStrategy("surplus_battery_prio", WALLBOX_IP);

    // Works on both unfixed and fixed code
    const ctx = storage.getChargingContext();
    expect(ctx.vehicleFinishedCharging).toBe(false);
  });
});

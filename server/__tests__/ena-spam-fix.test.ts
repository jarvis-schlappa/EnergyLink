/**
 * Tests for Issue #90: ensureWallboxDisabled() ena 0 Spam
 *
 * Bug: ensureWallboxDisabled() sends "ena 0" on every E3DC poll cycle (~10s)
 * without checking the wallbox's "Enable sys" value. This creates log spam
 * and unnecessary UDP traffic.
 *
 * Fix: Pass "Enable sys" from report2 (already available in reconcile) into
 * ensureWallboxDisabled(). Skip "ena 0" when Enable sys !== 1 (already disabled).
 *
 * Uses REAL storage (no vi.mock for storage!) + mocked UDP (same pattern as wallbox-ena-e2e.test.ts).
 */
import { describe, it, expect, beforeEach, beforeAll, afterAll, vi } from "vitest";
import { mkdtempSync, rmSync } from "fs";
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
  startDelaySeconds: 0,
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
      return { P: power, I1: current, I2: 0, I3: 0, "E total": 50000, "E pres": 0 };
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
    setCharging: () => { wallboxState = 3; currentMa = 10000; enableSys = 1; },
    setCarFinished: () => { wallboxState = 2; currentMa = 0; plugStatus = 7; enableSys = 0; },
    setIdle: () => { wallboxState = 2; currentMa = 0; plugStatus = 1; enableSys = 0; },
    setEnableSys: (v: number) => { enableSys = v; },
    getEnableSys: () => enableSys,
  };
}

let tmpDataDir: string;
const originalDataDir = path.join(process.cwd(), "data");

beforeAll(() => {
  tmpDataDir = mkdtempSync(path.join(os.tmpdir(), "energylink-test-ena-spam-"));
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

  storage.saveControlState({ nightCharging: false, batteryLock: false });
}

// ─── Issue #90: ena 0 Spam ───────────────────────────────────────────────

describe("Issue #90: ensureWallboxDisabled() ena 0 Spam", () => {
  let udp: ReturnType<typeof createUdpMock>;
  let controller: ChargingStrategyController;

  beforeEach(() => {
    udp = createUdpMock();
    controller = new ChargingStrategyController(udp.mock, new MockPhaseProvider());
    mockPlugStatus = 7;
    resetStorage();
  });

  // Test 1: Enable sys: 0 → ensureWallboxDisabled must NOT send ena 0
  it("should NOT send ena 0 when Enable sys is already 0 (wallbox already disabled)", async () => {
    // Wallbox already disabled: Enable sys = 0, State = 2, not charging
    udp.setEnableSys(0);

    // Trigger reconcile via processStrategy (surplus strategy, not active)
    const liveData = makeLiveData({ pvPower: 500, housePower: 800 }); // Low surplus → no start
    await controller.processStrategy(liveData, WALLBOX_IP);

    // Filter: only "ena 0" commands (report 2/3 are expected)
    const enaZeroCommands = udp.commands.filter(c => c === "ena 0");

    // BUG: On unfixed code, ensureWallboxDisabled blindly sends "ena 0"
    // FIX: Should skip because Enable sys is already 0
    expect(enaZeroCommands).toHaveLength(0);
  });

  // Test 2: Enable sys: 1 → ensureWallboxDisabled MUST send ena 0
  it("should send ena 0 when Enable sys is 1 (wallbox stuck enabled)", async () => {
    // Wallbox stuck enabled: Enable sys = 1, State = 2, not charging
    udp.setEnableSys(1);

    const liveData = makeLiveData({ pvPower: 500, housePower: 800 }); // Low surplus → no start
    await controller.processStrategy(liveData, WALLBOX_IP);

    const enaZeroCommands = udp.commands.filter(c => c === "ena 0");
    expect(enaZeroCommands.length).toBeGreaterThanOrEqual(1);
  });

  // Test 3: Multiple reconcile cycles with Enable sys: 0 → no ena 0 at all
  it("should NOT send ena 0 across multiple reconcile cycles when Enable sys stays 0", async () => {
    udp.setEnableSys(0);
    const liveData = makeLiveData({ pvPower: 500, housePower: 800 });

    // Simulate 5 poll cycles
    for (let i = 0; i < 5; i++) {
      await controller.processStrategy(liveData, WALLBOX_IP);
    }

    const enaZeroCommands = udp.commands.filter(c => c === "ena 0");
    expect(enaZeroCommands).toHaveLength(0);
  });

  // Test 4: vehicleFinished event → ena 0 always sent (hardcoded enableSys=1)
  it("should send ena 0 from broadcast-listener vehicleFinished (always, regardless of Enable sys)", async () => {
    // This tests ensureWallboxDisabled called directly with enableSys=1
    // (as broadcast-listener should do for vehicleFinished events)
    udp.setEnableSys(0); // Even if wallbox reports 0, the hardcoded 1 forces send

    await controller.ensureWallboxDisabled(WALLBOX_IP, 1);

    const enaZeroCommands = udp.commands.filter(c => c === "ena 0");
    expect(enaZeroCommands).toHaveLength(1);
  });

  // Test 5: nightCharging active → no ena 0 despite Enable sys: 1
  it("should NOT send ena 0 when nightCharging is active (guard)", async () => {
    udp.setEnableSys(1);
    storage.saveControlState({ nightCharging: true, batteryLock: false });

    await controller.ensureWallboxDisabled(WALLBOX_IP, 1);

    const enaZeroCommands = udp.commands.filter(c => c === "ena 0");
    expect(enaZeroCommands).toHaveLength(0);
  });

  // Test 6: isActive → no ena 0 despite Enable sys: 1
  it("should NOT send ena 0 when charging is active (guard)", async () => {
    udp.setEnableSys(1);
    storage.updateChargingContext({ isActive: true });

    await controller.ensureWallboxDisabled(WALLBOX_IP, 1);

    const enaZeroCommands = udp.commands.filter(c => c === "ena 0");
    expect(enaZeroCommands).toHaveLength(0);
  });

  // Test 7: Max-Power strategy → no ena 0 despite Enable sys: 1
  it("should NOT send ena 0 for max_without_battery strategy (guard)", async () => {
    udp.setEnableSys(1);

    const settings = storage.getSettings()!;
    settings.chargingStrategy!.activeStrategy = "max_without_battery";
    storage.saveSettings(settings);
    storage.updateChargingContext({ strategy: "max_without_battery" });

    await controller.ensureWallboxDisabled(WALLBOX_IP, 1);

    const enaZeroCommands = udp.commands.filter(c => c === "ena 0");
    expect(enaZeroCommands).toHaveLength(0);
  });
});

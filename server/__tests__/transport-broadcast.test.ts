import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

/**
 * Tests for Issue #77: Spontaneous Wallbox broadcasts (E pres) must not be
 * discarded by the transport layer when a report request is pending.
 *
 * The KEBA wallbox sends unsolicited UDP broadcasts like {"E pres": 22444}
 * during charging. These have NO "ID" field (unlike report responses which
 * always have "ID":"1"/"2"/"3"). The transport layer must skip these early
 * so they don't produce misleading "Antwort ignoriert" logs.
 */

const mockLog = vi.fn();
vi.mock("../core/logger", () => ({
  log: (...args: any[]) => mockLog(...args),
}));

// Mock dgram so udp-channel doesn't bind a real socket
const mockBind = vi.fn((_port: number, cb: () => void) => cb());
const mockClose = vi.fn((cb: () => void) => cb());
const mockSend = vi.fn((...args: any[]) => {
  const cb = args[args.length - 1];
  if (typeof cb === "function") cb(null);
});
const mockOn = vi.fn();
const mockOnce = vi.fn();
const mockRemoveListener = vi.fn();
const mockSetBroadcast = vi.fn();

vi.mock("dgram", () => ({
  default: {
    createSocket: vi.fn(() => ({
      bind: mockBind,
      close: mockClose,
      send: mockSend,
      on: mockOn,
      once: mockOnce,
      removeListener: mockRemoveListener,
      setBroadcast: mockSetBroadcast,
    })),
  },
}));

const WALLBOX_IP = "192.168.40.16";
const fakeRinfo = { address: WALLBOX_IP, port: 7090, family: "IPv4" as const, size: 50 };

function makeMsg(data: any, hasId?: boolean) {
  return {
    raw: JSON.stringify(data),
    parsed: data,
    rinfo: fakeRinfo,
    isJson: true,
    hasId: hasId ?? data.ID !== undefined,
    hasTchToken: false,
  };
}

describe("Transport Layer - Broadcast Handling (Issue #77)", () => {
  let wallboxUdpChannel: typeof import("../wallbox/udp-channel").wallboxUdpChannel;
  let sendUdpCommand: typeof import("../wallbox/transport").sendUdpCommand;
  let initWallboxSocket: typeof import("../wallbox/transport").initWallboxSocket;

  beforeEach(async () => {
    vi.clearAllMocks();
    mockLog.mockClear();
    vi.resetModules();

    const channelMod = await import("../wallbox/udp-channel");
    wallboxUdpChannel = channelMod.wallboxUdpChannel;

    const transportMod = await import("../wallbox/transport");
    sendUdpCommand = transportMod.sendUdpCommand;
    initWallboxSocket = transportMod.initWallboxSocket;
  });

  afterEach(async () => {
    try {
      await wallboxUdpChannel.stop();
    } catch {
      // ignore
    }
  });

  it("spontaneous E pres broadcast during pending report 3 must NOT log 'Antwort ignoriert'", async () => {
    await initWallboxSocket();

    // Start report 3 (will timeout, we don't care about result)
    const reportPromise = sendUdpCommand(WALLBOX_IP, "report 3", {
      maxAttempts: 1,
    }).catch(() => {});

    await new Promise((r) => setTimeout(r, 50));

    // Simulate spontaneous broadcast (no ID field!)
    wallboxUdpChannel.emit("message", makeMsg({ "E pres": 22444 }));

    // The transport should NOT have logged "Antwort ignoriert" for a broadcast without ID
    const ignoredLogs = mockLog.mock.calls.filter(
      (c: any[]) =>
        c.some((arg: any) => typeof arg === "string" && arg.includes("Antwort ignoriert")),
    );
    expect(ignoredLogs).toHaveLength(0);

    // Resolve the pending request so the test doesn't hang
    wallboxUdpChannel.emit("message", makeMsg(
      { ID: 3, U1: 230000, I1: 16000, P: 3680000000 },
      true,
    ));

    await reportPromise;
  }, 10000);

  it("report response with ID still resolves pending request correctly", async () => {
    await initWallboxSocket();

    const reportPromise = sendUdpCommand(WALLBOX_IP, "report 2", {
      maxAttempts: 1,
    });

    await new Promise((r) => setTimeout(r, 50));

    const responseData = { ID: 2, State: 3, Plug: 7, "Max curr": 32000, "Enable sys": 1 };
    wallboxUdpChannel.emit("message", makeMsg(responseData, true));

    const result = await reportPromise;
    expect(result.ID).toBe(2);
    expect(result.State).toBe(3);
  }, 10000);

  it("broadcast during pending report does NOT interfere with report resolution", async () => {
    await initWallboxSocket();

    const reportPromise = sendUdpCommand(WALLBOX_IP, "report 3", {
      maxAttempts: 1,
    });

    await new Promise((r) => setTimeout(r, 50));

    // First: spontaneous broadcast (no ID)
    wallboxUdpChannel.emit("message", makeMsg({ "E pres": 22444 }));

    // Then: actual report 3 response (with ID)
    wallboxUdpChannel.emit("message", makeMsg(
      { ID: 3, U1: 230000, I1: 16000, P: 3680000000, "E pres": 22500 },
      true,
    ));

    const result = await reportPromise;
    expect(result.ID).toBe(3);
    expect(result.U1).toBe(230000);
  }, 10000);

  it("multiple broadcasts during pending report are all skipped without 'ignoriert' log", async () => {
    await initWallboxSocket();

    const reportPromise = sendUdpCommand(WALLBOX_IP, "report 2", {
      maxAttempts: 1,
    }).catch(() => {});

    await new Promise((r) => setTimeout(r, 50));

    // Simulate multiple broadcasts (all without ID)
    for (const data of [{ "E pres": 22444 }, { "E pres": 22646 }, { State: 3 }, { "E pres": 22900 }]) {
      wallboxUdpChannel.emit("message", makeMsg(data));
    }

    const ignoredLogs = mockLog.mock.calls.filter(
      (c: any[]) =>
        c.some((arg: any) => typeof arg === "string" && arg.includes("Antwort ignoriert")),
    );
    expect(ignoredLogs).toHaveLength(0);

    // Resolve pending request
    wallboxUdpChannel.emit("message", makeMsg(
      { ID: 2, State: 3, Plug: 7, "Max curr": 32000 },
      true,
    ));

    await reportPromise;
  }, 10000);

  it("State broadcast without ID is not treated as report response", async () => {
    await initWallboxSocket();

    const reportPromise = sendUdpCommand(WALLBOX_IP, "report 2", {
      maxAttempts: 1,
    }).catch(() => {});

    await new Promise((r) => setTimeout(r, 50));

    // State broadcast (no ID) should NOT resolve pending report 2
    wallboxUdpChannel.emit("message", makeMsg({ State: 3 }));

    const ignoredLogs = mockLog.mock.calls.filter(
      (c: any[]) =>
        c.some((arg: any) => typeof arg === "string" && arg.includes("Antwort ignoriert")),
    );
    expect(ignoredLogs).toHaveLength(0);

    // Resolve pending request
    wallboxUdpChannel.emit("message", makeMsg(
      { ID: 2, State: 3, Plug: 7, "Max curr": 32000 },
      true,
    ));

    await reportPromise;
  }, 10000);
});

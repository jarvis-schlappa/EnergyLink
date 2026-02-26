/**
 * SSE Broadcast Content Tests
 *
 * Tests the actual SSE event content (wallbox-status vs wallbox-partial).
 * Uses the REAL sse module (no mocks) to verify what gets sent to clients.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// Only mock the logger (sse.ts imports it)
vi.mock("../core/logger", () => ({
  log: vi.fn(),
}));

import {
  broadcastWallboxStatus,
  broadcastPartialUpdate,
  initSSEClient,
  closeAllSSEClients,
} from "../wallbox/sse";

describe("SSE broadcast content", () => {
  let writtenData: string[];
  let mockRes: any;

  beforeEach(() => {
    // Disconnect all clients from prior tests
    closeAllSSEClients();

    writtenData = [];
    mockRes = {
      setHeader: vi.fn(),
      write: vi.fn((data: string) => writtenData.push(data)),
      on: vi.fn(),
      end: vi.fn(),
    };
    initSSEClient(mockRes);
    // Clear the initial `:ok\n\n` write
    writtenData = [];
  });

  it("broadcastWallboxStatus sends complete wallbox-status event", () => {
    const fullStatus = {
      state: 3,
      plug: 7,
      enableSys: 1,
      maxCurr: 16,
      ePres: 5000,
      eTotal: 100000,
      power: 3.68,
      phases: 1,
      i1: 16,
      i2: 0,
      i3: 0,
      lastUpdated: "2026-02-26T13:00:00.000Z",
    };

    broadcastWallboxStatus(fullStatus);

    const dataEvents = writtenData.filter((d) => d.startsWith("data:"));
    expect(dataEvents).toHaveLength(1);

    const parsed = JSON.parse(dataEvents[0].replace("data: ", "").trim());
    expect(parsed.type).toBe("wallbox-status");
    expect(parsed.data.state).toBe(3);
    expect(parsed.data.plug).toBe(7);
    expect(parsed.data.power).toBe(3.68);
    expect(parsed.data.phases).toBe(1);
  });

  it("broadcastPartialUpdate for state sends wallbox-partial WITHOUT plug", () => {
    // This is how the broadcast-listener calls it on State change
    broadcastPartialUpdate({ state: 3 });

    const dataEvents = writtenData.filter((d) => d.startsWith("data:"));
    expect(dataEvents).toHaveLength(1);

    const parsed = JSON.parse(dataEvents[0].replace("data: ", "").trim());
    expect(parsed.type).toBe("wallbox-partial");
    expect(parsed.data.state).toBe(3);
    expect(parsed.data).not.toHaveProperty("plug"); // ← key missing
    expect(parsed.data).toHaveProperty("lastUpdated"); // auto-added
  });

  it("broadcastPartialUpdate for ePres sends wallbox-partial WITHOUT plug or state", () => {
    // This is how the broadcast-listener calls it on E pres change
    broadcastPartialUpdate({ ePres: 5000 });

    const dataEvents = writtenData.filter((d) => d.startsWith("data:"));
    expect(dataEvents).toHaveLength(1);

    const parsed = JSON.parse(dataEvents[0].replace("data: ", "").trim());
    expect(parsed.type).toBe("wallbox-partial");
    expect(parsed.data.ePres).toBe(5000);
    expect(parsed.data).not.toHaveProperty("plug");
    expect(parsed.data).not.toHaveProperty("state");
  });

  it("broadcastPartialUpdate from strategy controller includes state + enableSys but NOT plug", () => {
    // This is how the charging-strategy-controller calls it
    broadcastPartialUpdate({ state: 3, enableSys: 1 });

    const dataEvents = writtenData.filter((d) => d.startsWith("data:"));
    expect(dataEvents).toHaveLength(1);

    const parsed = JSON.parse(dataEvents[0].replace("data: ", "").trim());
    expect(parsed.data.state).toBe(3);
    expect(parsed.data.enableSys).toBe(1);
    expect(parsed.data).not.toHaveProperty("plug"); // ← still missing
  });

  it("multiple full broadcasts each arrive as separate events", () => {
    broadcastWallboxStatus({ state: 2, plug: 3, enableSys: 0, maxCurr: 16, ePres: 0, eTotal: 0, power: 0 });
    broadcastWallboxStatus({ state: 3, plug: 7, enableSys: 1, maxCurr: 16, ePres: 100, eTotal: 500, power: 3.68 });

    const dataEvents = writtenData.filter((d) => d.startsWith("data:"));
    expect(dataEvents).toHaveLength(2);

    const first = JSON.parse(dataEvents[0].replace("data: ", "").trim());
    const second = JSON.parse(dataEvents[1].replace("data: ", "").trim());
    expect(first.data.plug).toBe(3);
    expect(second.data.plug).toBe(7);
  });
});

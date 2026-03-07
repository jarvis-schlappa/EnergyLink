// @vitest-environment jsdom
/**
 * Frontend SSE Hook Tests
 *
 * Tests the behavior of useWallboxSSE when receiving different SSE event types.
 * Verifies that partial updates merge correctly and don't lose fields.
 */

import React from "react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act } from "@testing-library/react";

// We need to mock EventSource since jsdom doesn't support it
class MockEventSource {
  static instances: MockEventSource[] = [];
  url: string;
  onopen: ((event: any) => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: ((event: any) => void) | null = null;
  readyState = 0; // CONNECTING

  constructor(url: string) {
    this.url = url;
    MockEventSource.instances.push(this);
    // Auto-open on next tick
    setTimeout(() => {
      this.readyState = 1; // OPEN
      this.onopen?.({});
    }, 0);
  }

  close() {
    this.readyState = 2; // CLOSED
  }

  // Helper: simulate receiving an SSE message
  simulateMessage(data: any) {
    this.onmessage?.(new MessageEvent("message", { data: JSON.stringify(data) }));
  }
}

// Install mock EventSource globally
(globalThis as any).EventSource = MockEventSource;

import { useWallboxSSE } from "@/hooks/use-wallbox-sse";

describe("useWallboxSSE hook", () => {
  beforeEach(() => {
    MockEventSource.instances = [];
  });

  afterEach(() => {
    MockEventSource.instances.forEach((es) => es.close());
    MockEventSource.instances = [];
  });

  it("returns null status initially", () => {
    const { result } = renderHook(() => useWallboxSSE());
    expect(result.current.status).toBeNull();
  });

  it("updates status on wallbox-status (full) event", async () => {
    const { result } = renderHook(() => useWallboxSSE());

    // Wait for EventSource to be created
    await act(async () => {
      await new Promise((r) => setTimeout(r, 10));
    });

    const es = MockEventSource.instances[0];
    expect(es).toBeDefined();

    const fullStatus = {
      type: "wallbox-status",
      data: {
        state: 3,
        plug: 7,
        enableSys: 1,
        maxCurr: 16,
        ePres: 5000,
        eTotal: 100000,
        power: 3.68,
        phases: 1,
        lastUpdated: "2026-02-26T13:00:00.000Z",
      },
    };

    act(() => {
      es.simulateMessage(fullStatus);
    });

    expect(result.current.status).not.toBeNull();
    expect(result.current.status!.state).toBe(3);
    expect(result.current.status!.plug).toBe(7);
    expect(result.current.status!.power).toBe(3.68);
  });

  it("merges partial update without losing existing fields", async () => {
    const { result } = renderHook(() => useWallboxSSE());

    await act(async () => {
      await new Promise((r) => setTimeout(r, 10));
    });

    const es = MockEventSource.instances[0];

    // Step 1: Full status with plug=7
    act(() => {
      es.simulateMessage({
        type: "wallbox-status",
        data: {
          state: 2,
          plug: 7,
          enableSys: 1,
          maxCurr: 16,
          ePres: 0,
          eTotal: 100000,
          power: 0,
          phases: 0,
          lastUpdated: "2026-02-26T13:00:00.000Z",
        },
      });
    });

    expect(result.current.status!.plug).toBe(7);
    expect(result.current.status!.state).toBe(2);

    // Step 2: Partial update – only state changes (no plug field!)
    act(() => {
      es.simulateMessage({
        type: "wallbox-partial",
        data: {
          state: 3,
          lastUpdated: "2026-02-26T13:00:01.000Z",
        },
      });
    });

    // State should be updated
    expect(result.current.status!.state).toBe(3);
    // Plug should be PRESERVED (not lost or zeroed)
    expect(result.current.status!.plug).toBe(7);
    // Other fields should also be preserved
    expect(result.current.status!.maxCurr).toBe(16);
    expect(result.current.status!.eTotal).toBe(100000);
  });

  it("merges ePres partial update without losing plug or state", async () => {
    const { result } = renderHook(() => useWallboxSSE());

    await act(async () => {
      await new Promise((r) => setTimeout(r, 10));
    });

    const es = MockEventSource.instances[0];

    // Full status
    act(() => {
      es.simulateMessage({
        type: "wallbox-status",
        data: {
          state: 3,
          plug: 7,
          enableSys: 1,
          maxCurr: 16,
          ePres: 1000,
          eTotal: 100000,
          power: 3.68,
          phases: 1,
          lastUpdated: "2026-02-26T13:00:00.000Z",
        },
      });
    });

    // Partial: only ePres changes
    act(() => {
      es.simulateMessage({
        type: "wallbox-partial",
        data: {
          ePres: 1500,
          lastUpdated: "2026-02-26T13:00:02.000Z",
        },
      });
    });

    expect(result.current.status!.ePres).toBe(1500);
    expect(result.current.status!.plug).toBe(7); // preserved
    expect(result.current.status!.state).toBe(3); // preserved
    expect(result.current.status!.power).toBe(3.68); // preserved
  });

  it("partial update before any full status returns null (no crash)", async () => {
    const { result } = renderHook(() => useWallboxSSE());

    await act(async () => {
      await new Promise((r) => setTimeout(r, 10));
    });

    const es = MockEventSource.instances[0];

    // Partial update without prior full status
    act(() => {
      es.simulateMessage({
        type: "wallbox-partial",
        data: {
          state: 3,
          lastUpdated: "2026-02-26T13:00:00.000Z",
        },
      });
    });

    // Should remain null (no crash, no partial-only state)
    expect(result.current.status).toBeNull();
  });

  it("full status after partial overwrites everything", async () => {
    const { result } = renderHook(() => useWallboxSSE());

    await act(async () => {
      await new Promise((r) => setTimeout(r, 10));
    });

    const es = MockEventSource.instances[0];

    // First: full status
    act(() => {
      es.simulateMessage({
        type: "wallbox-status",
        data: {
          state: 3,
          plug: 7,
          enableSys: 1,
          maxCurr: 16,
          ePres: 5000,
          eTotal: 100000,
          power: 3.68,
          phases: 1,
          lastUpdated: "2026-02-26T13:00:00.000Z",
        },
      });
    });

    // Partial: state changes
    act(() => {
      es.simulateMessage({
        type: "wallbox-partial",
        data: { state: 5, lastUpdated: "2026-02-26T13:00:01.000Z" },
      });
    });
    expect(result.current.status!.state).toBe(5);

    // New full status: everything gets replaced
    act(() => {
      es.simulateMessage({
        type: "wallbox-status",
        data: {
          state: 2,
          plug: 3,
          enableSys: 0,
          maxCurr: 16,
          ePres: 0,
          eTotal: 100000,
          power: 0,
          phases: 0,
          lastUpdated: "2026-02-26T13:00:05.000Z",
        },
      });
    });

    expect(result.current.status!.state).toBe(2);
    expect(result.current.status!.plug).toBe(3);
    expect(result.current.status!.power).toBe(0);
  });

  it("calls onStatusUpdate callback for full and partial events", async () => {
    const onStatusUpdate = vi.fn();
    const { result } = renderHook(() =>
      useWallboxSSE({ onStatusUpdate })
    );

    await act(async () => {
      await new Promise((r) => setTimeout(r, 10));
    });

    const es = MockEventSource.instances[0];

    // Full status
    act(() => {
      es.simulateMessage({
        type: "wallbox-status",
        data: {
          state: 3,
          plug: 7,
          enableSys: 1,
          maxCurr: 16,
          ePres: 0,
          eTotal: 0,
          power: 3.68,
          phases: 1,
          lastUpdated: "2026-02-26T13:00:00.000Z",
        },
      });
    });

    expect(onStatusUpdate).toHaveBeenCalledTimes(1);
    expect(onStatusUpdate.mock.calls[0][0].plug).toBe(7);

    // Partial update
    act(() => {
      es.simulateMessage({
        type: "wallbox-partial",
        data: { state: 5, lastUpdated: "2026-02-26T13:00:01.000Z" },
      });
    });

    expect(onStatusUpdate).toHaveBeenCalledTimes(2);
    // Callback receives MERGED status (not just the partial)
    expect(onStatusUpdate.mock.calls[1][0].state).toBe(5);
    expect(onStatusUpdate.mock.calls[1][0].plug).toBe(7); // preserved in merge
  });

  it("sets isConnected to true after EventSource opens", async () => {
    const { result } = renderHook(() => useWallboxSSE());

    // Before open
    expect(result.current.isConnected).toBe(false);

    // Wait for auto-open
    await act(async () => {
      await new Promise((r) => setTimeout(r, 10));
    });

    expect(result.current.isConnected).toBe(true);
  });

  it("calls onSmartBufferUpdate callback on smart-buffer-status events", async () => {
    const onSmartBufferUpdate = vi.fn();
    renderHook(() => useWallboxSSE({ onSmartBufferUpdate }));

    await act(async () => {
      await new Promise((r) => setTimeout(r, 10));
    });

    const es = MockEventSource.instances[0];

    act(() => {
      es.simulateMessage({
        type: "smart-buffer-status",
        data: {
          enabled: true,
          phase: "CLIPPING_GUARD",
          soc: 55,
          targetSoc: 100,
          regelzeitEnde: "2026-03-07T16:40:00.000Z",
          targetChargePowerWatt: 1200,
          batteryChargeLimitWatt: 2000,
          forecastKwh: 12.4,
          actualKwh: 4.1,
          feedInWatt: 4420,
          phaseChanges: [],
        },
      });
    });

    expect(onSmartBufferUpdate).toHaveBeenCalledTimes(1);
    expect(onSmartBufferUpdate.mock.calls[0][0].phase).toBe("CLIPPING_GUARD");
    expect(onSmartBufferUpdate.mock.calls[0][0].targetChargePowerWatt).toBe(1200);
  });

  it("does not change wallbox status when receiving smart-buffer-status", async () => {
    const { result } = renderHook(() => useWallboxSSE());

    await act(async () => {
      await new Promise((r) => setTimeout(r, 10));
    });

    const es = MockEventSource.instances[0];

    act(() => {
      es.simulateMessage({
        type: "wallbox-status",
        data: {
          state: 3,
          plug: 7,
          enableSys: 1,
          maxCurr: 16,
          ePres: 5000,
          eTotal: 100000,
          power: 3.68,
          phases: 1,
          lastUpdated: "2026-02-26T13:00:00.000Z",
        },
      });
    });

    expect(result.current.status?.state).toBe(3);
    expect(result.current.status?.plug).toBe(7);

    act(() => {
      es.simulateMessage({
        type: "smart-buffer-status",
        data: {
          enabled: true,
          phase: "FILL_UP",
          soc: 61,
          targetSoc: 100,
          regelzeitEnde: "2026-03-07T16:40:00.000Z",
          targetChargePowerWatt: 1800,
          batteryChargeLimitWatt: 1800,
          forecastKwh: 14.2,
          actualKwh: 5.3,
          feedInWatt: 3200,
          phaseChanges: [],
        },
      });
    });

    expect(result.current.status?.state).toBe(3);
    expect(result.current.status?.plug).toBe(7);
    expect(result.current.status?.power).toBe(3.68);
  });
});

import { describe, it, expect, vi } from "vitest";

vi.mock("../core/logger", () => ({
  log: vi.fn(),
}));

describe("Graceful Shutdown (Issue #82)", () => {
  it("closeAllSSEClients should close all connected clients", async () => {
    // Import the real module (not mocked)
    const { initSSEClient, getConnectedClientCount, closeAllSSEClients } = await import("../wallbox/sse");

    // Create a mock response
    const mockRes = {
      setHeader: vi.fn(),
      write: vi.fn(),
      end: vi.fn(),
      on: vi.fn(),
    } as any;

    // Connect a client
    initSSEClient(mockRes);
    expect(getConnectedClientCount()).toBe(1);

    // Close all
    closeAllSSEClients();
    expect(getConnectedClientCount()).toBe(0);

    // Should have sent shutdown event
    expect(mockRes.write).toHaveBeenCalledWith(expect.stringContaining("shutdown"));
    expect(mockRes.end).toHaveBeenCalled();
  });

  it("closeAllSSEClients should handle already disconnected clients gracefully", async () => {
    const { initSSEClient, closeAllSSEClients, getConnectedClientCount } = await import("../wallbox/sse");

    let callCount = 0;
    const mockRes = {
      setHeader: vi.fn(),
      write: vi.fn().mockImplementation(() => {
        callCount++;
        // First call succeeds (initSSEClient keep-alive), subsequent calls fail
        if (callCount > 1) throw new Error("write after end");
      }),
      end: vi.fn(),
      on: vi.fn(),
    } as any;

    initSSEClient(mockRes);

    // Should not throw even if write fails during close
    expect(() => closeAllSSEClients()).not.toThrow();
    expect(getConnectedClientCount()).toBe(0);
  });
});

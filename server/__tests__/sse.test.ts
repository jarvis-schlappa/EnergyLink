import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

/**
 * Tests for SSE (Server-Sent Events) manager.
 * Tests client connect/disconnect and broadcast to all clients.
 */

vi.mock("../core/logger", () => ({
  log: vi.fn(),
}));

describe("SSE Manager", () => {
  let initSSEClient: typeof import("../wallbox/sse").initSSEClient;
  let broadcastWallboxStatus: typeof import("../wallbox/sse").broadcastWallboxStatus;
  let broadcastPartialUpdate: typeof import("../wallbox/sse").broadcastPartialUpdate;
  let getConnectedClientCount: typeof import("../wallbox/sse").getConnectedClientCount;
  let closeAllSSEClients: typeof import("../wallbox/sse").closeAllSSEClients;

  function createMockResponse() {
    const closeHandlers: Function[] = [];
    return {
      setHeader: vi.fn(),
      write: vi.fn().mockReturnValue(true),
      end: vi.fn(),
      on: vi.fn((event: string, handler: Function) => {
        if (event === "close") closeHandlers.push(handler);
      }),
      _triggerClose: () => closeHandlers.forEach(h => h()),
    };
  }

  beforeEach(async () => {
    vi.clearAllMocks();
    vi.resetModules();
    const mod = await import("../wallbox/sse");
    initSSEClient = mod.initSSEClient;
    broadcastWallboxStatus = mod.broadcastWallboxStatus;
    broadcastPartialUpdate = mod.broadcastPartialUpdate;
    getConnectedClientCount = mod.getConnectedClientCount;
    closeAllSSEClients = mod.closeAllSSEClients;
  });

  afterEach(() => {
    closeAllSSEClients();
  });

  describe("Client Connect", () => {
    it("returns a client ID", () => {
      const res = createMockResponse();
      const id = initSSEClient(res as any);
      expect(id).toBeTruthy();
      expect(typeof id).toBe("string");
    });

    it("sets SSE headers", () => {
      const res = createMockResponse();
      initSSEClient(res as any);
      expect(res.setHeader).toHaveBeenCalledWith("Content-Type", "text/event-stream");
      expect(res.setHeader).toHaveBeenCalledWith("Cache-Control", "no-cache");
      expect(res.setHeader).toHaveBeenCalledWith("Connection", "keep-alive");
    });

    it("sends initial keep-alive", () => {
      const res = createMockResponse();
      initSSEClient(res as any);
      expect(res.write).toHaveBeenCalledWith(`:ok\n\n`);
    });

    it("increments client count", () => {
      const res1 = createMockResponse();
      const res2 = createMockResponse();
      expect(getConnectedClientCount()).toBe(0);
      initSSEClient(res1 as any);
      expect(getConnectedClientCount()).toBe(1);
      initSSEClient(res2 as any);
      expect(getConnectedClientCount()).toBe(2);
    });
  });

  describe("Client Disconnect", () => {
    it("removes client on close event", () => {
      const res = createMockResponse();
      initSSEClient(res as any);
      expect(getConnectedClientCount()).toBe(1);
      res._triggerClose();
      expect(getConnectedClientCount()).toBe(0);
    });

    it("handles multiple disconnects correctly", () => {
      const res1 = createMockResponse();
      const res2 = createMockResponse();
      initSSEClient(res1 as any);
      initSSEClient(res2 as any);
      expect(getConnectedClientCount()).toBe(2);
      res1._triggerClose();
      expect(getConnectedClientCount()).toBe(1);
      res2._triggerClose();
      expect(getConnectedClientCount()).toBe(0);
    });
  });

  describe("Broadcast to all clients", () => {
    it("sends status to all connected clients", () => {
      const res1 = createMockResponse();
      const res2 = createMockResponse();
      initSSEClient(res1 as any);
      initSSEClient(res2 as any);

      broadcastWallboxStatus({ state: 3, plug: 7 } as any);

      // Both: initial :ok + broadcast data
      expect(res1.write).toHaveBeenCalledTimes(2);
      expect(res2.write).toHaveBeenCalledTimes(2);

      const lastCall1 = res1.write.mock.calls[1][0];
      expect(lastCall1).toContain("wallbox-status");
      expect(lastCall1).toContain("data:");
    });

    it("does nothing when no clients connected", () => {
      broadcastWallboxStatus({ state: 2 } as any);
    });

    it("removes failed clients on broadcast error", () => {
      const res1 = createMockResponse();
      const res2 = createMockResponse();
      initSSEClient(res1 as any);
      initSSEClient(res2 as any);

      // initial :ok already happened, next write will throw
      res1.write.mockImplementationOnce(() => { throw new Error("connection reset"); });

      broadcastWallboxStatus({ state: 3 } as any);
      expect(getConnectedClientCount()).toBe(1);
    });
  });

  describe("Partial Update Broadcast", () => {
    it("sends partial update with correct type", () => {
      const res = createMockResponse();
      initSSEClient(res as any);

      broadcastPartialUpdate({ state: 3 } as any);

      const lastCall = res.write.mock.calls[1][0];
      expect(lastCall).toContain("wallbox-partial");
    });
  });

  describe("closeAllSSEClients", () => {
    it("closes all clients and sends shutdown event", () => {
      const res1 = createMockResponse();
      const res2 = createMockResponse();
      initSSEClient(res1 as any);
      initSSEClient(res2 as any);

      closeAllSSEClients();

      expect(getConnectedClientCount()).toBe(0);
      const shutdownWrite1 = res1.write.mock.calls.find(
        (c: any[]) => c[0]?.includes?.("shutdown")
      );
      expect(shutdownWrite1).toBeTruthy();
      expect(res1.end).toHaveBeenCalled();
      expect(res2.end).toHaveBeenCalled();
    });
  });
});

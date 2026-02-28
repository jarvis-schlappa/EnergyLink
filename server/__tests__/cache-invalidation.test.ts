import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../routes/wallbox-routes", () => ({
  resetStatusPollThrottle: vi.fn(),
}));

vi.mock("../e3dc/poller", () => ({
  resetWallboxIdleThrottle: vi.fn(),
}));

describe("invalidateWallboxCaches()", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("calls both resetStatusPollThrottle and resetWallboxIdleThrottle", async () => {
    const { invalidateWallboxCaches } = await import("../wallbox/cache-invalidation");
    const { resetStatusPollThrottle } = await import("../routes/wallbox-routes");
    const { resetWallboxIdleThrottle } = await import("../e3dc/poller");

    invalidateWallboxCaches();
    expect(resetStatusPollThrottle).toHaveBeenCalledTimes(1);
    expect(resetWallboxIdleThrottle).toHaveBeenCalledTimes(1);
  });

  it("can be called multiple times without error", async () => {
    const { invalidateWallboxCaches } = await import("../wallbox/cache-invalidation");
    const { resetStatusPollThrottle } = await import("../routes/wallbox-routes");
    const { resetWallboxIdleThrottle } = await import("../e3dc/poller");

    invalidateWallboxCaches();
    invalidateWallboxCaches();
    invalidateWallboxCaches();
    expect(resetStatusPollThrottle).toHaveBeenCalledTimes(3);
    expect(resetWallboxIdleThrottle).toHaveBeenCalledTimes(3);
  });
});

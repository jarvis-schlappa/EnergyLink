import { describe, it, expect, beforeEach } from "vitest";
import {
  getOrCreateStrategyController,
  setStrategyController,
} from "../routes/shared-state";

describe("ChargingStrategyController Singleton", () => {
  beforeEach(() => {
    // Reset to null before each test
    setStrategyController(null);
  });

  it("should return the same instance on multiple calls", () => {
    const first = getOrCreateStrategyController();
    const second = getOrCreateStrategyController();
    expect(first).toBe(second);
  });

  it("should create a new instance after explicit reset", () => {
    const first = getOrCreateStrategyController();
    setStrategyController(null);
    const second = getOrCreateStrategyController();
    expect(first).not.toBe(second);
  });
});

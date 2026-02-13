import { describe, it, expect, vi } from "vitest";
import type { Request, Response, NextFunction } from "express";

// Extract the error handler logic to test it in isolation
// This mirrors the error handler in server/index.ts
function errorHandler(err: any, _req: Request, res: Response, _next: NextFunction) {
  const status = err.status || err.statusCode || 500;
  const message = err.message || "Internal Server Error";
  res.status(status).json({ message });
}

describe("Express error handler", () => {
  function createMocks() {
    const req = {} as Request;
    const res = {
      status: vi.fn().mockReturnThis(),
      json: vi.fn().mockReturnThis(),
    } as unknown as Response;
    const next = vi.fn() as NextFunction;
    return { req, res, next };
  }

  it("should respond with error status and message without throwing", () => {
    const { req, res, next } = createMocks();
    const err = { status: 400, message: "Bad Request" };

    // Must not throw
    expect(() => errorHandler(err, req, res, next)).not.toThrow();
    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith({ message: "Bad Request" });
  });

  it("should default to 500 and generic message", () => {
    const { req, res, next } = createMocks();

    expect(() => errorHandler({}, req, res, next)).not.toThrow();
    expect(res.status).toHaveBeenCalledWith(500);
    expect(res.json).toHaveBeenCalledWith({ message: "Internal Server Error" });
  });

  it("should use statusCode if status is not set", () => {
    const { req, res, next } = createMocks();
    const err = { statusCode: 404, message: "Not Found" };

    expect(() => errorHandler(err, req, res, next)).not.toThrow();
    expect(res.status).toHaveBeenCalledWith(404);
  });

  it("should not leak stack traces to the client", () => {
    const { req, res, next } = createMocks();
    const err = new Error("something broke");
    (err as any).status = 500;

    errorHandler(err, req, res, next);
    const jsonArg = (res.json as any).mock.calls[0][0];
    expect(jsonArg).not.toHaveProperty("stack");
    expect(jsonArg).toEqual({ message: "something broke" });
  });
});

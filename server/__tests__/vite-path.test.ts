import { describe, it, expect } from "vitest";
import path from "path";
import fs from "fs";

describe("vite.ts index.html path", () => {
  it("should resolve client/index.html from server/core/ correctly", () => {
    // This is the path logic from server/core/vite.ts setupVite()
    const serverCorePath = path.resolve(__dirname, "..", "core");
    const clientTemplate = path.resolve(
      serverCorePath,
      "..",
      "..",
      "client",
      "index.html",
    );

    expect(fs.existsSync(clientTemplate)).toBe(true);
    expect(clientTemplate).toContain(
      path.join("client", "index.html"),
    );
    // Must NOT resolve to server/client/index.html
    expect(clientTemplate).not.toContain(
      path.join("server", "client", "index.html"),
    );
  });
});

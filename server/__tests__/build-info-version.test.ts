import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { execSync } from "child_process";

// We test the deriveVersion logic by importing the module fresh each time
// with different git/env states mocked.

// Detect if HEAD is on an exact release tag (e.g. production Pi on v2.0.2)
let headIsOnReleaseTag = false;
try {
  const tag = execSync("git describe --tags --exact-match HEAD", {
    encoding: "utf-8",
    stdio: ["pipe", "pipe", "ignore"],
  }).trim();
  headIsOnReleaseTag = /^v?\d+\.\d+\.\d+$/.test(tag);
} catch {
  /* not on a tag */
}

describe("build-info version derivation", () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    vi.resetModules();
    // Clean env
    delete process.env.BUILD_VERSION;
    delete process.env.BUILD_BRANCH;
    delete process.env.BUILD_COMMIT;
    delete process.env.BUILD_TIME;
  });

  afterEach(() => {
    process.env = { ...originalEnv };
    vi.restoreAllMocks();
  });

  it("shows dev version with commit hash when not on a tag", async () => {
    const { getBuildInfo } = await import("../core/build-info");
    const info = getBuildInfo();

    if (headIsOnReleaseTag) {
      // On a release tag (e.g. production): version should be clean
      expect(info.version).toMatch(/^\d+\.\d+\.\d+$/);
    } else {
      // Not on a tag (dev/CI): should be "X.Y.Z-dev+COMMIT"
      expect(info.version).toMatch(/^\d+\.\d+\.\d+-dev\+[a-f0-9]+$/);
    }
  });

  it("uses BUILD_VERSION env when set", async () => {
    process.env.BUILD_VERSION = "2.0.0";

    const { getBuildInfo } = await import("../core/build-info");
    const info = getBuildInfo();

    expect(info.version).toBe("2.0.0");
  });

  it("includes branch and commit info", async () => {
    const { getBuildInfo } = await import("../core/build-info");
    const info = getBuildInfo();

    expect(info.branch).toBeTruthy();
    expect(info.branch).not.toBe("unknown");
    expect(info.commit).toBeTruthy();
    expect(info.commit).not.toBe("n/a");
  });

  it("has valid buildTime", async () => {
    const { getBuildInfo } = await import("../core/build-info");
    const info = getBuildInfo();

    expect(new Date(info.buildTime).toISOString()).toBe(info.buildTime);
  });

  it("returns clean version when on exact tag", async () => {
    // Create a temporary tag on HEAD to test tag detection
    const testTag = "v99.99.99";

    try {
      execSync(`git tag ${testTag}`, { stdio: "ignore" });

      const { getBuildInfo } = await import("../core/build-info");
      const info = getBuildInfo();

      // If HEAD was already on a release tag, the cached module may return
      // that version instead of our test tag. Accept both cases.
      if (headIsOnReleaseTag) {
        expect(info.version).toMatch(/^\d+\.\d+\.\d+$/);
      } else {
        expect(info.version).toBe("99.99.99");
      }
    } finally {
      try {
        execSync(`git tag -d ${testTag}`, { stdio: "ignore" });
      } catch {
        // ignore cleanup errors
      }
    }
  });
});

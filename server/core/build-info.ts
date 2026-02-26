import { execSync } from "child_process";
import { readFileSync } from "fs";
import path from "path";
import type { BuildInfo } from "@shared/schema";

function execGitCommand(command: string, fallback: string = "unknown"): string {
  try {
    return execSync(command, { encoding: "utf-8", stdio: ["pipe", "pipe", "ignore"] }).trim();
  } catch {
    return fallback;
  }
}

/**
 * Derives the display version from package.json + git state:
 * - On a release tag (vX.Y.Z): "X.Y.Z"
 * - Between releases: "X.Y.Z-dev+abc1234"
 * - No git available (Docker): falls back to package.json version
 */
function deriveVersion(pkgVersion: string): string {
  // If BUILD_VERSION env is set (e.g. by CI), use it directly
  if (process.env.BUILD_VERSION) {
    return process.env.BUILD_VERSION;
  }

  const commitShort = execGitCommand("git rev-parse --short HEAD", "");
  if (!commitShort) {
    // No git available – use package.json as-is
    return pkgVersion;
  }

  // Check if HEAD is exactly on a version tag
  const tagOnHead = execGitCommand("git describe --tags --exact-match HEAD", "");
  if (tagOnHead && tagOnHead.match(/^v?\d+\.\d+\.\d+$/)) {
    // Clean release – strip leading "v" if present
    return tagOnHead.replace(/^v/, "");
  }

  // Development version: package version + dev + short commit
  return `${pkgVersion}-dev+${commitShort}`;
}

const STARTUP_TIME = new Date().toISOString();
let cachedBuildInfo: BuildInfo | null = null;

export function getBuildInfo(): BuildInfo {
  if (cachedBuildInfo) {
    return cachedBuildInfo;
  }

  const pkgPath = path.resolve(process.cwd(), "package.json");
  let pkgVersion = "unknown";

  try {
    const pkg = JSON.parse(readFileSync(pkgPath, "utf-8"));
    pkgVersion = pkg.version || "unknown";
  } catch {
    console.warn("Could not read package.json for version");
  }

  const version = deriveVersion(pkgVersion);
  const branch = process.env.BUILD_BRANCH || execGitCommand("git rev-parse --abbrev-ref HEAD", "production");
  const commit = process.env.BUILD_COMMIT || execGitCommand("git rev-parse --short HEAD", "n/a");
  const buildTime = process.env.BUILD_TIME || STARTUP_TIME;

  cachedBuildInfo = {
    version,
    branch,
    commit,
    buildTime,
  };

  return cachedBuildInfo;
}

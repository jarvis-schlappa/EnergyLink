import { execSync } from "child_process";
import { readFileSync } from "fs";
import path from "path";
import type { BuildInfo } from "@shared/schema";

function execGitCommand(command: string, fallback: string = "production"): string {
  if (process.env.NODE_ENV === "production") {
    return fallback;
  }
  
  try {
    return execSync(command, { encoding: "utf-8", stdio: ["pipe", "pipe", "ignore"] }).trim();
  } catch {
    return fallback;
  }
}

const STARTUP_TIME = new Date().toISOString();
let cachedBuildInfo: BuildInfo | null = null;

export function getBuildInfo(): BuildInfo {
  if (cachedBuildInfo) {
    return cachedBuildInfo;
  }

  const pkgPath = path.resolve(process.cwd(), "package.json");
  let version = "unknown";

  try {
    const pkg = JSON.parse(readFileSync(pkgPath, "utf-8"));
    version = pkg.version || "unknown";
  } catch {
    console.warn("Could not read package.json for version");
  }

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

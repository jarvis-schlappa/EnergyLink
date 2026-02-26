import { Plugin } from 'vite';
import { execSync } from 'child_process';
import { readFileSync } from 'fs';
import path from 'path';

function execGitCommand(command: string, fallback: string = 'unknown'): string {
  try {
    return execSync(command, { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'ignore'] }).trim();
  } catch {
    return fallback;
  }
}

function deriveVersion(pkgVersion: string): string {
  if (process.env.BUILD_VERSION) {
    return process.env.BUILD_VERSION;
  }

  const commitShort = execGitCommand('git rev-parse --short HEAD', '');
  if (!commitShort) {
    return pkgVersion;
  }

  const tagOnHead = execGitCommand('git describe --tags --exact-match HEAD', '');
  if (tagOnHead && tagOnHead.match(/^v?\d+\.\d+\.\d+$/)) {
    return tagOnHead.replace(/^v/, '');
  }

  return `${pkgVersion}-dev+${commitShort}`;
}

export function buildInfoPlugin(): Plugin {
  return {
    name: 'vite-plugin-build-info',
    config() {
      const pkgPath = path.resolve(process.cwd(), 'package.json');
      let pkgVersion = 'unknown';
      
      try {
        const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'));
        pkgVersion = pkg.version || 'unknown';
      } catch {
        console.warn('Could not read package.json for version');
      }

      const version = deriveVersion(pkgVersion);
      const gitBranch = execGitCommand('git rev-parse --abbrev-ref HEAD', 'unknown');
      const gitCommit = execGitCommand('git rev-parse --short HEAD', 'unknown');
      const buildTime = new Date().toISOString();

      return {
        define: {
          'import.meta.env.VITE_BUILD_VERSION': JSON.stringify(version),
          'import.meta.env.VITE_BUILD_BRANCH': JSON.stringify(gitBranch),
          'import.meta.env.VITE_BUILD_COMMIT': JSON.stringify(gitCommit),
          'import.meta.env.VITE_BUILD_TIME': JSON.stringify(buildTime),
        },
      };
    },
  };
}

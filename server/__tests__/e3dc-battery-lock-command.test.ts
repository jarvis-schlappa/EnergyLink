/**
 * Tests für Issue #69: E3DC Battery Lock Command schlägt fehl weil
 * der volle Pfad zum e3dcset-Binary fehlt.
 *
 * Root Cause: Wenn der Demo-Modus deaktiviert wird, wird
 * `e3dcClient.setGateway(new RealE3dcGateway())` ohne anschließendes
 * `configure()` aufgerufen. Das neue Gateway hat keinen Prefix gesetzt,
 * weshalb der Befehl nur als "-d 0" ausgeführt wird (ohne Pfad zu e3dcset).
 * /bin/sh interpretiert "-d" dann als Shell-Option → Fehler.
 *
 * Fix: `E3dcClient.setGateway()` muss bei RealE3dcGateway den Prefix aus
 * der bestehenden Konfiguration wiederherstellen.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Mocks (müssen vor imports stehen) ────────────────────────────────
vi.mock('../core/logger', () => ({ log: vi.fn() }));
vi.mock('../demo/e3dcset-mock', () => ({ executeMockCommand: vi.fn(async () => ['mock output']) }));

// capturedCommand: welcher Befehl wurde an execAsync übergeben?
let capturedCommand: string | null = null;
let execShouldFail = false;

vi.mock('child_process', () => ({
  exec: vi.fn(),
}));

vi.mock('util', () => ({
  promisify: () => async (cmd: string) => {
    capturedCommand = cmd;
    if (execShouldFail) {
      throw new Error(`Command failed: ${cmd}\n/bin/sh: Illegal option -d`);
    }
    return { stdout: 'ok', stderr: '' };
  },
}));

import { RealE3dcGateway, MockE3dcGateway } from '../e3dc/gateway';

const E3DC_PREFIX = '/opt/keba-wallbox/e3dcset -p /opt/keba-wallbox/e3dcset.config -t /opt/keba-wallbox/e3dcset.tags';

// ── Teil 1: RealE3dcGateway – Prefix-Verhalten ───────────────────────
describe('RealE3dcGateway: Prefix handling', () => {
  beforeEach(() => {
    capturedCommand = null;
    execShouldFail = false;
  });

  it('BUG REPRO: executes bare "-d 0" when prefix is empty → /bin/sh interprets -d as shell option', async () => {
    const gateway = new RealE3dcGateway(''); // kein Prefix = Bug-Zustand nach Demo-Toggle

    await gateway.executeCommand('-d 0', 'Entladesperre aktivieren');

    // Der ausgeführte Befehl ist NUR "-d 0" ohne Pfad zu e3dcset
    // In Production: /bin/sh: 0: Illegal option -d
    expect(capturedCommand).toBe('-d 0');
    expect(capturedCommand).not.toContain('e3dcset');
  });

  it('BUG REPRO: /bin/sh throws "Illegal option -d" when prefix is missing', async () => {
    execShouldFail = true; // Simuliert /bin/sh Fehler
    const gateway = new RealE3dcGateway(''); // kein Prefix

    await expect(gateway.executeCommand('-d 0', 'Entladesperre aktivieren'))
      .rejects.toThrow('/bin/sh: Illegal option -d');
  });

  it('HAPPY PATH: executes full command when prefix is set', async () => {
    const gateway = new RealE3dcGateway(E3DC_PREFIX);

    await gateway.executeCommand('-d 0', 'Entladesperre aktivieren');

    expect(capturedCommand).toBe(`${E3DC_PREFIX} -d 0`);
    expect(capturedCommand).toContain('/opt/keba-wallbox/e3dcset');
  });

  it('HAPPY PATH: lock "-d 0" and unlock "-a" use same prefix', async () => {
    const gateway = new RealE3dcGateway(E3DC_PREFIX);

    await gateway.executeCommand('-d 0', 'Entladesperre aktivieren');
    const lockCmd = capturedCommand;

    await gateway.executeCommand('-a', 'Entladesperre deaktivieren');
    const unlockCmd = capturedCommand;

    expect(lockCmd).toBe(`${E3DC_PREFIX} -d 0`);
    expect(unlockCmd).toBe(`${E3DC_PREFIX} -a`);
  });

  it('HAPPY PATH: setPrefix() after construction applies to subsequent commands', async () => {
    const gateway = new RealE3dcGateway(''); // kein Prefix initial
    gateway.setPrefix(E3DC_PREFIX);          // Prefix nachträglich setzen (wie configure() es tut)

    await gateway.executeCommand('-d 0', 'Entladesperre aktivieren');

    expect(capturedCommand).toBe(`${E3DC_PREFIX} -d 0`);
  });
});

// ── Teil 2: E3dcClient.setGateway() – Prefix-Transfer ────────────────
//
// Dieser Abschnitt testet das Kernproblem: setGateway() ersetzt das Gateway
// mit einem neuen RealE3dcGateway ohne Prefix. Der Fix ist, dass setGateway()
// den Prefix aus this.config auf das neue Gateway überträgt.
//
// Wir testen dies direkt auf Gateway-Ebene (da das Singleton-Problem
// mit vi.resetModules() und dynamischen imports komplex ist), aber
// zeigen das Verhaltensmuster klar.

describe('E3dcClient: Demo-Mode Toggle Prefix Loss (Bug #69)', () => {
  beforeEach(() => {
    capturedCommand = null;
    execShouldFail = false;
  });

  it('BUG PATTERN: old gateway with prefix vs new gateway without prefix', async () => {
    // Schritt 1: Erstes Gateway mit Prefix (konfigurierter Zustand)
    const firstGateway = new RealE3dcGateway(E3DC_PREFIX);
    await firstGateway.executeCommand('-d 0', 'lock');
    expect(capturedCommand).toBe(`${E3DC_PREFIX} -d 0`); // ✓ korrekt

    // Schritt 2: Neues Gateway ohne Prefix (wie nach Demo-Toggle)
    capturedCommand = null;
    const newGateway = new RealE3dcGateway(); // kein Prefix!
    await newGateway.executeCommand('-d 0', 'lock');
    expect(capturedCommand).toBe('-d 0'); // ✗ BUG: kein Prefix
    expect(capturedCommand).not.toContain('e3dcset');
  });

  it('FIX PATTERN: new gateway gets prefix transferred from config', async () => {
    const configuredPrefix = E3DC_PREFIX;

    // Schritt 1: Konfigurierter Zustand (Prefix bekannt)
    const firstGateway = new RealE3dcGateway(configuredPrefix);

    // Schritt 2: Demo-Toggle → neues Gateway
    capturedCommand = null;
    const newGateway = new RealE3dcGateway();
    // FIX: Prefix aus Config auf neues Gateway übertragen (wie setGateway() nach Fix tut)
    newGateway.setPrefix(configuredPrefix);

    await newGateway.executeCommand('-d 0', 'lock');
    expect(capturedCommand).toBe(`${E3DC_PREFIX} -d 0`); // ✓ mit Fix korrekt
  });

  it('FIX PATTERN: lock and unlock both correct after gateway replacement with prefix transfer', async () => {
    const configuredPrefix = E3DC_PREFIX;
    const newGateway = new RealE3dcGateway();
    newGateway.setPrefix(configuredPrefix); // FIX: Prefix aus Config setzen

    // Lock
    await newGateway.executeCommand('-d 0', 'lock');
    const lockCmd = capturedCommand;

    // Unlock
    capturedCommand = null;
    await newGateway.executeCommand('-a', 'unlock');
    const unlockCmd = capturedCommand;

    expect(lockCmd).toBe(`${E3DC_PREFIX} -d 0`);
    expect(unlockCmd).toBe(`${E3DC_PREFIX} -a`);
  });
});

// ── Teil 3: E3dcClient Singleton Integration ──────────────────────────
describe('E3dcClient Singleton: setGateway preserves prefix from config', () => {
  beforeEach(() => {
    capturedCommand = null;
    execShouldFail = false;
  });

  it('FIX: setGateway(new RealE3dcGateway()) transfers prefix from this.config', async () => {
    const { e3dcClient } = await import('../e3dc/client');

    // Configure client with prefix
    const initialGateway = new RealE3dcGateway();
    e3dcClient.setGateway(initialGateway);
    e3dcClient.configure({
      enabled: true,
      ip: '192.168.40.200',
      port: 502,
      prefix: E3DC_PREFIX,
      dischargeLockEnableCommand: '-d 0',
      dischargeLockDisableCommand: '-a',
    });

    // Verify initial config works
    capturedCommand = null;
    await e3dcClient.lockDischarge();
    expect(capturedCommand).toBe(`${E3DC_PREFIX} -d 0`);

    // Demo mode toggle: Mock gateway
    e3dcClient.setGateway(new MockE3dcGateway());

    // Demo mode off: new Real gateway (this is where the bug is!)
    const newGateway = new RealE3dcGateway();
    e3dcClient.setGateway(newGateway); // FIX: must transfer prefix from this.config!

    // After fix: prefix should be transferred to newGateway
    capturedCommand = null;
    await e3dcClient.lockDischarge();
    // FIX VERIFICATION:
    expect(capturedCommand).toContain('/opt/keba-wallbox/e3dcset');
    expect(capturedCommand).toContain('-d 0');
    expect(capturedCommand).toBe(`${E3DC_PREFIX} -d 0`);
  });

  it('FIX: unlockDischarge() after demo toggle uses full prefix', async () => {
    const { e3dcClient } = await import('../e3dc/client');

    e3dcClient.setGateway(new RealE3dcGateway());
    e3dcClient.configure({
      enabled: true,
      ip: '192.168.40.200',
      port: 502,
      prefix: E3DC_PREFIX,
      dischargeLockEnableCommand: '-d 0',
      dischargeLockDisableCommand: '-a',
    });

    // Demo toggle
    e3dcClient.setGateway(new MockE3dcGateway());
    e3dcClient.setGateway(new RealE3dcGateway()); // FIX: must transfer prefix

    capturedCommand = null;
    await e3dcClient.unlockDischarge();
    expect(capturedCommand).toBe(`${E3DC_PREFIX} -a`);
  });
});

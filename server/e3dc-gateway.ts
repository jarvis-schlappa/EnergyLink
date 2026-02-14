import { exec } from 'child_process';
import { promisify } from 'util';
import { log } from './logger';
import path from 'path';

const execAsync = promisify(exec);

/**
 * Gateway-Interface für die Ausführung von e3dcset-Befehlen.
 * Abstrahiert den Unterschied zwischen echtem CLI-Tool und Mock-Script.
 */
export interface E3dcGateway {
  /**
   * Führt einen e3dcset-Befehl aus (z.B. "-d 1", "-a", "-e 6000")
   * @param command - Der Befehl (ohne e3dcset-Prefix, ohne Config-Prefix)
   * @param commandName - Beschreibung für Logging
   * @returns stdout-Ausgabe des Befehls
   */
  executeCommand(command: string, commandName: string): Promise<string>;
}

/**
 * Echtes E3DC Gateway - führt das e3dcset CLI-Tool aus.
 * Baut den vollständigen Befehl mit konfiguriertem Prefix zusammen.
 */
export class RealE3dcGateway implements E3dcGateway {
  constructor(private prefix: string = '') {}

  setPrefix(prefix: string): void {
    this.prefix = prefix;
  }

  async executeCommand(command: string, commandName: string): Promise<string> {
    const fullCommand = this.prefix
      ? `${this.prefix} ${command}`.trim()
      : command;

    log('info', 'system', `E3DC: ${commandName}`, `Befehl: ${fullCommand}`);

    const { stdout, stderr } = await execAsync(fullCommand);

    if (stdout) {
      log('info', 'system', `E3DC: ${commandName} - Ausgabe`, stdout.trim());
    }
    if (stderr) {
      log('warning', 'system', `E3DC: ${commandName} - Fehler-Ausgabe`, stderr.trim());
    }

    log('info', 'system', `E3DC: ${commandName} erfolgreich ausgeführt`);
    return stdout || '';
  }
}

/**
 * Mock E3DC Gateway - führt das e3dcset-mock.ts Script aus.
 * Wird im Demo-Modus verwendet.
 */
export class MockE3dcGateway implements E3dcGateway {
  private readonly mockScriptPath: string;

  constructor() {
    this.mockScriptPath = path.join(process.cwd(), 'server', 'e3dcset-mock.ts');
  }

  async executeCommand(command: string, commandName: string): Promise<string> {
    const fullCommand = `tsx ${this.mockScriptPath} ${command}`;

    log('info', 'system', `E3DC Mock: ${commandName}`, `Befehl: ${command}`);

    const { stdout, stderr } = await execAsync(fullCommand);

    if (stdout) {
      log('info', 'system', `E3DC Mock: ${commandName} - Ausgabe`, stdout.trim());
    }
    if (stderr) {
      log('warning', 'system', `E3DC Mock: ${commandName} - Fehler-Ausgabe`, stderr.trim());
    }

    log('info', 'system', `E3DC Mock: ${commandName} erfolgreich ausgeführt`);
    return stdout || '';
  }
}

import type { E3dcConfig } from '@shared/schema';
import { log } from '../core/logger';
import type { E3dcGateway } from './gateway';
import { RealE3dcGateway, MockE3dcGateway } from './gateway';

/**
 * Whitelist der erlaubten e3dcset-Flags und ob sie einen numerischen Parameter erwarten.
 * Nur diese Flags werden für die Console akzeptiert.
 */
const ALLOWED_E3DCSET_FLAGS: Record<string, 'none' | 'number' | 'string'> = {
  '-d': 'number',   // Maximale Entladeleistung (Watt)
  '-a': 'none',     // Zurück auf Automatik
  '-c': 'number',   // Maximale Ladeleistung (Watt)
  '-e': 'number',   // Netzladung Energiemenge (Wh)
  '-s': 'string',   // Set-Befehle (z.B. "discharge 0")
  '-r': 'string',   // Read-Tag abfragen
  '-l': 'number',   // Tags auflisten (optional Kategorie-Nummer)
  '-H': 'string',   // Historische Daten (day/week/month/year)
  '-D': 'string',   // Datum für historische Daten (YYYY-MM-DD)
  '-b': 'number',   // Batterie-Modul Index (0 = erstes Modul)
  '-m': 'number',   // Batterie-Modul Details
  '-q': 'none',     // Quiet-Modus (nur Wert ausgeben)
  '-j': 'none',     // JSON Output
  '-E': 'number',   // Emergency Power Reserve (Wh)
  '--info': 'none', // System-Info (SW-Version, Seriennummer, etc.)
  '--raw': 'none',  // Rohdaten ausgeben (nur mit -H)
  '--watch': 'none',      // Continuous Monitoring Modus
  '--interval': 'number', // Abfrageintervall in Sekunden
};

/**
 * Validiert einen e3dcset-Befehl gegen die Whitelist.
 * Gibt die bereinigten Argumente zurück oder wirft einen Fehler.
 * 
 * @param command - Der Befehl (ohne "e3dcset" Prefix)
 * @returns Array von validierten Argumenten
 * @throws Error wenn ungültige Flags oder Parameter gefunden werden
 */
export function validateE3dcCommand(command: string): string[] {
  // Sanitize typographic dashes: browsers/OS may convert '--' to '—' (em-dash) or '–' (en-dash)
  // Em-dash (—) represents two dashes, en-dash (–) represents one dash
  const sanitized = command.replace(/—/g, '--').replace(/–/g, '-');
  const trimmed = sanitized.replace(/^e3dcset\s+/, '').trim();
  if (trimmed === '') {
    throw new Error('Befehl ist leer');
  }

  // Tokenize: split on whitespace
  const tokens = trimmed.split(/\s+/);
  const validated: string[] = [];
  let i = 0;

  while (i < tokens.length) {
    const token = tokens[i];

    // Must be a known flag
    if (!ALLOWED_E3DCSET_FLAGS[token]) {
      throw new Error(`Unbekannter Parameter: ${token}. Erlaubt: ${Object.keys(ALLOWED_E3DCSET_FLAGS).join(', ')}`);
    }

    const paramType = ALLOWED_E3DCSET_FLAGS[token];
    validated.push(token);

    if (paramType === 'none') {
      i++;
    } else if (paramType === 'number') {
      // Next token must be a number (optional for -l)
      if (i + 1 < tokens.length && /^\d+$/.test(tokens[i + 1])) {
        validated.push(tokens[i + 1]);
        i += 2;
      } else if (token === '-l' || token === '-q') {
        // -l can be used without argument
        i++;
      } else {
        throw new Error(`Parameter ${token} erwartet einen numerischen Wert`);
      }
    } else if (paramType === 'string') {
      // Next token is required, must not contain shell metacharacters
      if (i + 1 >= tokens.length) {
        throw new Error(`Parameter ${token} erwartet einen Wert`);
      }
      const value = tokens[i + 1];
      // Allow only alphanumeric, dash, underscore, dot, colon
      if (!/^[a-zA-Z0-9_.\-:]+$/.test(value)) {
        throw new Error(`Ungültiger Wert für ${token}: ${value}`);
      }
      validated.push(value);
      i += 2;
      
      // -s can have a second argument (e.g. "discharge 0")
      if (token === '-s' && i < tokens.length && /^\d+$/.test(tokens[i])) {
        validated.push(tokens[i]);
        i++;
      }
    }
  }

  return validated;
}

class E3dcClient {
  private config: E3dcConfig | null = null;
  private gateway: E3dcGateway;
  private lastCommandTime: number = 0;
  private readonly RATE_LIMIT_MS = 5000; // 5 Sekunden zwischen Befehlen

  constructor() {
    // Default: Real gateway (wird ggf. per setGateway überschrieben)
    this.gateway = new RealE3dcGateway();
  }

  /**
   * Setzt das Gateway (Real oder Mock).
   * Wird beim App-Start einmalig aufgerufen.
   */
  setGateway(gateway: E3dcGateway): void {
    this.gateway = gateway;
  }

  configure(config: E3dcConfig): void {
    if (!config.enabled) {
      throw new Error('E3DC not enabled');
    }
    this.config = config;
    // Update prefix on RealE3dcGateway if applicable
    if (this.gateway instanceof RealE3dcGateway) {
      this.gateway.setPrefix(config.prefix?.trim() || '');
    }
  }

  disconnect(): void {
    this.config = null;
  }

  private async executeCommandWithPause(command: string | undefined, commandName: string): Promise<void> {
    if (!command || command.trim() === '') {
      log('info', 'system', `E3DC: ${commandName} - Kein Befehl konfiguriert, überspringe`);
      return;
    }

    // Entferne "e3dcset" Prefix falls vorhanden (Gateway kümmert sich um den Rest)
    const normalizedCommand = command.replace(/^e3dcset\s+/, '').trim();

    // Rate Limiting (nur für Real-Gateway relevant, aber schadet auch bei Mock nicht)
    const now = Date.now();
    const timeSinceLastCommand = now - this.lastCommandTime;
    
    if (this.lastCommandTime > 0 && timeSinceLastCommand < this.RATE_LIMIT_MS) {
      const waitTime = this.RATE_LIMIT_MS - timeSinceLastCommand;
      log('info', 'system', `E3DC: Rate Limiting - Warte ${(waitTime / 1000).toFixed(1)}s vor nächstem Befehl`);
      await new Promise(resolve => setTimeout(resolve, waitTime));
    }

    try {
      await this.gateway.executeCommand(normalizedCommand, commandName);
      this.lastCommandTime = Date.now();
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      log('error', 'system', `E3DC: ${commandName} fehlgeschlagen`, errorMessage);
      throw new Error(`Failed to execute ${commandName}`);
    }
  }

  /**
   * Öffentliche Methode für E3DC Console: Führt Befehl aus und gibt Output zurück
   * KEINE Modbus-Pause für schnelles Debugging - Risiko von Konflikten ist minimal
   */
  async executeConsoleCommand(command: string): Promise<string> {
    if (!command || command.trim() === '') {
      return 'Befehl ist leer';
    }

    // Validiere Befehl gegen Whitelist (verhindert Command Injection)
    let validatedArgs: string[];
    try {
      validatedArgs = validateE3dcCommand(command);
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      log('warning', 'system', `E3DC Console: Ungültiger Befehl abgelehnt`, `Input: ${command}, Grund: ${msg}`);
      return `Ungültiger Befehl: ${msg}`;
    }

    const safeCommand = validatedArgs.join(' ');

    try {
      const output = await this.gateway.executeCommand(safeCommand, `Console: ${safeCommand}`);
      return output || '(Keine Ausgabe)';
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      log('error', 'system', `E3DC Console: Befehl fehlgeschlagen`, msg);
      return `Fehler: ${msg}`;
    }
  }

  async lockDischarge(): Promise<void> {
    if (!this.config) {
      throw new Error('E3DC not configured');
    }
    await this.executeCommandWithPause(this.config.dischargeLockEnableCommand, 'Entladesperre aktivieren');
  }

  async unlockDischarge(): Promise<void> {
    if (!this.config) {
      throw new Error('E3DC not configured');
    }
    await this.executeCommandWithPause(this.config.dischargeLockDisableCommand, 'Entladesperre deaktivieren');
  }

  async enableGridCharge(): Promise<void> {
    if (!this.config) {
      throw new Error('E3DC not configured');
    }
    const command = this.config.gridChargeEnableCommand || this.getDefaultCommand('gridChargeEnable');
    await this.executeCommandWithPause(command, 'Netzstrom-Laden aktivieren');
  }

  async disableGridCharge(): Promise<void> {
    if (!this.config) {
      throw new Error('E3DC not configured');
    }
    const command = this.config.gridChargeDisableCommand || this.getDefaultCommand('gridChargeDisable');
    await this.executeCommandWithPause(command, 'Netzstrom-Laden deaktivieren');
  }

  /**
   * Gibt Default-Befehle für den Mock-Modus zurück, wenn keine konfiguriert sind.
   * Im Production-Modus (RealE3dcGateway) gibt es keine Defaults - leere Befehle werden übersprungen.
   */
  private getDefaultCommand(type: 'gridChargeEnable' | 'gridChargeDisable'): string | undefined {
    if (!(this.gateway instanceof MockE3dcGateway)) {
      return undefined;
    }
    switch (type) {
      case 'gridChargeEnable': return '-e 1750';
      case 'gridChargeDisable': return '-a';
    }
  }

  /**
   * Führt mehrere E3DC-Befehle kombiniert in einem einzigen Aufruf aus
   * Spart Rate-Limit-Zeit und ist atomarer
   */
  async executeCombinedCommand(commands: string[], commandName: string): Promise<void> {
    if (!this.config) {
      throw new Error('E3DC not configured');
    }

    // Filtere leere Befehle und normalisiere (entferne "e3dcset" prefix)
    const normalizedCommands = commands
      .filter(cmd => cmd && cmd.trim() !== '')
      .map(cmd => cmd.replace(/^e3dcset\s+/, '').trim())
      .filter(cmd => cmd !== '');
    
    if (normalizedCommands.length === 0) {
      log('info', 'system', `E3DC: ${commandName} - Keine Befehle konfiguriert, überspringe`);
      return;
    }

    const combinedCommand = normalizedCommands.join(' ').trim();
    
    await this.executeCommandWithPause(combinedCommand, commandName);
  }

  /**
   * Aktiviert Night Charging mit Battery Lock und optional Grid Charging
   * Kombiniert beide Befehle in einem einzigen e3dcset-Aufruf
   */
  async enableNightCharging(withGridCharging: boolean = true): Promise<void> {
    if (!this.config) {
      throw new Error('E3DC not configured');
    }

    const commands: string[] = [];
    
    if (this.config.dischargeLockEnableCommand) {
      commands.push(this.config.dischargeLockEnableCommand);
    }
    
    if (withGridCharging && this.config.gridChargeEnableCommand) {
      commands.push(this.config.gridChargeEnableCommand);
    }

    await this.executeCombinedCommand(
      commands,
      withGridCharging 
        ? 'Night Charging aktivieren (Battery Lock + Grid Charging)'
        : 'Night Charging aktivieren (nur Battery Lock)'
    );
  }

  /**
   * Deaktiviert Night Charging (Battery Lock + Grid Charging)
   */
  async disableNightCharging(): Promise<void> {
    if (!this.config) {
      throw new Error('E3DC not configured');
    }

    const commands: string[] = [];
    
    if (this.config.dischargeLockDisableCommand) {
      commands.push(this.config.dischargeLockDisableCommand);
    }
    
    if (this.config.gridChargeDisableCommand) {
      commands.push(this.config.gridChargeDisableCommand);
    }

    await this.executeCombinedCommand(
      commands,
      'Night Charging deaktivieren (Battery Lock + Grid Charging)'
    );
  }

  isConfigured(): boolean {
    return this.config !== null && this.config.enabled === true;
  }

  isGridChargeDuringNightChargingEnabled(): boolean {
    return this.config?.gridChargeDuringNightCharging === true;
  }
}

export const e3dcClient = new E3dcClient();

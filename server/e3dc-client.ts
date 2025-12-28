import { exec } from 'child_process';
import { promisify } from 'util';
import type { E3dcConfig } from '@shared/schema';
import { log } from './logger';
import { storage } from './storage';
import { getE3dcModbusService } from './e3dc-modbus';
import { stopE3dcPoller, startE3dcPoller } from './e3dc-poller';
import path from 'path';

const execAsync = promisify(exec);

/**
 * Prüft ob für einen e3dcset-Befehl eine Modbus-Pause nötig ist.
 * 
 * Modbus-Pause ist nur erforderlich bei Grid Charging Enable (-e > 0),
 * da dies den Emergency Power Modus aktiviert und Konflikte verursachen kann.
 * 
 * @param command - Der e3dcset Befehl (mit oder ohne "e3dcset" Prefix)
 * @returns true wenn Modbus-Pause angewendet werden soll
 */
function shouldApplyModbusPause(command: string): boolean {
  // Suche nach -e Parameter mit Wert (mit oder ohne Leerzeichen)
  // Unterstützt beide Formate: "-e 6000" und "-e6000"
  const match = command.match(/-e\s*(\d+)/);
  if (!match) {
    return false; // Kein -e Parameter → keine Pause nötig
  }
  
  const eValue = parseInt(match[1], 10);
  // Nur bei Grid Charging ENABLE (-e > 0) Pause anwenden
  // Bei -e 0 (Disable) ist keine Pause nötig
  return eValue > 0;
}

class E3dcClient {
  private config: E3dcConfig | null = null;
  private lastCommandTime: number = 0;
  private readonly RATE_LIMIT_MS = 5000; // 5 Sekunden zwischen Befehlen

  configure(config: E3dcConfig): void {
    if (!config.enabled) {
      throw new Error('E3DC not enabled');
    }
    this.config = config;
  }

  disconnect(): void {
    this.config = null;
  }

  private sanitizeOutput(value: string, command: string, extraSecrets: string[]): string {
    let sanitized = value;

    // E3DC-spezifische Patterns für Debug-Ausgaben
    const e3dcPatterns = [
      /e3dc_user=\S+/gi,
      /e3dc_password=\S+/gi,
      /aes_password=\S+/gi,
    ];

    e3dcPatterns.forEach(pattern => {
      sanitized = sanitized.replace(pattern, (match) => {
        const key = match.split('=')[0];
        return `${key}=xxx`;
      });
    });

    // Generische sensitive Patterns
    const sensitivePatterns = [
      /--password[=\s]+\S+/gi,
      /--pass[=\s]+\S+/gi,
      /--token[=\s]+\S+/gi,
      /--auth[=\s]+\S+/gi,
      /--apikey[=\s]+\S+/gi,
      /--api-key[=\s]+\S+/gi,
      /--secret[=\s]+\S+/gi,
      /-p[=\s]+\S+/gi,
      /\b(password|pass|token|auth|apikey|api-key|secret|key)[=:]\S+/gi,
    ];

    sensitivePatterns.forEach(pattern => {
      sanitized = sanitized.replace(pattern, '[REDACTED]');
    });

    extraSecrets.forEach(secret => {
      if (secret && secret.trim() !== '') {
        sanitized = sanitized.replace(new RegExp(secret.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g'), '***');
      }
    });

    return sanitized;
  }

  private getSensitiveValues(): string[] {
    if (!this.config) return [];
    
    const values: string[] = [];
    
    if (this.config.dischargeLockEnableCommand) {
      values.push(this.config.dischargeLockEnableCommand);
    }
    if (this.config.dischargeLockDisableCommand) {
      values.push(this.config.dischargeLockDisableCommand);
    }
    if (this.config.gridChargeEnableCommand) {
      values.push(this.config.gridChargeEnableCommand);
    }
    if (this.config.gridChargeDisableCommand) {
      values.push(this.config.gridChargeDisableCommand);
    }
    
    return values;
  }

  /**
   * Führt Mock-E3DC-Befehl aus (Demo-Modus)
   * Ruft e3dcset-mock.ts auf statt echtem CLI-Tool
   * 
   * WICHTIG: Diese Methode führt KEINE Modbus-Pause durch!
   * Die Pause wird von executeCommand() durchgeführt, welches diese Methode aufruft.
   */
  private async executeMockCommand(mockCommand: string, commandName: string): Promise<void> {
    const mockScriptPath = path.join(process.cwd(), 'server', 'e3dcset-mock.ts');
    const fullCommand = `tsx ${mockScriptPath} ${mockCommand}`;
    
    try {
      log('info', 'system', `E3DC Mock: ${commandName}`, `Befehl: ${mockCommand}`);
      
      const { stdout, stderr } = await execAsync(fullCommand);
      
      if (stdout) {
        log('info', 'system', `E3DC Mock: ${commandName} - Ausgabe`, stdout.trim());
      }
      
      if (stderr) {
        log('warning', 'system', `E3DC Mock: ${commandName} - Fehler-Ausgabe`, stderr.trim());
      }
      
      log('info', 'system', `E3DC Mock: ${commandName} erfolgreich ausgeführt`);
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      log('error', 'system', `E3DC Mock: ${commandName} fehlgeschlagen`, errorMessage);
      throw new Error(`Failed to execute ${commandName} (Mock)`);
    }
  }

  private async executeCommand(command: string | undefined, commandName: string): Promise<void> {
    if (!command || command.trim() === '') {
      log('info', 'system', `E3DC: ${commandName} - Kein Befehl konfiguriert, überspringe`);
      return;
    }

    // Prüfe ob Modbus-Pause erforderlich (nur bei Grid Charging Enable mit -e > 0)
    const needsModbusPause = shouldApplyModbusPause(command);
    const modbusPauseSeconds = this.config?.modbusPauseSeconds ?? 3;
    const e3dcModbusService = getE3dcModbusService();
    
    // Modbus-Pause VOR e3dcset-Befehl (nur wenn nötig)
    if (needsModbusPause && modbusPauseSeconds > 0) {
      log('info', 'system', `E3DC: Modbus-Pause BEGINNT (${modbusPauseSeconds}s - Grid Charging Enable erkannt)`);
      await stopE3dcPoller();
      await e3dcModbusService.disconnect();
      await new Promise(resolve => setTimeout(resolve, modbusPauseSeconds * 1000));
      log('info', 'system', `E3DC: Modbus-Pause ENDET (${modbusPauseSeconds}s)`);
    } else {
      log('debug', 'system', `E3DC: Keine Modbus-Pause nötig für: ${command}`);
    }

    // Im Demo-Modus: Mock-Script verwenden statt echtes CLI
    const settings = storage.getSettings();
    if (settings?.demoMode) {
      // Parse e3dcset-Befehle und konvertiere zu Mock-Format
      // Beispiel: "e3dcset -s discharge 0" → "-s discharge 0"
      const mockCommand = command.replace(/^e3dcset\s+/, '');
      
      try {
        await this.executeMockCommand(mockCommand, commandName);
      } finally {
        // Modbus-Pause NACH e3dcset-Befehl (nur wenn nötig)
        if (needsModbusPause && modbusPauseSeconds > 0) {
          log('info', 'system', `E3DC: Modbus-Pause BEGINNT (${modbusPauseSeconds}s nach e3dcset-Befehl)`);
          await new Promise(resolve => setTimeout(resolve, modbusPauseSeconds * 1000));
          log('info', 'system', `E3DC: Modbus-Pause ENDET (${modbusPauseSeconds}s nach e3dcset-Befehl)`);
          startE3dcPoller();
          log('info', 'system', 'E3DC: Poller nach e3dcset-Befehl wieder gestartet');
        }
      }
      return;
    }

    // Production-Modus: Echtes CLI verwenden
    // Kombiniere Prefix + Parameter mit Leerzeichen
    const prefix = this.config?.prefix?.trim() || '';
    const fullCommand = prefix 
      ? `${prefix} ${command}`.trim() 
      : command;

    // Rate Limiting: Warten wenn letzter Befehl weniger als 5 Sekunden her ist
    const now = Date.now();
    const timeSinceLastCommand = now - this.lastCommandTime;
    
    if (this.lastCommandTime > 0 && timeSinceLastCommand < this.RATE_LIMIT_MS) {
      const waitTime = this.RATE_LIMIT_MS - timeSinceLastCommand;
      log('info', 'system', `E3DC: Rate Limiting - Warte ${(waitTime / 1000).toFixed(1)}s vor nächstem Befehl`);
      await new Promise(resolve => setTimeout(resolve, waitTime));
    }

    const sensitiveValues = this.getSensitiveValues();

    try {
      // Command ohne Sanitization loggen (Credentials sind in externer Datei)
      log('info', 'system', `E3DC: ${commandName}`, `Befehl: ${fullCommand}`);
      
      const { stdout, stderr } = await execAsync(fullCommand);
      
      if (stdout) {
        const sanitized = this.sanitizeOutput(stdout, command, sensitiveValues);
        log('info', 'system', `E3DC: ${commandName} - Ausgabe`, sanitized);
      }
      
      if (stderr) {
        const sanitized = this.sanitizeOutput(stderr, command, sensitiveValues);
        log('warning', 'system', `E3DC: ${commandName} - Fehler-Ausgabe`, sanitized);
      }
      
      // Zeitpunkt des letzten Befehls aktualisieren
      this.lastCommandTime = Date.now();
      log('info', 'system', `E3DC: ${commandName} erfolgreich ausgeführt`);
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      
      log('error', 'system', `E3DC: ${commandName} fehlgeschlagen`, `Command failed: ${fullCommand} ${errorMessage}`);
      throw new Error(`Failed to execute ${commandName}`);
    } finally {
      // Modbus-Pause NACH e3dcset-Befehl (nur wenn nötig)
      if (needsModbusPause && modbusPauseSeconds > 0) {
        log('info', 'system', `E3DC: Modbus-Pause BEGINNT (${modbusPauseSeconds}s nach e3dcset-Befehl)`);
        await new Promise(resolve => setTimeout(resolve, modbusPauseSeconds * 1000));
        log('info', 'system', `E3DC: Modbus-Pause ENDET (${modbusPauseSeconds}s nach e3dcset-Befehl)`);
        startE3dcPoller();
        log('info', 'system', 'E3DC: Poller nach e3dcset-Befehl wieder gestartet');
      }
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

    const settings = storage.getSettings();
    let output = '';
    
    // Demo-Modus
    if (settings?.demoMode) {
      const mockCommand = command.replace(/^e3dcset\s+/, '');
      const mockScriptPath = path.join(process.cwd(), 'server', 'e3dcset-mock.ts');
      const fullCommand = `tsx ${mockScriptPath} ${mockCommand}`;
      
      try {
        const stdout = await execAsync(fullCommand);
        output = (typeof stdout === 'string' ? stdout : (stdout as any)?.stdout || '') || '(Keine Ausgabe)';
      } catch (error) {
        output = `Fehler: ${error instanceof Error ? error.message : String(error)}`;
      }
      return output;
    }

    // Production-Modus
    const prefix = this.config?.prefix?.trim() || '';
    const fullCommand = prefix 
      ? `${prefix} ${command}`.trim() 
      : command;

    log('info', 'system', `E3DC Console: Befehl wird ausgeführt: ${fullCommand}`);

    try {
      const result = await execAsync(fullCommand);
      // execAsync kann entweder { stdout, stderr } oder nur stdout string sein
      if (typeof result === 'string') {
        output = result;
      } else if (typeof result === 'object' && result !== null) {
        output = (result as any).stdout || (result as any).stderr || '(Keine Ausgabe)';
      } else {
        output = '(Keine Ausgabe)';
      }
      
      log('info', 'system', `E3DC Console: Ausgabe erhalten - ${output.substring(0, 50)}...`);
    } catch (error) {
      output = `Fehler: ${error instanceof Error ? error.message : String(error)}`;
      log('error', 'system', `E3DC Console: Befehl fehlgeschlagen`, output);
    }

    return output;
  }

  async lockDischarge(): Promise<void> {
    if (!this.config) {
      throw new Error('E3DC not configured');
    }
    await this.executeCommand(this.config.dischargeLockEnableCommand, 'Entladesperre aktivieren');
  }

  async unlockDischarge(): Promise<void> {
    if (!this.config) {
      throw new Error('E3DC not configured');
    }
    await this.executeCommand(this.config.dischargeLockDisableCommand, 'Entladesperre deaktivieren');
  }

  /**
   * Aktiviert Netzstrom-Laden mit dem konfigurierten Befehl aus den Einstellungen
   */
  async enableGridCharge(): Promise<void> {
    if (!this.config) {
      throw new Error('E3DC not configured');
    }
    
    const settings = storage.getSettings();
    let command: string | undefined = this.config.gridChargeEnableCommand;
    
    // Demo-Modus Fallback wenn kein Befehl konfiguriert
    if (!command && settings?.demoMode) {
      command = '-e 1750';
    }
    
    await this.executeCommand(command, 'Netzstrom-Laden aktivieren');
  }

  async disableGridCharge(): Promise<void> {
    if (!this.config) {
      throw new Error('E3DC not configured');
    }
    
    // Im Demo-Modus: Standard-Mock-Befehl wenn kein Befehl konfiguriert
    const settings = storage.getSettings();
    let command = this.config.gridChargeDisableCommand;
    if (!command && settings?.demoMode) {
      command = '-a'; // Standard Grid Charging Disable (zurück auf Automatik)
    }
    
    await this.executeCommand(command, 'Netzstrom-Laden deaktivieren');
  }

  /**
   * Führt mehrere E3DC-Befehle kombiniert in einem einzigen Aufruf aus
   * Spart Rate-Limit-Zeit und ist atomarer
   * 
   * @param commands - Array von Befehlen (mit oder ohne "e3dcset" Prefix)
   * @param commandName - Beschreibung für Logging
   * 
   * @example
   * // Statt 2 Aufrufe mit 5s Pause:
   * await lockDischarge();
   * await enableGridCharge();
   * 
   * // Kombiniert in einem Aufruf:
   * await executeCombinedCommand(['e3dcset -d 1', 'e3dcset -c 2500 -e 6000'], 'Night Charging aktivieren');
   * // Resultat: "e3dcset -d 1 -c 2500 -e 6000"
   */
  async executeCombinedCommand(commands: string[], commandName: string): Promise<void> {
    if (!this.config) {
      throw new Error('E3DC not configured');
    }

    // Filtere leere Befehle und normalisiere (entferne "e3dcset" prefix)
    const normalizedCommands = commands
      .filter(cmd => cmd && cmd.trim() !== '')
      .map(cmd => cmd.replace(/^e3dcset\s+/, '').trim())
      .filter(cmd => cmd !== ''); // Filtere nochmal leere nach Normalisierung
    
    if (normalizedCommands.length === 0) {
      log('info', 'system', `E3DC: ${commandName} - Keine Befehle konfiguriert, überspringe`);
      return;
    }

    // Kombiniere alle Parameter zu einem einzigen Befehl
    // Beispiel: ['-d 1', '-c 2500 -e 6000'] → '-d 1 -c 2500 -e 6000'
    // executeCommand() kümmert sich dann um Prefix-Handling:
    //   - Demo-Modus: Keine Änderung nötig
    //   - Production: Prefix wird vorangestellt (z.B. /pfad/zum/e3dcset -p config -d 1 -c 2500)
    const combinedCommand = normalizedCommands.join(' ').trim();
    
    await this.executeCommand(combinedCommand, commandName);
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
    
    // Battery Lock immer aktivieren
    if (this.config.dischargeLockEnableCommand) {
      commands.push(this.config.dischargeLockEnableCommand);
    }
    
    // Grid Charging optional (abhängig von Settings)
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
   * Kombiniert beide Befehle in einem einzigen e3dcset-Aufruf
   * 
   * Verwendet "-a" (zurück auf Automatik) wenn konfiguriert, sonst einzelne Disable-Befehle
   */
  async disableNightCharging(): Promise<void> {
    if (!this.config) {
      throw new Error('E3DC not configured');
    }

    const commands: string[] = [];
    
    // Battery Lock deaktivieren
    if (this.config.dischargeLockDisableCommand) {
      commands.push(this.config.dischargeLockDisableCommand);
    }
    
    // Grid Charging deaktivieren
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

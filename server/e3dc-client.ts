import { exec } from 'child_process';
import { promisify } from 'util';
import type { E3dcConfig } from '@shared/schema';
import { log } from './logger';
import { storage } from './storage';
import { getE3dcModbusService } from './e3dc-modbus';
import path from 'path';

const execAsync = promisify(exec);

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

    // Modbus-Pause VOR e3dcset-Befehl (um Konflikte zu vermeiden)
    // Wird sowohl im Demo- als auch im Production-Modus angewendet
    const modbusPauseSeconds = this.config?.modbusPauseSeconds ?? 3;
    const e3dcModbusService = getE3dcModbusService();
    
    if (modbusPauseSeconds > 0) {
      log('debug', 'system', `E3DC: Modbus-Pause BEGINNT (${modbusPauseSeconds}s vor e3dcset-Befehl)`);
      await e3dcModbusService.disconnect();
      await new Promise(resolve => setTimeout(resolve, modbusPauseSeconds * 1000));
      log('debug', 'system', `E3DC: Modbus-Pause ENDET (${modbusPauseSeconds}s vor e3dcset-Befehl)`);
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
        // Modbus-Pause NACH e3dcset-Befehl (um Konflikte zu vermeiden)
        if (modbusPauseSeconds > 0) {
          log('debug', 'system', `E3DC: Modbus-Pause BEGINNT (${modbusPauseSeconds}s nach e3dcset-Befehl)`);
          await new Promise(resolve => setTimeout(resolve, modbusPauseSeconds * 1000));
          log('debug', 'system', `E3DC: Modbus-Pause ENDET (${modbusPauseSeconds}s nach e3dcset-Befehl)`);
          
          // Modbus-Verbindung wieder herstellen
          const e3dcIp = settings?.e3dcIp;
          if (e3dcIp) {
            try {
              await e3dcModbusService.connect(e3dcIp);
              log('debug', 'system', 'E3DC: Modbus-Verbindung nach e3dcset-Befehl wiederhergestellt');
            } catch (error) {
              log('warning', 'system', 'E3DC: Modbus-Verbindung konnte nicht wiederhergestellt werden', error instanceof Error ? error.message : String(error));
            }
          }
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
      // Modbus-Pause NACH e3dcset-Befehl (um Konflikte zu vermeiden)
      if (modbusPauseSeconds > 0) {
        log('debug', 'system', `E3DC: Modbus-Pause BEGINNT (${modbusPauseSeconds}s nach e3dcset-Befehl)`);
        await new Promise(resolve => setTimeout(resolve, modbusPauseSeconds * 1000));
        log('debug', 'system', `E3DC: Modbus-Pause ENDET (${modbusPauseSeconds}s nach e3dcset-Befehl)`);
        
        // Modbus-Verbindung wieder herstellen
        const e3dcIp = settings?.e3dcIp;
        if (e3dcIp) {
          try {
            await e3dcModbusService.connect(e3dcIp);
            log('debug', 'system', 'E3DC: Modbus-Verbindung nach e3dcset-Befehl wiederhergestellt');
          } catch (error) {
            log('warning', 'system', 'E3DC: Modbus-Verbindung konnte nicht wiederhergestellt werden', error instanceof Error ? error.message : String(error));
          }
        }
      }
    }
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

  async enableGridCharge(): Promise<void> {
    if (!this.config) {
      throw new Error('E3DC not configured');
    }
    await this.executeCommand(this.config.gridChargeEnableCommand, 'Netzstrom-Laden aktivieren');
  }

  async disableGridCharge(): Promise<void> {
    if (!this.config) {
      throw new Error('E3DC not configured');
    }
    await this.executeCommand(this.config.gridChargeDisableCommand, 'Netzstrom-Laden deaktivieren');
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

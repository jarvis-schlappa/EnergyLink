#!/usr/bin/env node
/**
 * Mock e3dcset CLI Tool für Demo-Modus
 * 
 * Simuliert das echte e3dcset-Tool von https://github.com/mschlappa/e3dcset
 * Schreibt Befehle in State-Datei statt an echtes E3DC zu senden.
 * 
 * Verwendung (gleich wie echtes e3dcset):
 *   e3dcset-mock -d <watts>    # Maximale Entladeleistung setzen (1W = gesperrt)
 *   e3dcset-mock -a            # Zurück auf Automatik
 *   e3dcset-mock -c <watts>    # Maximale Ladeleistung setzen
 *   e3dcset-mock -e <Wh>       # Netzladung starten mit Energiemenge (0 = deaktivieren)
 */

import fs from 'fs/promises';
import path from 'path';

interface E3dcControlState {
  maxDischargePower: number;   // Maximale Entladeleistung in Watt (1W = gesperrt, 3000W = normal)
  gridCharging: boolean;       // true = Netzladen aktiv
  gridChargePower: number;     // Ladeleistung in Watt
  lastCommand: string;         // Letzter Befehl für Debug
  lastCommandTime: string;     // Zeitstempel des letzten Befehls
}

const STATE_FILE = path.join(process.cwd(), 'data', 'e3dc-control-state.json');

async function loadState(): Promise<E3dcControlState> {
  try {
    const data = await fs.readFile(STATE_FILE, 'utf-8');
    return JSON.parse(data);
  } catch {
    // Default State wenn Datei nicht existiert
    return {
      maxDischargePower: 3000, // Default: volle Entladung
      gridCharging: false,
      gridChargePower: 0,
      lastCommand: '',
      lastCommandTime: new Date().toISOString(),
    };
  }
}

async function saveState(state: E3dcControlState): Promise<void> {
  // Sicherstellen dass data/ Verzeichnis existiert
  const dataDir = path.dirname(STATE_FILE);
  try {
    await fs.mkdir(dataDir, { recursive: true });
  } catch {
    // Verzeichnis existiert bereits
  }
  
  await fs.writeFile(STATE_FILE, JSON.stringify(state, null, 2), 'utf-8');
}

/**
 * Führt Mock-e3dcset-Befehle in-process aus.
 * @param commandString - Befehl wie z.B. "-d 1" oder "-a" oder "-e 6000"
 * @returns Array von Log-Zeilen (stdout-Äquivalent)
 */
export async function executeMockCommand(commandString: string): Promise<string[]> {
  const args = commandString.trim().split(/\s+/).filter(Boolean);

  if (args.length === 0) {
    throw new Error('Usage: e3dcset-mock [-d <watts>] [-a] [-c <watts>] [-e <watts>]');
  }

  const state = await loadState();
  const output: string[] = [];
  let commandStr = 'e3dcset';

  // Parse Argumente (gleich wie echtes e3dcset)
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    commandStr += ` ${arg}`;

    if (arg === '-d' && i + 1 < args.length) {
      const dischargePower = parseInt(args[i + 1], 10);
      state.maxDischargePower = dischargePower;
      output.push(`[E3DC Mock] Maximale Entladeleistung gesetzt auf ${dischargePower}W`);
      i += 1;
    } else if (arg === '-a') {
      state.maxDischargePower = 3000;
      state.gridCharging = false;
      state.gridChargePower = 0;
      output.push('[E3DC Mock] Zurück auf Automatik: Entladung 3000W, Netzladen aus');
    } else if (arg === '-c' && i + 1 < args.length) {
      const chargePower = parseInt(args[i + 1], 10);
      state.gridCharging = true;
      state.gridChargePower = chargePower;
      output.push(`[E3DC Mock] Netzladen aktiviert mit ${chargePower}W`);
      i += 1;
    } else if (arg === '-e' && i + 1 < args.length) {
      const chargeAmountWh = parseInt(args[i + 1], 10);
      if (chargeAmountWh > 0) {
        state.gridCharging = true;
        state.gridChargePower = 2500;
        output.push(`[E3DC Mock] Netzladung gestartet: ${chargeAmountWh} Wh (Ladeleistung: ${state.gridChargePower}W)`);
      } else {
        state.gridCharging = false;
        state.gridChargePower = 0;
        output.push('[E3DC Mock] Netzladung deaktiviert');
      }
      i += 1;
    }
  }

  // State speichern
  state.lastCommand = commandStr.trim();
  state.lastCommandTime = new Date().toISOString();
  await saveState(state);

  return output;
}

// CLI-Modus: Nur ausführen wenn direkt aufgerufen
const isDirectExecution =
  process.argv[1]?.endsWith('e3dcset-mock.ts') ||
  process.argv[1]?.endsWith('e3dcset-mock.js');

if (isDirectExecution) {
  executeMockCommand(process.argv.slice(2).join(' '))
    .then((lines) => {
      lines.forEach((line) => console.log(line));
      process.exit(0);
    })
    .catch((error) => {
      console.error('[E3DC Mock] Error:', error.message);
      process.exit(1);
    });
}

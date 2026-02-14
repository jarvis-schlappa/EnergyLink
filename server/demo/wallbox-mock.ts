/**
 * Mock KEBA Wallbox Service für UI-Entwicklung ohne echte Hardware
 * 
 * Simuliert KEBA P20/P30 UDP-Protokoll mit Reports 1/2/3:
 * - Report 1: Statische Geräteinfos (Product, Serial, Firmware)
 * - Report 2: Status (State, Plug, Enable sys, Max curr)
 * - Report 3: Leistungsdaten (P, U1-U3, I1-I3, E pres, E total)
 * 
 * Unterstützt Commands: ena 0/1, curr X
 * 
 * Realistisch basierend auf Produktionsdaten (2026-02-14):
 * - Asymmetrische Spannungen/Ströme pro Phase
 * - Power Factor 998-999 statt statisch 1000
 * - Gradueller Ramp-Up (~30s von 0 auf Zielstrom)
 * - Spontane E pres Broadcasts alle 1-2s
 * - Product-String mit Trailing Spaces (Fixed-Width)
 * - Realistische State-Übergänge mit Verzögerung
 * - Korrekte Werte nach Stopp (Enable sys/user=0, Max curr=0, Curr user bleibt)
 */
export class WallboxMockService {
  // Static device info - Product mit Trailing Spaces wie echte KEBA (fixed-width padding)
  private readonly PRODUCT = "KC-P20-EC240130-000            "; // 32 chars padded
  private readonly SERIAL = "16314582";
  private readonly FIRMWARE = "KEBA P20 v 2.5a3 (160613-061001)";
  
  // State
  private enabled: boolean = false; // System aktiviert (standardmäßig AUS im Demo-Modus)
  private enableUser: boolean = false; // Enable user (separat von Enable sys)
  private state: number = 2; // 0=Starting, 1=NotReady, 2=Ready, 3=Charging, 4=Error, 5=Interrupted
  private plug: number = 7; // 0=unplugged, 1=cable plugged in station, 3=cable plugged in EV, 5=locking, 7=locked
  private input: number = 0; // Potenzialfreier Kontakt (0=aus, 1=ein)
  private maxCurrent: number = 16000; // Hardware-Max 16A in mA (3-phasig) oder 32000 mA (1-phasig)
  private currentSetpoint: number = 6000; // Aktueller Lade-Sollwert in mA (curr-Befehl)
  private lastCurrUser: number = 6000; // Letzter Curr user Wert (bleibt nach Stopp erhalten)
  private phases: number = 3; // 1=einphasig (PV-Überschuss), 3=dreiphasig (normal)
  private pvSurplusMode: boolean = false; // PV-Überschuss-Modus aktiv
  
  // Charging state
  private sessionEnergy: number = 0; // E pres in Wh
  private totalEnergy: number = 31166830; // E total in Wh (31.166 kWh wie echte Wallbox)
  private lastUpdateTime: number = Date.now();
  
  // Charging power tracking with ramp-up
  private currentPower: number = 0; // Aktuelle Ladeleistung in W (mit Ramp-Up)
  private targetPower: number = 0; // Ziel-Ladeleistung in W
  private rampStartTime: number = 0; // Zeitpunkt des Ramp-Up-Starts
  private readonly RAMP_UP_DURATION_MS = 30000; // ~30s Ramp-Up wie echte Wallbox
  
  // Current ramp tracking (actual current flowing, separate from setpoint)
  private actualCurrentFraction: number = 0; // 0-1 fraction of target current during ramp-up
  
  // Broadcast system
  private broadcastCallback: ((data: any) => void) | null = null;
  
  // State transition timers
  private stateTransitionTimer: NodeJS.Timeout | null = null;
  
  // Spontaneous E pres broadcast interval (real KEBA sends every 1-2s during charging)
  private ePresBroadcastInterval: NodeJS.Timeout | null = null;
  
  // Uptime tracking
  private readonly startTime: number = Date.now();
  
  constructor() {
    // Initialer Zustand: Kabel gesteckt, bereit zum Laden
    this.plug = 7;
    this.state = 2;
    this.input = 0;
  }

  /**
   * Generates realistic asymmetric phase voltages (233-239V range)
   * Each phase has slightly different voltage, like real grid
   */
  private getPhaseVoltages(): [number, number, number] {
    const baseVoltage = 236; // Center of 233-239 range
    const jitter = () => baseVoltage + Math.round((Math.random() - 0.5) * 6); // ±3V
    return [jitter(), jitter(), jitter()];
  }

  /**
   * Generates realistic asymmetric phase currents with ±200mA jitter
   * Only when charging (State 3)
   */
  private getPhaseCurrents(baseCurrent: number): [number, number, number] {
    if (baseCurrent === 0) return [0, 0, 0];
    const jitter = () => Math.round(baseCurrent + (Math.random() - 0.5) * 400); // ±200mA
    return [jitter(), jitter(), jitter()];
  }

  /**
   * Calculates Max curr % based on observed production values
   * @10A → 166, @16A → 266
   * Formula derived: pct = floor(current_mA / 60.15) approximately
   * Actually: it seems to be (current_A * 1000 / 6000) * 100 = current in units of 6A as percentage?
   * 10A: 10000/6000*100 = 166.6 → 166
   * 16A: 16000/6000*100 = 266.6 → 266
   */
  private calculateMaxCurrPercent(): number {
    if (!this.enabled || this.currentSetpoint === 0) {
      return 1000; // Default 100.0% when not charging
    }
    return Math.floor((this.currentSetpoint / 6000) * 100);
  }

  /**
   * Returns uptime in seconds (like real Sec field)
   */
  private getUptimeSeconds(): number {
    return Math.floor((Date.now() - this.startTime) / 1000);
  }

  /**
   * Report 1: Statische Geräteinfos
   */
  getReport1(): any {
    return {
      "ID": "1",
      "Product": this.PRODUCT,
      "Serial": this.SERIAL,
      "Firmware": this.FIRMWARE,
      "COM-module": 1,
      "Backend": 0,
      "Sec": this.getUptimeSeconds()
    };
  }

  /**
   * Report 2: Status und Konfiguration
   * Matches real KEBA P20 behavior observed in production
   */
  getReport2(): any {
    return {
      "ID": "2",
      "State": this.state,
      "Error1": 0,
      "Error2": 0,
      "Plug": this.plug,
      "AuthON": 0,
      "Authreq": 0,
      "Enable sys": this.enabled ? 1 : 0,
      "Enable user": this.enableUser ? 1 : 0,
      "Max curr": this.enabled ? this.currentSetpoint : 0, // 0 when stopped (like real KEBA)
      "Max curr %": this.calculateMaxCurrPercent(),
      "Curr HW": this.phases === 1 ? 32000 : 16000, // Hardware limit
      "Curr user": this.lastCurrUser, // Persists after stop (like real KEBA)
      "Curr FS": 0,
      "Tmo FS": 0,
      "Curr timer": 0,
      "Tmo CT": 0,
      "Setenergy": 0,
      "Output": this.enabled ? 1 : 0,
      "Input": this.input,
      "X2 phaseSwitch source": 4,
      "X2 phaseSwitch": 0,
      "Serial": this.SERIAL,
      "Sec": this.getUptimeSeconds()
    };
  }

  /**
   * Report 3: Leistungsdaten (1- oder 3-phasig)
   * 
   * Matches real KEBA P20 behavior:
   * - Voltages in V (not mV!) - 233-239V asymmetric
   * - Currents in mA - asymmetric ±200mA
   * - Power in mW
   * - PF = 998-999 (not 1000)
   * - E pres/E total in 0.1 Wh
   * - All zero when idle (except E pres/E total)
   */
  getReport3(): any {
    // Energie aktualisieren basierend auf verstrichener Zeit
    this.updateEnergyCounters();
    
    let u1 = 0, u2 = 0, u3 = 0;
    let i1 = 0, i2 = 0, i3 = 0;
    let power = 0;
    let pf = 0;
    
    // Nur wenn tatsächlich geladen wird (State 3 = Charging)
    if (this.state === 3 && this.enabled) {
      // Asymmetrische Spannungen in V (wie echte KEBA: 233-239V)
      [u1, u2, u3] = this.getPhaseVoltages();
      
      // Aktuelle Stromstärke basierend auf Ramp-Up
      const actualCurrent = Math.round(this.currentSetpoint * this.actualCurrentFraction);
      
      if (this.phases === 1) {
        // Einphasige Ladung: Nur Phase 1 hat Strom
        [i1] = this.getPhaseCurrents(actualCurrent);
        i2 = 0;
        i3 = 0;
        power = Math.round(u1 * i1); // mW = V * mA
      } else {
        // Dreiphasige Ladung: Asymmetrische Ströme
        [i1, i2, i3] = this.getPhaseCurrents(actualCurrent);
        power = Math.round(u1 * i1 + u2 * i2 + u3 * i3); // mW = sum(V * mA per phase)
      }
      
      // Power Factor 998-999 (wie echte KEBA)
      pf = 998 + Math.round(Math.random());
    }
    // Wenn nicht am Laden: Alle Werte 0 (wie echte KEBA im Idle)
    
    return {
      "ID": "3",
      "U1": u1,
      "U2": u2,
      "U3": u3,
      "I1": i1,
      "I2": i2,
      "I3": i3,
      "P": power, // Already in mW (V * mA = mW)
      "PF": pf,
      "E pres": Math.round(this.sessionEnergy * 10), // Wh → 0.1Wh
      "E total": Math.round(this.totalEnergy * 10), // Wh → 0.1Wh
      "Serial": this.SERIAL,
      "Sec": this.getUptimeSeconds()
    };
  }

  /**
   * Aktualisiert Energiezähler und Ramp-Up basierend auf verstrichener Zeit
   */
  private updateEnergyCounters(): void {
    const now = Date.now();
    const elapsedMs = now - this.lastUpdateTime;
    const elapsedHours = elapsedMs / (1000 * 60 * 60);
    
    // Ramp-Up: Graduell von 0 auf 1 über RAMP_UP_DURATION_MS
    if (this.state === 3 && this.enabled && this.targetPower > 0) {
      if (this.rampStartTime > 0) {
        const rampElapsed = now - this.rampStartTime;
        this.actualCurrentFraction = Math.min(1.0, rampElapsed / this.RAMP_UP_DURATION_MS);
      } else {
        this.actualCurrentFraction = 1.0;
      }
      this.currentPower = this.targetPower * this.actualCurrentFraction;
    } else if (this.targetPower === 0) {
      this.currentPower = 0;
      this.actualCurrentFraction = 0;
    }
    
    // Energie akkumulieren
    const energyWh = this.currentPower * elapsedHours;
    this.sessionEnergy += energyWh;
    this.totalEnergy += energyWh;
    
    this.lastUpdateTime = now;
  }

  /**
   * Führt Wallbox-Kommando aus
   */
  executeCommand(command: string): any {
    const parts = command.toLowerCase().split(" ");
    const cmd = parts[0];
    const value = parts[1];

    if (cmd === "ena") {
      if (value === "1") {
        // Laden aktivieren - mit realistischer State-Transition
        this.enabled = true;
        this.enableUser = true;
        if (this.plug === 7) {
          // Realistic transition: first go to State 5 (interrupted), then to State 3 (charging)
          const oldState = this.state;
          if (oldState === 2) {
            // Ready → Interrupted → Charging (like real KEBA)
            this.state = 5;
            this.sendBroadcast({ "State": this.state });
            
            // After ~2s, transition to Charging
            if (this.stateTransitionTimer) clearTimeout(this.stateTransitionTimer);
            this.stateTransitionTimer = setTimeout(() => {
              this.state = 3;
              this.rampStartTime = Date.now();
              this.actualCurrentFraction = 0;
              this.calculateChargingPower();
              this.sendBroadcast({ "State": this.state });
              this.startEPresBroadcast();
            }, 2000);
          } else {
            // Already in State 5 or other → go directly to charging
            this.state = 3;
            this.rampStartTime = Date.now();
            this.actualCurrentFraction = 0;
            this.calculateChargingPower();
            if (oldState !== this.state) {
              this.sendBroadcast({ "State": this.state });
            }
            this.startEPresBroadcast();
          }
        }
        return { "TCH-OK": "done" };
      } else if (value === "0") {
        // Laden deaktivieren - like real KEBA after stop
        const oldState = this.state;
        this.enabled = false;
        this.enableUser = false;
        // Curr user keeps last value (like real KEBA)
        this.state = this.plug === 7 ? 5 : 2; // Interrupted if cable still plugged, else Ready
        this.targetPower = 0;
        this.currentPower = 0;
        this.actualCurrentFraction = 0;
        this.rampStartTime = 0;
        this.stopEPresBroadcast();
        if (this.stateTransitionTimer) {
          clearTimeout(this.stateTransitionTimer);
          this.stateTransitionTimer = null;
        }
        if (oldState !== this.state) {
          this.sendBroadcast({ "State": this.state });
        }
        return { "TCH-OK": "done" };
      }
    }

    if (cmd === "curr") {
      const newCurrent = parseInt(value);
      if (newCurrent >= 6000 && newCurrent <= 32000) {
        const maxForPhases = this.phases === 1 ? 32000 : 16000;
        this.currentSetpoint = Math.min(newCurrent, maxForPhases);
        this.lastCurrUser = this.currentSetpoint; // Track last user value
        
        if (this.state === 3) {
          // Already charging → recalculate but restart ramp
          this.rampStartTime = Date.now();
          this.actualCurrentFraction = 0;
          this.calculateChargingPower();
        }
        return { "TCH-OK": "done" };
      }
    }

    if (cmd === "phases") {
      const newPhases = parseInt(value);
      if (newPhases === 1 || newPhases === 3) {
        this.phases = newPhases;
        this.maxCurrent = newPhases === 1 ? 32000 : 16000;
        
        if (this.currentSetpoint > this.maxCurrent) {
          this.currentSetpoint = this.maxCurrent;
        }
        
        if (this.state === 3) {
          this.calculateChargingPower();
        }
        
        return { "TCH-OK": "done" };
      }
    }

    if (cmd === "report") {
      const reportNum = value;
      if (reportNum === "1") return this.getReport1();
      if (reportNum === "2") return this.getReport2();
      if (reportNum === "3") return this.getReport3();
    }

    return { "TCH-ERR": "unknown command" };
  }

  /**
   * Berechnet Ziel-Ladeleistung basierend auf aktuellem Sollstrom
   */
  private calculateChargingPower(): void {
    if (!this.enabled || this.state !== 3) {
      this.targetPower = 0;
      return;
    }

    const currentAmps = this.currentSetpoint / 1000;
    
    if (this.phases === 1) {
      this.targetPower = 230 * currentAmps;
    } else {
      this.targetPower = Math.sqrt(3) * 400 * currentAmps;
    }
  }

  /**
   * Setzt Ladeleistung manuell (für PV-Überschuss-Steuerung)
   */
  setChargingPower(powerW: number): void {
    let minPower: number;
    let maxPower: number;
    
    if (this.phases === 1) {
      const voltage = 230;
      minPower = voltage * 6;
      maxPower = voltage * 32;
    } else {
      const sqrt3 = Math.sqrt(3);
      const voltage = 400;
      minPower = sqrt3 * voltage * 6;
      maxPower = sqrt3 * voltage * 16;
    }

    const clampedPower = Math.max(0, Math.min(maxPower, powerW));

    if (clampedPower < minPower && clampedPower > 0) {
      this.targetPower = minPower;
      this.currentSetpoint = 6000;
      this.lastCurrUser = 6000;
      
      if (this.plug === 7) {
        this.enabled = true;
        this.enableUser = true;
        this.state = 3;
        this.rampStartTime = Date.now();
        this.actualCurrentFraction = 0;
        this.startEPresBroadcast();
      }
    } else if (clampedPower === 0) {
      const oldState = this.state;
      this.targetPower = 0;
      this.currentPower = 0;
      this.actualCurrentFraction = 0;
      // Don't reset currentSetpoint/lastCurrUser (like real KEBA)
      this.state = this.plug === 7 ? 5 : 2;
      this.enabled = false;
      this.enableUser = false;
      this.stopEPresBroadcast();
      if (oldState !== this.state) {
        this.sendBroadcast({ "State": this.state });
      }
    } else {
      let requiredCurrent: number;
      
      if (this.phases === 1) {
        requiredCurrent = clampedPower / 230;
      } else {
        requiredCurrent = clampedPower / (Math.sqrt(3) * 400);
      }
      
      this.currentSetpoint = Math.round(requiredCurrent * 1000);
      this.lastCurrUser = this.currentSetpoint;
      this.targetPower = clampedPower;
      
      if (this.plug === 7) {
        const oldState = this.state;
        this.enabled = true;
        this.enableUser = true;
        this.state = 3;
        if (oldState !== 3) {
          this.rampStartTime = Date.now();
          this.actualCurrentFraction = 0;
          this.startEPresBroadcast();
        }
        if (oldState !== this.state) {
          this.sendBroadcast({ "State": this.state });
        }
      }
    }
  }

  /**
   * Liefert aktuelle Ladeleistung in Watt
   */
  getCurrentPower(): number {
    this.updateEnergyCounters();
    return Math.round(this.currentPower);
  }

  /**
   * Simuliert Kabelstecker-Event (für Testing)
   */
  plugCable(plugged: boolean): void {
    const oldPlug = this.plug;
    const oldState = this.state;
    
    if (plugged) {
      this.plug = 7;
      this.state = 2;
    } else {
      this.plug = 0;
      this.state = 1;
      this.enabled = false;
      this.enableUser = false;
      this.targetPower = 0;
      this.currentPower = 0;
      this.actualCurrentFraction = 0;
      this.stopEPresBroadcast();
    }
    
    if (oldPlug !== this.plug) {
      this.sendBroadcast({ "Plug": this.plug });
    }
    if (oldState !== this.state) {
      this.sendBroadcast({ "State": this.state });
    }
  }

  /**
   * Setzt Session-Energie zurück (neue Lade-Session)
   */
  resetSession(): void {
    this.sessionEnergy = 0;
  }

  /**
   * Setzt PV-Überschuss-Modus
   */
  setPvSurplusMode(enabled: boolean): void {
    this.pvSurplusMode = enabled;
    
    if (enabled) {
      this.phases = 1;
      this.maxCurrent = 32000;
    } else {
      this.phases = 3;
      this.maxCurrent = 16000;
    }
    
    if (this.state === 3) {
      this.calculateChargingPower();
    }
  }

  /**
   * Setzt die Phasen-Konfiguration
   */
  setPhases(phases: 1 | 3): void {
    this.phases = phases;
    this.maxCurrent = phases === 1 ? 32000 : 16000;
    
    if (this.state === 3) {
      this.calculateChargingPower();
    }
  }

  /**
   * Initialisiert den Mock mit Demo-Startwerten
   */
  initializeDemo(): void {
    this.totalEnergy = 31166830; // ~31.166 kWh like real wallbox
    this.sessionEnergy = 0;
    this.enabled = false;
    this.enableUser = false;
    this.state = 2;
    this.plug = 7;
    this.input = 0;
    this.currentSetpoint = 6000;
    this.lastCurrUser = 6000;
    this.currentPower = 0;
    this.targetPower = 0;
    this.actualCurrentFraction = 0;
    this.rampStartTime = 0;
    this.phases = 3;
    this.maxCurrent = 16000;
    this.pvSurplusMode = false;
    this.lastUpdateTime = Date.now();
    if (this.stateTransitionTimer) {
      clearTimeout(this.stateTransitionTimer);
      this.stateTransitionTimer = null;
    }
    this.stopEPresBroadcast();
  }

  /**
   * Registriert Broadcast-Callback
   */
  setBroadcastCallback(callback: (data: any) => void): void {
    this.broadcastCallback = callback;
  }

  /**
   * Sendet einen UDP-Broadcast
   */
  private sendBroadcast(data: any): void {
    if (this.broadcastCallback) {
      this.broadcastCallback(data);
    }
  }

  /**
   * Starts spontaneous E pres broadcasts (like real KEBA during State=3)
   * Real KEBA sends {"E pres": <value>} every 1-2s without being asked
   */
  private startEPresBroadcast(): void {
    this.stopEPresBroadcast();
    this.ePresBroadcastInterval = setInterval(() => {
      if (this.state === 3) {
        this.updateEnergyCounters();
        this.sendBroadcast({ "E pres": Math.round(this.sessionEnergy * 10) }); // 0.1Wh units
      }
    }, 1000 + Math.random() * 1000); // 1-2s random interval
  }

  /**
   * Stops spontaneous E pres broadcasts
   */
  private stopEPresBroadcast(): void {
    if (this.ePresBroadcastInterval) {
      clearInterval(this.ePresBroadcastInterval);
      this.ePresBroadcastInterval = null;
    }
  }

  getInput(): number {
    return this.input;
  }

  setInput(value: 0 | 1): void {
    if (this.input !== value) {
      this.input = value;
      this.sendBroadcast({ "Input": value });
    }
  }

  getPlugStatus(): number {
    return this.plug;
  }

  setPlugStatus(value: number): void {
    if (value < 0 || value > 7) return;
    
    if (this.plug !== value) {
      this.plug = value;
      this.sendBroadcast({ "Plug": value });
      
      if (value === 0) {
        this.state = 1;
        this.enabled = false;
        this.enableUser = false;
      } else if (value >= 3 && !this.enabled) {
        this.state = 2;
      }
    }
  }

  /**
   * Getter für E pres (Session-Energie in Wh) - für periodische Broadcasts
   */
  getEPres(): number {
    this.updateEnergyCounters();
    return Math.round(this.sessionEnergy);
  }

  /**
   * Returns the current ramp-up fraction (0-1) for testing
   */
  getRampFraction(): number {
    return this.actualCurrentFraction;
  }
}

// Singleton-Instanz
export const wallboxMockService = new WallboxMockService();

import type { ChargingStrategy, ChargingStrategyConfig, ChargingContext, E3dcLiveData } from "@shared/schema";
import { storage } from "../core/storage";
import { log } from "../core/logger";
import { e3dcClient } from "../e3dc/client";
import { getE3dcLiveDataHub } from "../e3dc/modbus";
import { triggerProwlEvent } from "../monitoring/prowl-notifier";
import { broadcastPartialUpdate } from "../wallbox/sse";
import { DEFAULT_WALLBOX_IP } from "../core/defaults";
import type { PhaseProvider } from "./phase-provider";

const PHASE_VOLTAGE_1P = 230;
const MIN_CURRENT_AMPERE = 6;
const MAX_CURRENT_1P_AMPERE = 32;
const MAX_CURRENT_3P_AMPERE = 16;
const MAX_BATTERY_CHARGING_POWER = 3000; // Batterie max Ladeleistung für surplus_battery_prio

export class ChargingStrategyController {
  private sendUdpCommand: (ip: string, command: string) => Promise<any>;
  private lastE3dcData: E3dcLiveData | null = null;
  private batteryDischargeSince: Date | null = null;
  private unsubscribeFromHub: (() => void) | null = null;
  private runningStrategyPromise: Promise<void> | null = null;
  private wallboxIp: string = DEFAULT_WALLBOX_IP;
  private isShuttingDown: boolean = false;
  private pendingE3dcData: E3dcLiveData | null = null;
  private lastPlugStatus: number = 1;  // Plug-Status: 1=kein Kabel, 7=Auto bereit
  private phaseProvider: PhaseProvider;
  
  constructor(sendUdpCommand: (ip: string, command: string) => Promise<any>, phaseProvider: PhaseProvider) {
    this.sendUdpCommand = sendUdpCommand;
    this.phaseProvider = phaseProvider;
  }

  /**
   * Stoppt NUR die Wallbox ohne Battery Lock zu ändern.
   * Wird verwendet für sofortige UI-Reaktion beim X1-Wechsel.
   * 
   * @param wallboxIp IP-Adresse der Wallbox
   * @param reason Optional: Grund für den Stopp (für Logging)
   */
  async stopChargingOnly(wallboxIp: string, reason?: string): Promise<void> {
    const startTime = Date.now();
    log('debug', 'system', `[X1-Optimierung] Wallbox-Stopp START - ${reason || 'kein Grund angegeben'}`);
    
    await this.stopCharging(wallboxIp, reason);
    
    const duration = Date.now() - startTime;
    log('debug', 'system', `[X1-Optimierung] Wallbox-Stopp ENDE - Dauer: ${duration}ms`);
  }

  /**
   * Aktiviert "Max Power without Battery" Strategie SOFORT.
   * Startet Wallbox mit 32A @ 1P ohne auf E3DC-Daten zu warten.
   * 
   * WICHTIG: Setzt NUR den Wallbox-Status (isActive, currentAmpere).
   * Die Strategie wird vom Aufrufer gesetzt (wallbox-broadcast-listener finally-Block).
   * 
   * Optimiert für schnelle UI-Reaktion:
   * 1. Wallbox SOFORT starten (32A @ 1P) - keine Verzögerung!
   * 2. Context updaten
   * 3. Battery Lock DANACH aktivieren (sequentiell, aber nach Wallbox-Start)
   */
  async activateMaxPowerImmediately(wallboxIp: string): Promise<void> {
    const startTime = Date.now();
    log('debug', 'system', '[X1-Optimierung] Max Power Aktivierung START');
    
    const settings = storage.getSettings();
    const context = storage.getChargingContext();
    
    // Guard: Prüfe ob bereits aktiv MIT max_without_battery
    // Verhindert redundante Aktivierungen bei wiederholten X1-Toggles
    if (context.isActive && context.strategy === "max_without_battery") {
      log('debug', 'system', '[X1-Optimierung] Strategie bereits aktiv - überspringe');
      return;
    }
    
    try {
      // Für max_without_battery: Verwende physicalPhaseSwitch aus Settings
      // Default 1P weil User's Setup: KEBA manueller Phasenschalter auf 1P fixiert
      // Begründung: Minimale Startleistung ~1380W (1P) vs ~4140W (3P)
      // User's PV: ~3kW → Surplus-Laden nur mit 1P praktikabel
      const config = settings?.chargingStrategy;
      const phases = config?.physicalPhaseSwitch ?? 1;  // Default 1P für User's Setup
      const maxCurrent = phases === 1 ? MAX_CURRENT_1P_AMPERE : MAX_CURRENT_3P_AMPERE;
      const targetAmpere = maxCurrent; // 32A @ 1P oder 16A @ 3P
      const targetCurrentMa = targetAmpere * 1000;
      
      log('debug', 'system', `[X1-Optimierung] Konfiguration: ${targetAmpere}A @ ${phases}P (physicalPhaseSwitch=${config?.physicalPhaseSwitch ?? 'default'})`);
      
      // 1. Wallbox SOFORT starten - KEINE Verzögerung durch Battery Lock!
      await this.sendUdpCommand(wallboxIp, "ena 1");
      await this.sendUdpCommand(wallboxIp, `curr ${targetCurrentMa}`);
      
      // 2. Context aktualisieren - OHNE strategy!
      // Strategie wird vom wallbox-broadcast-listener finally-Block gesetzt
      // Dies verhindert Race Conditions zwischen Context-Update und Strategie-Persistierung
      const now = new Date();
      storage.updateChargingContext({
        isActive: true,
        currentAmpere: targetAmpere,
        targetAmpere: targetAmpere,
        lastAdjustment: now.toISOString(),
        lastStartedAt: now.toISOString(),
        belowThresholdSince: undefined,
      });
      
      const duration = Date.now() - startTime;
      log('info', 'system', `Ladung gestartet mit ${targetAmpere}A @ ${phases}P - X1-Optimiert in ${duration}ms`);
      
      // 3. Battery Lock DANACH aktivieren (sequentiell, blockiert UI nicht mehr)
      if (settings?.e3dc?.enabled) {
        const controlState = storage.getControlState();
        if (!controlState.batteryLock) {
          log('info', 'system', '[X1-Optimierung] Battery Lock aktivieren (nach Wallbox-Start)');
          storage.saveControlState({ ...controlState, batteryLock: true });
          
          try {
            if (!e3dcClient.isConfigured()) {
              e3dcClient.configure(settings.e3dc);
            }
            await e3dcClient.lockDischarge();
            
            triggerProwlEvent(settings, "batteryLockActivated", (notifier) => 
              notifier.sendBatteryLockActivated()
            );
            log('debug', 'system', '[X1-Optimierung] Battery Lock erfolgreich aktiviert');
          } catch (error) {
            log('error', 'system', '[X1-Optimierung] Fehler beim Aktivieren der Entladesperre', 
              error instanceof Error ? error.message : String(error));
            storage.saveControlState({ ...controlState, batteryLock: false });
          }
        }
      }
      
      log('debug', 'system', `[X1-Optimierung] Max Power Aktivierung ENDE - Gesamt: ${Date.now() - startTime}ms`);
      
      // WICHTIG: Prowl-Notification wird vom Aufrufer gesendet (nach Strategie-Persistierung)
    } catch (error) {
      log('error', 'system', 
        '[X1-Optimierung] Fehler beim Starten der Ladung:',
        error instanceof Error ? error.message : String(error)
      );
      throw error;
    }
  }

  /**
   * Stoppt die Wallbox-Ladung wenn die Strategie auf "off" gesetzt wird.
   * 
   * OPTIMIERT für X1-Wechsel:
   * 1. Stoppt ZUERST die Wallbox (sofortige Reaktion)
   * 2. Deaktiviert dann Battery Lock (kann parallel laufen)
   * 3. Aktualisiert Context und Settings
   * 
   * Wird aufgerufen von:
   * - Scheduler bei activeStrategy === "off"
   * - Broadcast-Listener bei Input 0 (NICHT MEHR - verwendet nun stopChargingOnly)
   */
  async stopChargingForStrategyOff(wallboxIp: string): Promise<void> {
    const context = storage.getChargingContext();
    const settings = storage.getSettings();
    
    // Prüfe ob bereits alles im Zielzustand ist
    const alreadyStopped = !context.isActive;
    const alreadyOffStrategy = context.strategy === "off" && 
                                settings?.chargingStrategy?.activeStrategy === "off";
    
    // Wenn bereits alles gestoppt und auf "off" ist, komplett überspringen (keine Logs)
    if (alreadyStopped && alreadyOffStrategy) {
      log('debug', 'system', '[ChargingStrategyController] Wallbox bereits gestoppt und Strategie auf "off" - überspringe');
      return;
    }
    
    log('info', 'system', '[ChargingStrategyController] Strategie auf "off" → Wallbox wird gestoppt');
    
    // 1. Wallbox ZUERST stoppen (stopCharging ist idempotent, stoppt nur wenn isActive)
    await this.stopCharging(wallboxIp, "Ladung gestoppt");
    
    // 2. Battery Lock deaktivieren (falls E3DC aktiviert)
    await this.handleStrategyChange("off");
    
    // 3. Nur Strategie auf "off" setzen (stopCharging hat bereits isActive=false gesetzt)
    storage.updateChargingContext({ strategy: "off" });
    
    if (settings && settings.chargingStrategy) {
      settings.chargingStrategy.activeStrategy = "off";
      storage.saveSettings(settings);
    }
    
    log('info', 'system', '[ChargingStrategyController] Wallbox gestoppt, Strategie auf "off" gesetzt');
  }

  /**
   * Behandelt Strategie-Wechsel und aktiviert/deaktiviert Battery Lock
   * 
   * WICHTIG: Muss nach jedem Strategie-Wechsel aufgerufen werden!
   * - "Max Power without Battery" → Battery Lock aktivieren
   * - Alle anderen Strategien → Battery Lock deaktivieren
   */
  async handleStrategyChange(newStrategy: ChargingStrategy): Promise<void> {
    const settings = storage.getSettings();
    
    // Prüfe ob E3DC konfiguriert ist
    if (!settings?.e3dc?.enabled) {
      log('info', 'system', 'E3DC nicht aktiviert - Battery Lock Steuerung übersprungen');
      return;
    }

    // Prüfe ob e3dcClient konfiguriert wurde (wichtig!)
    if (!e3dcClient.isConfigured()) {
      log('warning', 'system', 'E3DC Client nicht konfiguriert - rufe configure() auf');
      try {
        e3dcClient.configure(settings.e3dc);
      } catch (error) {
        log('error', 'system', 'E3DC Client konnte nicht konfiguriert werden', error instanceof Error ? error.message : String(error));
        return;
      }
    }

    // Hole aktuellen Battery Lock Status
    const controlState = storage.getControlState();
    const currentBatteryLock = controlState.batteryLock ?? false;

    // Battery Lock nur für "Max Power without Battery" aktivieren
    if (newStrategy === "max_without_battery") {
      // Prüfe ob Lock bereits aktiv ist
      if (currentBatteryLock) {
        log('debug', 'system', 'Battery Lock bereits aktiviert - überspringe');
        return;
      }
      
      try {
        log('info', 'system', 'Strategie-Wechsel: Max Power ohne Batterie → Battery Lock aktivieren');
        
        // SOFORT Control State setzen (VOR dem await!) um Race Conditions zu vermeiden
        storage.saveControlState({ ...controlState, batteryLock: true });
        
        await e3dcClient.lockDischarge();
        
        // Prowl-Benachrichtigung (non-blocking, with initialization guard)
        triggerProwlEvent(settings, "batteryLockActivated", (notifier) => 
          notifier.sendBatteryLockActivated()
        );
      } catch (error) {
        log('error', 'system', 'Fehler beim Aktivieren der Entladesperre', error instanceof Error ? error.message : String(error));
        // Bei Fehler: State zurücksetzen
        storage.saveControlState({ ...controlState, batteryLock: false });
        throw error;
      }
    } else if (newStrategy === "off" || newStrategy === "surplus_battery_prio" || 
               newStrategy === "surplus_vehicle_prio" || newStrategy === "max_with_battery") {
      // Prüfe ob Lock bereits deaktiviert ist
      if (!currentBatteryLock) {
        log('debug', 'system', 'Battery Lock bereits deaktiviert - überspringe');
        return;
      }
      
      try {
        log('info', 'system', `Strategie-Wechsel: ${newStrategy} → Battery Lock deaktivieren`);
        
        // SOFORT Control State setzen (VOR dem await!) um Race Conditions zu vermeiden
        storage.saveControlState({ ...controlState, batteryLock: false });
        
        await e3dcClient.unlockDischarge();
        
        // Prowl-Benachrichtigung (non-blocking, with initialization guard)
        triggerProwlEvent(settings, "batteryLockDeactivated", (notifier) => 
          notifier.sendBatteryLockDeactivated()
        );
      } catch (error) {
        log('error', 'system', 'Fehler beim Deaktivieren der Entladesperre', error instanceof Error ? error.message : String(error));
        // Bei Fehler: State zurücksetzen
        storage.saveControlState({ ...controlState, batteryLock: true });
        throw error;
      }
    }
  }

  /**
   * Triggert einen sofortigen Check nach Strategiewechsel.
   * Vermeidet 0-15s Verzögerung durch Scheduler-Intervall.
   * 
   * Nutzt lastE3dcData als Fallback - wenn nicht verfügbar, wartet auf nächsten Scheduler-Run.
   * 
   * Wird aufgerufen von:
   * - /api/charging/strategy nach Strategiewechsel
   * - /api/wallbox/start nach manuellem Start
   */
  async triggerImmediateCheck(wallboxIp: string): Promise<void> {
    try {
      // Verwende gecachte E3DC-Daten (werden alle 15s vom Scheduler aktualisiert)
      if (!this.lastE3dcData) {
        log('debug', 'system', '[ImmediateCheck] Keine E3DC-Daten verfügbar - Scheduler wird Check nachholen');
        return;
      }
      
      // Führe normalen Strategy-Check mit gecachten Daten aus
      await this.processStrategy(this.lastE3dcData, wallboxIp);
      
      log('debug', 'system', '[ImmediateCheck] Sofortiger Check nach Strategiewechsel durchgeführt');
    } catch (error) {
      log(
        'warning',
        'system',
        '[ImmediateCheck] Sofortiger Check fehlgeschlagen (nicht kritisch, Scheduler übernimmt)',
        error instanceof Error ? error.message : String(error)
      );
      // Nicht kritisch - Scheduler wird Check nachholen
    }
  }

  async processStrategy(liveData: E3dcLiveData, wallboxIp: string): Promise<void> {
    this.lastE3dcData = liveData;
    
    const settings = storage.getSettings();
    if (!settings?.chargingStrategy) {
      return;
    }
    
    const config = settings.chargingStrategy;
    
    // WICHTIG: Prüfe "off"-Strategie VOR reconcile, um repetitive Stops zu vermeiden
    if (config.activeStrategy === "off") {
      // Verwende stopChargingForStrategyOff für idempotentes Stoppen
      await this.stopChargingForStrategyOff(wallboxIp);
      return;
    }
    
    // KRITISCH: Context mit echtem Wallbox-Status abgleichen
    await this.reconcileChargingContext(wallboxIp);
    
    const context = storage.getChargingContext();
    
    // Context-Strategie mit Config synchronisieren
    if (context.strategy !== config.activeStrategy) {
      storage.updateChargingContext({ strategy: config.activeStrategy });
    }
    
    const surplus = this.calculateSurplus(config.activeStrategy, liveData);
    storage.updateChargingContext({ calculatedSurplus: surplus });
    
    log("debug", "system", `Strategy: ${config.activeStrategy}, isActive: ${context.isActive}, surplus: ${surplus}W`);
    
    if (this.shouldStopCharging(config, surplus, liveData)) {
      log("debug", "system", `shouldStopCharging = true → stopCharging`);
      await this.stopCharging(wallboxIp, "Überschuss zu gering");
      return;
    }
    
    const result = this.calculateTargetCurrent(config, surplus, liveData);
    const currentPhases = context.currentPhases;
    log("debug", "system", `calculateTargetCurrent result: ${result ? `${result.currentMa}mA @ ${currentPhases}P` : 'null'}`);
    
    if (result === null) {
      if (context.isActive) {
        // WÄHREND aktiver Ladung: null bedeutet "Überschuss unter Mindest-Anpassungsleistung"
        
        // ABER: Bei surplus_vehicle_prio ist Auto-Phasenwechsel normal!
        // Wenn Phasen gerade geändert wurden (reconciliation), nicht sofort stoppen
        // - Wallbox wechselt von 1P auf 3P = das ist OK, lass sie laden
        // - Bei battery_prio: SOFORT stoppen (Batterie hat Vorrang, kein Spielraum)
        
        if (config.activeStrategy === "surplus_battery_prio") {
          log("info", "system", `[surplus_battery_prio] result=null && isActive → Batterie-Priorisierung: Überschuss reicht nicht (< 1380W @ 1P) - STOP`);
          await this.stopCharging(wallboxIp, "Batterie-Priorisierung: Überschuss unter Mindestleistung");
        } else {
          // surplus_vehicle_prio: Lass weiterlaufen, solange Wallbox aktiv ist
          // Wallbox kann sich selbst phasen (1P→3P) - das ist akzeptabel
          log("debug", "system", `[surplus_vehicle_prio] result=null aber isActive - Wallbox lädt weiter (Auto-Phasenwechsel akzeptiert)`);
        }
      }
      return;
    }
    
    if (!context.isActive) {
      log("debug", "system", `!isActive → prüfe shouldStartCharging`);
      if (this.shouldStartCharging(config, surplus)) {
        log("debug", "system", `shouldStartCharging = true → startCharging mit ${result.currentMa}mA @ ${currentPhases}P`);
        await this.startCharging(wallboxIp, result.currentMa, config);
      } else {
        log("debug", "system", `shouldStartCharging = false → warte noch`);
      }
    } else {
      log("debug", "system", `isActive → adjustCurrent mit ${result.currentMa}mA @ ${currentPhases}P`);
      await this.adjustCurrent(wallboxIp, result.currentMa, config);
    }
  }

  private calculateSurplus(strategy: ChargingStrategy, liveData: E3dcLiveData): number {
    // WICHTIG: E3DC liefert housePower MIT Wallbox-Anteil!
    // Für korrekte Überschuss-Berechnung muss Wallbox-Leistung abgezogen werden
    const housePowerWithoutWallbox = liveData.housePower - liveData.wallboxPower;
    
    switch (strategy) {
      case "surplus_battery_prio":
        // Batterie-Priorisierung: HAUSBATTERIE wird bevorzugt geladen
        // Hybride Logik für Batterie-Reservierung:
        // - Bis 95% SOC: Theoretische 3000W Reservierung (Batterie kann noch voll laden)
        // - Ab 95% SOC: Tatsächliche Batterieladeleistung (Ladung wird gedrosselt)
        const totalSurplus = liveData.pvPower - housePowerWithoutWallbox;
        
        let batteryReservation: number;
        const SOC_THRESHOLD = 95;
        
        if (liveData.batterySoc < SOC_THRESHOLD) {
          // Bis 95% SOC: Batterie bekommt theoretisch bis zu 3000W
          batteryReservation = Math.min(totalSurplus, MAX_BATTERY_CHARGING_POWER);
          log("debug", "system", 
            `[surplus_battery_prio] SOC=${liveData.batterySoc}% < ${SOC_THRESHOLD}% → Theoretische Reservierung: ${batteryReservation}W`
          );
        } else {
          // Ab 95% SOC: Verwende tatsächliche Batterieladeleistung (bei SOC=100% nur noch ~800W)
          batteryReservation = Math.max(0, liveData.batteryPower);
          log("debug", "system", 
            `[surplus_battery_prio] SOC=${liveData.batterySoc}% ≥ ${SOC_THRESHOLD}% → Tatsächliche Ladeleistung: ${batteryReservation}W`
          );
        }
        
        // Rest geht an Wallbox
        const surplusForWallbox = totalSurplus - batteryReservation;
        const surplusWithMargin = surplusForWallbox * 0.90; // 10% Sicherheitsmarge
        
        log("debug", "system", 
          `[surplus_battery_prio] PV=${liveData.pvPower}W, Haus(ohne WB)=${housePowerWithoutWallbox}W, ` +
          `Total-Überschuss=${totalSurplus}W, Batterie-Reserve=${batteryReservation}W (SOC=${liveData.batterySoc}%), ` +
          `Für Wallbox=${surplusForWallbox}W, Mit Marge=${Math.round(surplusWithMargin)}W`
        );
        
        return Math.max(0, surplusWithMargin);
      
      case "surplus_vehicle_prio": {
        const rawSurplus = liveData.pvPower - housePowerWithoutWallbox + Math.min(0, liveData.batteryPower);
        const surplus = Math.max(0, rawSurplus);
        
        if (rawSurplus !== surplus) {
          log("debug", "system", 
            `Surplus-Komponenten: PV=${liveData.pvPower}W, Haus=${liveData.housePower}W (ohne WB: ${housePowerWithoutWallbox}W), Batterie=${liveData.batteryPower}W → Raw=${rawSurplus}W → Final=${surplus}W`
          );
        }
        
        return surplus;
      }
      
      case "max_with_battery":
        // Maximale Leistung MIT Batterie: PV + Batterie-Discharge - Hausverbrauch (ohne Wallbox!)
        // batteryPower ist positiv wenn die Batterie lädt, negativ wenn sie entlädt
        // Für max Wallbox-Leistung nutzen wir Batterie-Entladung (abs)
        return Math.max(0, liveData.pvPower + Math.abs(Math.min(0, liveData.batteryPower)) - housePowerWithoutWallbox);
      
      case "max_without_battery":
        // Maximale Leistung OHNE Batterie: Nur PV - Hausverbrauch (ohne Wallbox!)
        return Math.max(0, liveData.pvPower - housePowerWithoutWallbox);
      
      default:
        return 0;
    }
  }

  private calculateTargetCurrent(
    config: ChargingStrategyConfig, 
    surplus: number,
    liveData: E3dcLiveData
  ): { currentMa: number } | null {
    const strategy = config.activeStrategy;
    const context = storage.getChargingContext();
    const settings = storage.getSettings();
    
    // WICHTIG: Phase-Logik
    // 1. Wenn NICHT aktiv:
    //    - Surplus-Strategien: IMMER 1 Phase (niedrige Startleistung ~1380W statt ~4140W)
    //    - Max Power Strategien: nutze physicalPhaseSwitch (Benutzer stellt manuell ein)
    //    - Im Demo-Modus: nutze mockWallboxPhases für alle Strategien
    // 2. Wenn aktiv → nutze context.currentPhases (echte erkannte Phasen aus Strömen)
    const isMaxPowerStrategy = strategy === "max_with_battery" || strategy === "max_without_battery";
    const isSurplusStrategy = strategy === "surplus_battery_prio" || strategy === "surplus_vehicle_prio";
    
    const currentPhases = context.isActive 
      ? context.currentPhases 
      : this.phaseProvider.getStartPhases(isSurplusStrategy, config);
    
    // Debug-Log für Phase-Entscheidung
    if (!context.isActive) {
      log("debug", "system", `Phase-Logik beim Start: ${currentPhases}P via ${this.phaseProvider.constructor.name}`);
    }
    
    if (isMaxPowerStrategy) {
      const maxCurrent = currentPhases === 1 ? MAX_CURRENT_1P_AMPERE : MAX_CURRENT_3P_AMPERE;
      return { currentMa: maxCurrent * 1000 };
    }
    
    // Surplus-Strategien: Prüfe ob genug Leistung für Mindest-Strom
    const minPower = MIN_CURRENT_AMPERE * PHASE_VOLTAGE_1P * currentPhases;
    if (surplus < minPower) {
      return null;
    }
    
    const maxCurrent = currentPhases === 1 ? MAX_CURRENT_1P_AMPERE : MAX_CURRENT_3P_AMPERE;
    
    let currentAmpere = Math.round(surplus / (PHASE_VOLTAGE_1P * currentPhases));
    currentAmpere = Math.max(MIN_CURRENT_AMPERE, Math.min(maxCurrent, currentAmpere));
    
    if (strategy === "surplus_vehicle_prio") {
      currentAmpere = this.applyBatteryProtection(currentAmpere, liveData);
    }
    
    return { currentMa: currentAmpere * 1000 };
  }


  private applyBatteryProtection(currentAmpere: number, liveData: E3dcLiveData): number {
    const DISCHARGE_THRESHOLD = -500;
    const DISCHARGE_DURATION_THRESHOLD = 120000;
    
    if (liveData.batteryPower < DISCHARGE_THRESHOLD) {
      if (!this.batteryDischargeSince) {
        this.batteryDischargeSince = new Date();
      }
      
      const dischargeDuration = Date.now() - this.batteryDischargeSince.getTime();
      
      if (dischargeDuration > DISCHARGE_DURATION_THRESHOLD) {
        const reductionAmpere = 2;
        log("info", "system", 
          `Strategie 2: Batterie-Entladung seit ${Math.floor(dischargeDuration / 1000)}s - Reduziere Ladestrom um ${reductionAmpere}A`,
          `Batterie-Leistung: ${liveData.batteryPower}W`
        );
        return Math.max(MIN_CURRENT_AMPERE, currentAmpere - reductionAmpere);
      }
    } else {
      this.batteryDischargeSince = null;
    }
    
    return currentAmpere;
  }

  private shouldStartCharging(config: ChargingStrategyConfig, surplus: number): boolean {
    const context = storage.getChargingContext();
    const now = new Date();
    const strategy = config.activeStrategy;
    
    log("debug", "system", `shouldStartCharging: strategy=${strategy}, surplus=${surplus}W, plug=${this.lastPlugStatus}`);
    
    // Max Power Strategien starten sofort ohne Delay - ABER nur wenn Auto angeschlossen
    if (strategy === "max_with_battery" || strategy === "max_without_battery") {
      if (this.lastPlugStatus !== 7) {
        log("debug", "system", `Max Power Strategie (${strategy}) → Kein Auto angeschlossen (Plug=${this.lastPlugStatus}) - return false`);
        return false;
      }
      log("debug", "system", `Max Power Strategie (${strategy}) → Auto bereit (Plug=7), Sofortstart ohne Delay - return true`);
      return true;
    }
    
    // Surplus-Strategien verwenden Start-Delay
    if (surplus < config.minStartPowerWatt) {
      if (context.startDelayTrackerSince) {
        storage.updateChargingContext({
          startDelayTrackerSince: undefined,
          remainingStartDelay: undefined,
        });
        log("debug", "system", "Start-Delay zurückgesetzt - Überschuss zu niedrig");
      }
      log("debug", "system", `surplus < minStartPowerWatt → return false`);
      return false;
    }
    
    if (!context.startDelayTrackerSince) {
      storage.updateChargingContext({
        startDelayTrackerSince: now.toISOString(),
        remainingStartDelay: config.startDelaySeconds, // Initial countdown
      });
      log("debug", "system", 
        `Start-Delay gestartet: Überschuss ${surplus}W > ${config.minStartPowerWatt}W - warte ${config.startDelaySeconds}s`
      );
      return false;
    }
    
    const waitingSince = new Date(context.startDelayTrackerSince);
    const waitingDuration = (now.getTime() - waitingSince.getTime()) / 1000;
    const remainingSeconds = Math.max(0, config.startDelaySeconds - waitingDuration);
    
    // Update remaining delay für Frontend-Countdown
    storage.updateChargingContext({
      remainingStartDelay: Math.ceil(remainingSeconds),
    });
    
    if (waitingDuration >= config.startDelaySeconds) {
      // WICHTIG: Auch bei Surplus-Strategien prüfen, ob Auto angeschlossen ist!
      if (this.lastPlugStatus !== 7) {
        log("info", "system", 
          `Start-Bedingung erfüllt: Überschuss ${surplus}W > ${config.minStartPowerWatt}W für ${waitingDuration}s, aber kein Auto angeschlossen (Plug=${this.lastPlugStatus}) - Stopp-Timer wird zurückgesetzt`
        );
        storage.updateChargingContext({
          startDelayTrackerSince: undefined,
          remainingStartDelay: undefined,
        });
        return false;
      }

      log("info", "system", 
        `Start-Bedingung erfüllt: Überschuss ${surplus}W > ${config.minStartPowerWatt}W für ${waitingDuration}s, Auto angeschlossen (Plug=7)`
      );
      storage.updateChargingContext({
        startDelayTrackerSince: undefined,
        remainingStartDelay: undefined,
      });
      return true;
    }
    
    log("debug", "system", `Warte noch ${remainingSeconds.toFixed(1)}s`);
    return false;
  }

  /**
   * Gleicht den gespeicherten Charging Context mit dem echten Wallbox-Status ab.
   * Verhindert, dass veraltete Zustände (z.B. isActive=true aus alter Sitzung) zu Fehlverhalten führen.
   */
  private async reconcileChargingContext(wallboxIp: string): Promise<void> {
    try {
      const [report2, report3] = await Promise.all([
        this.sendUdpCommand(wallboxIp, "report 2"),
        this.sendUdpCommand(wallboxIp, "report 3"),
      ]);
      
      const context = storage.getChargingContext();
      const wallboxState = report2.State;  // 0=startup, 1=idle, 2=waiting, 3=charging, 4=error, 5=auth
      const wallboxPower = report3.P || 0;  // Leistung in mW
      const currents = [report3.I1 || 0, report3.I2 || 0, report3.I3 || 0];  // Ströme in mA
      
      // Speichere Plug-Status (1=kein Kabel, 7=Auto bereit)
      this.lastPlugStatus = report2.Plug || 1;
      
      // Wallbox lädt wirklich, wenn State=3 UND Power>0
      const reallyCharging = wallboxState === 3 && wallboxPower > 1000;  // >1W
      
      // WICHTIG: Phasenerkennung nur bei Max-Power-Strategien!
      // Bei Surplus-Strategien: IMMER 1P (das ist das Design)
      // Wallbox mit Surplus startet mit 1P, bleibt bei 1P
      const config = storage.getSettings()?.chargingStrategy;
      const isMaxPowerStrategy = config?.activeStrategy === "max_with_battery" || config?.activeStrategy === "max_without_battery";
      
      let detectedPhases = 1;  // Standard: 1 Phase für Surplus
      
      if (isMaxPowerStrategy) {
        // Nur bei Max-Power: Erkenne echte Phasen aus Strömen (>500mA als "aktiv" betrachten)
        const activePhases = currents.filter(i => i > 500).length;
        detectedPhases = activePhases > 0 ? (activePhases === 1 ? 1 : 3) : 3;  // Default 3P bei Max-Power
      }
      
      // Korrigiere Context wenn nötig
      if (context.isActive && !reallyCharging) {
        log("info", "system", `[RECONCILE] Context sagt isActive=true, aber Wallbox lädt nicht (State=${wallboxState}, Power=${wallboxPower}mW) → setze isActive=false`);
        storage.updateChargingContext({
          isActive: false,
          currentAmpere: 0,
          targetAmpere: 0,
          currentPhases: detectedPhases,
        });
      } else if (!context.isActive && reallyCharging) {
        log("info", "system", `[RECONCILE] Context sagt isActive=false, aber Wallbox lädt (State=${wallboxState}, Power=${wallboxPower}mW) → setze isActive=true`);
        const avgCurrent = Math.round((currents[0] + currents[1] + currents[2]) / 1000 / (detectedPhases || 1));
        const now = new Date();
        storage.updateChargingContext({
          isActive: true,
          currentAmpere: avgCurrent,
          targetAmpere: avgCurrent,
          currentPhases: detectedPhases,
          lastStartedAt: now.toISOString(),  // Stabilisierungsphase auch bei Reconciliation
        });
      } else if (context.currentPhases !== detectedPhases && reallyCharging) {
        log("info", "system", `[RECONCILE] Phasen-Korrektur: ${context.currentPhases}P → ${detectedPhases}P (gemessen aus Strömen)`);
        storage.updateChargingContext({
          currentPhases: detectedPhases,
        });
      }
    } catch (error) {
      log("warning", "system", "Fehler beim Abgleich des Charging Context", error instanceof Error ? error.message : String(error));
    }
  }

  private shouldStopCharging(config: ChargingStrategyConfig, surplus: number, liveData: E3dcLiveData): boolean {
    const strategy = config.activeStrategy;
    
    if (strategy === "max_with_battery" || strategy === "max_without_battery") {
      return false;
    }
    
    const context = storage.getChargingContext();
    
    if (!context.isActive) {
      return false;
    }
    
    const now = new Date();
    
    // KRITISCH: Stabilisierungsphase nach Start!
    // E3DC-Daten brauchen Zeit, um die Wallbox-Last zu erfassen
    // Dauer = 2× Polling-Intervall (damit mindestens 1-2 E3DC-Updates erfolgen)
    // Ohne diese Phase: Sofortiger Stop wegen falscher Überschuss-Berechnung
    const settings = storage.getSettings();
    const pollingIntervalSeconds = settings?.e3dc?.pollingIntervalSeconds || 10;
    const STABILIZATION_PERIOD_MS = pollingIntervalSeconds * 2 * 1000;
    
    if (context.lastStartedAt) {
      const timeSinceStart = now.getTime() - new Date(context.lastStartedAt).getTime();
      
      if (timeSinceStart < STABILIZATION_PERIOD_MS) {
        const remainingStabilization = Math.ceil((STABILIZATION_PERIOD_MS - timeSinceStart) / 1000);
        log("debug", "system", 
          `[${strategy}] Stabilisierungsphase aktiv (${pollingIntervalSeconds}s × 2) - Stop-Prüfung unterdrückt für noch ${remainingStabilization}s (E3DC-Daten müssen Wallbox-Last erfassen)`
        );
        return false;
      }
    }
    
    // WICHTIG: surplus_battery_prio & surplus_vehicle_prio berechnen den Überschuss bereits OHNE Wallbox
    // (aus E3DC-Daten, wo housePowerWithoutWallbox die Wallbox nicht enthält)
    // Daher: surplus direkt verwenden, KEINE Wallbox-Addition!
    const availableSurplus = surplus;
    
    if (availableSurplus < config.stopThresholdWatt) {
      if (!context.belowThresholdSince) {
        storage.updateChargingContext({
          belowThresholdSince: now.toISOString(),
          remainingStopDelay: config.stopDelaySeconds, // Initial Stopp-Countdown
        });
        log("info", "system", 
          `[${strategy}] Überschuss unter Schwellwert: ${Math.round(availableSurplus)}W < ${config.stopThresholdWatt}W - Stopp-Timer gestartet`
        );
        return false;
      }
      
      const belowSince = new Date(context.belowThresholdSince);
      const duration = (now.getTime() - belowSince.getTime()) / 1000;
      const remainingSeconds = Math.max(0, config.stopDelaySeconds - duration);
      
      // Update remaining delay für Frontend-Countdown
      storage.updateChargingContext({
        remainingStopDelay: Math.ceil(remainingSeconds),
      });
      
      if (duration >= config.stopDelaySeconds) {
        log("info", "system", 
          `[${strategy}] Stopp-Bedingung erfüllt: Überschuss ${Math.round(availableSurplus)}W zu niedrig für ${Math.round(duration)}s (Schwellwert: ${config.stopThresholdWatt}W, Verzögerung: ${config.stopDelaySeconds}s)`
        );
        storage.updateChargingContext({
          belowThresholdSince: undefined,
          remainingStopDelay: undefined,
        });
        return true;
      } else {
        log("debug", "system", 
          `[${strategy}] Unter Schwellwert seit ${Math.round(duration)}s von ${config.stopDelaySeconds}s - warte noch ${remainingSeconds.toFixed(1)}s`
        );
      }
    } else {
      if (context.belowThresholdSince) {
        log("info", "system", 
          `[${strategy}] Überschuss wieder ausreichend: ${Math.round(availableSurplus)}W >= ${config.stopThresholdWatt}W - Stopp-Timer zurückgesetzt`
        );
        storage.updateChargingContext({
          belowThresholdSince: undefined,
          remainingStopDelay: undefined,
        });
      }
    }
    
    return false;
  }

  private async startCharging(wallboxIp: string, targetCurrentMa: number, config: ChargingStrategyConfig): Promise<void> {
    try {
      const context = storage.getChargingContext();
      const settings = storage.getSettings();
      
      // Guard: Prüfe ob Ladung bereits aktiv ist (verhindert doppelte Benachrichtigungen)
      const wasAlreadyActive = context.isActive;
      
      // Phasen über PhaseProvider bestimmen (entkoppelt Demo/Real)
      const currentPhases = this.phaseProvider.getStartPhases(false, config);
      const finalAmpere = targetCurrentMa / 1000;
      
      await this.sendUdpCommand(wallboxIp, "ena 1");
      await this.sendUdpCommand(wallboxIp, `curr ${targetCurrentMa}`);
      
      const now = new Date();
      storage.updateChargingContext({
        isActive: true,
        currentAmpere: finalAmpere,
        targetAmpere: finalAmpere,
        strategy: config.activeStrategy,
        lastAdjustment: now.toISOString(),
        lastStartedAt: now.toISOString(),
        belowThresholdSince: undefined,
      });
      
      // Nur beim ersten Start loggen und benachrichtigen
      if (!wasAlreadyActive) {
        log("info", "system", 
          `Ladung gestartet mit ${finalAmpere}A @ ${currentPhases}P (Strategie: ${config.activeStrategy})`
        );
        
        // Sofortiges SSE-Update an GUI (kein Warten auf nächsten Poll-Zyklus)
        broadcastPartialUpdate({ state: 3, enableSys: 1 });
        
        // Prowl-Benachrichtigung (non-blocking, with initialization guard)
        triggerProwlEvent(settings, "chargingStarted", (notifier) =>
          notifier.sendChargingStarted(finalAmpere, currentPhases, config.activeStrategy)
        );
      } else {
        log("debug", "system", 
          `Ladung bereits aktiv - Strom aktualisiert auf ${finalAmpere}A @ ${currentPhases}P`
        );
      }
    } catch (error) {
      log("error", "system", 
        "Fehler beim Starten der Ladung",
        error instanceof Error ? error.message : String(error)
      );
    }
  }

  private async adjustCurrent(wallboxIp: string, targetCurrentMa: number, config: ChargingStrategyConfig): Promise<void> {
    const context = storage.getChargingContext();
    // Für ADJUST: nutze context.currentPhases (echte erkannte Phasen beim Laden)
    const currentPhases = context.currentPhases;
    const finalAmpere = targetCurrentMa / 1000;
    
    const currentDiffAmpere = Math.abs(finalAmpere - context.currentAmpere);
    
    if (currentDiffAmpere >= config.minCurrentChangeAmpere) {
      // KRITISCH: Prüfe Debounce-Zeit BEVOR Stromanpassung!
      const debounceSeconds = config.minChangeIntervalSeconds || 30;
      const lastAdjustmentTime = context.lastAdjustment ? new Date(context.lastAdjustment).getTime() : 0;
      const now = Date.now();
      const timeSinceLastAdjustmentSeconds = (now - lastAdjustmentTime) / 1000;
      
      if (timeSinceLastAdjustmentSeconds < debounceSeconds) {
        // Zu wenig Zeit vergangen - nur targetAmpere updaten, aber nicht senden!
        const remainingSeconds = Math.ceil(debounceSeconds - timeSinceLastAdjustmentSeconds);
        log("debug", "system", 
          `Ladestrom-Anpassung gepuffert: ${context.currentAmpere}A → ${finalAmpere}A (Debounce: noch ${remainingSeconds}s warten)`
        );
        storage.updateChargingContext({
          targetAmpere: finalAmpere,
        });
        return; // Früher Abbruch - nicht senden!
      }
      
      // Genug Zeit vergangen - Strom anpassen
      try {
        await this.sendUdpCommand(wallboxIp, `curr ${targetCurrentMa}`);
        
        const nowDate = new Date();
        storage.updateChargingContext({
          currentAmpere: finalAmpere,
          targetAmpere: finalAmpere,
          lastAdjustment: nowDate.toISOString(),
        });
        
        log("info", "system", 
          `Ladestrom angepasst: ${context.currentAmpere}A → ${finalAmpere}A @ ${currentPhases}P`
        );
        
        // Prowl-Benachrichtigung nur bei signifikanten Änderungen (>= 4A)
        // Verhindert Spam bei kleinen Anpassungen
        const PROWL_THRESHOLD_AMPERE = 4;
        if (currentDiffAmpere >= PROWL_THRESHOLD_AMPERE) {
          const settingsForProwl = storage.getSettings();
          triggerProwlEvent(settingsForProwl, "currentAdjusted", (notifier) =>
            notifier.sendCurrentAdjusted(context.currentAmpere, finalAmpere, currentPhases)
          );
        }
      } catch (error) {
        log("error", "system", 
          "Fehler beim Anpassen des Ladestroms",
          error instanceof Error ? error.message : String(error)
        );
      }
    } else {
      storage.updateChargingContext({
        targetAmpere: finalAmpere,
      });
    }
  }

  private lastStopNotificationTime: number = 0;
  
  private async stopCharging(wallboxIp: string, reason?: string): Promise<void> {
    const context = storage.getChargingContext();
    
    if (!context.isActive) {
      return;
    }
    
    try {
      // Nur "ena 0" senden - KEBA akzeptiert kein "curr 0" (Minimum ist 6A)
      await this.sendUdpCommand(wallboxIp, "ena 0");
      
      storage.updateChargingContext({
        isActive: false,
        currentAmpere: 0,
        targetAmpere: 0,
        belowThresholdSince: undefined,
        remainingStopDelay: undefined,  // Timer zurücksetzen!
        lastAdjustment: undefined,
        lastStartedAt: undefined,  // Stabilisierungsphase zurücksetzen
      });
      
      this.batteryDischargeSince = null;
      
      log("info", "system", "Ladung gestoppt");
      
      // Sofortiges SSE-Update an GUI (kein Warten auf nächsten Poll-Zyklus)
      broadcastPartialUpdate({ state: 5, enableSys: 0 });
      
      // Prowl-Benachrichtigung mit Deduplication (max 1x pro 5 Sekunden)
      const now = Date.now();
      const timeSinceLastNotification = now - this.lastStopNotificationTime;
      const DEDUP_THRESHOLD_MS = 5000; // 5 Sekunden
      
      if (timeSinceLastNotification >= DEDUP_THRESHOLD_MS) {
        this.lastStopNotificationTime = now;
        const settingsForProwl = storage.getSettings();
        const stopReason = reason || (context.strategy.includes('surplus') ? 'Überschuss zu gering' : 'Ladung manuell gestoppt');
        triggerProwlEvent(settingsForProwl, "chargingStopped", (notifier) =>
          notifier.sendChargingStopped(stopReason)
        );
      } else {
        log("debug", "system", 
          `Prowl "Ladung gestoppt" Benachrichtigung übersprungen - zu früh nach letzter (${Math.round(timeSinceLastNotification / 1000)}s)`
        );
      }
    } catch (error) {
      log("error", "system", 
        "Fehler beim Stoppen der Ladung",
        error instanceof Error ? error.message : String(error)
      );
    }
  }

  async switchStrategy(newStrategy: ChargingStrategy, wallboxIp: string): Promise<void> {
    const context = storage.getChargingContext();
    const oldStrategy = context.strategy;
    
    if (oldStrategy === newStrategy) {
      log("debug", "system", `Strategie bereits aktiv: ${newStrategy}`);
      return;
    }
    
    log("info", "system", `Strategie-Wechsel: ${oldStrategy} → ${newStrategy}`);
    
    // Bei Strategie-Wechsel IMMER stoppen (falls aktiv), dann neu starten
    if (context.isActive) {
      await this.stopCharging(wallboxIp, "Strategie gewechselt");
      log("info", "system", "Laufende Ladung gestoppt für Strategie-Wechsel");
    }
    
    if (oldStrategy === "max_without_battery") {
      await e3dcClient.unlockDischarge();
      log("info", "system", "E3DC Battery Lock entfernt (alte Strategie)");
    }
    
    if (newStrategy === "max_without_battery") {
      await e3dcClient.lockDischarge();
      log("info", "system", "E3DC Battery Lock aktiviert (neue Strategie)");
    }
    
    if (newStrategy === "max_with_battery" || newStrategy === "max_without_battery") {
      storage.updateChargingContext({
        strategy: newStrategy,
      });
      
      log("debug", "system", `Max Power Strategie aktiviert - nächster Strategy Check startet Ladung`);
    } else if (newStrategy === "off") {
      storage.updateChargingContext({
        strategy: newStrategy,
      });
      log("info", "system", "Strategie auf 'off' gewechselt");
    } else {
      storage.updateChargingContext({
        strategy: newStrategy,
      });
      
      if (this.lastE3dcData) {
        await this.processStrategy(this.lastE3dcData, wallboxIp);
      }
    }
    
    this.batteryDischargeSince = null;
  }

  /**
   * Wrapper für processStrategy mit Promise-Tracking und Event-Queue
   * Verhindert overlapping strategy executions bei schnellen Broadcasts
   * Queued die neuesten E3DC-Daten wenn ein Run bereits läuft
   */
  private async processStrategyWithTracking(data: E3dcLiveData, wallboxIp: string): Promise<void> {
    // Wenn shutdown aktiv, breche ab
    if (this.isShuttingDown) {
      log("debug", "strategy", "Shutdown aktiv - überspringe neuen Strategy Check");
      return;
    }
    
    // Wenn bereits ein Strategy Check läuft, queue die neuesten Daten
    if (this.runningStrategyPromise) {
      log("debug", "strategy", "Strategy Check läuft bereits - queue neue E3DC-Daten für nächsten Run");
      this.pendingE3dcData = data;
      await this.runningStrategyPromise;
      return;
    }
    
    // Starte neuen Strategy Check
    this.runningStrategyPromise = (async () => {
      try {
        // Verarbeite aktuelle Daten
        await this.processStrategy(data, wallboxIp);
      } finally {
        // While-Loop in finally: Verhindert Event-Loss bei processStrategy-Errors
        while (this.pendingE3dcData && !this.isShuttingDown) {
          const nextData = this.pendingE3dcData;
          this.pendingE3dcData = null;
          log("debug", "strategy", "Verarbeite gequeuete E3DC-Daten - PV=" + nextData.pvPower + "W, SOC=" + nextData.batterySoc + "%");
          try {
            await this.processStrategy(nextData, wallboxIp);
          } catch (error) {
            log("error", "strategy", "Fehler beim Verarbeiten gequeueter E3DC-Daten", error instanceof Error ? error.message : String(error));
            // Continue loop auch bei Errors (verhindert Event-Loss)
          }
        }
        
        this.runningStrategyPromise = null;
      }
    })();
    
    await this.runningStrategyPromise;
  }

  /**
   * Startet Event-Listener für E3DC-Daten
   * Strategie: Event-driven (primär) + 15s-Timer (Fallback/Health-Check)
   * Guards: Stoppt vorherige Subscription bei Hot-Reloads (verhindert Listener-Leaks)
   */
  async startEventListener(wallboxIp: string): Promise<void> {
    // Guard: Stoppe vorherige Subscription falls vorhanden (verhindert Listener-Leaks bei Hot-Reloads)
    if (this.unsubscribeFromHub) {
      log("debug", "strategy", "Event-Listener bereits aktiv - stoppe vorherige Subscription");
      await this.stopEventListener();  // Graceful shutdown: wartet auf laufenden Promise
    }
    
    this.wallboxIp = wallboxIp;
    this.isShuttingDown = false;
    
    log("info", "strategy", "Charging Strategy Event-Listener wird gestartet - reagiert sofort auf E3DC-Daten");
    
    // Event-Listener: Sofort bei neuen E3DC-Daten
    const hub = getE3dcLiveDataHub();
    this.unsubscribeFromHub = hub.subscribe(async (data) => {
      // setImmediate: Nicht-blockierend, verhindert Event-Loop-Blockierung
      setImmediate(async () => {
        try {
          log("debug", "strategy", `Event empfangen: Neue E3DC-Daten verfügbar - PV=${data.pvPower}W, SOC=${data.batterySoc}%`);
          await this.processStrategyWithTracking(data, this.wallboxIp);
        } catch (error) {
          log(
            "error",
            "strategy",
            "Fehler im Event-Handler für Charging Strategy",
            error instanceof Error ? error.message : String(error)
          );
        }
      });
    });
    
    log("info", "strategy", "Event-Listener registriert - Charging Strategy wird event-driven aktualisiert");
  }

  /**
   * Stoppt Event-Listener (graceful shutdown, analog zu FHEM stopFhemSyncScheduler)
   * 1. Setze Shutdown-Flag (verhindert neue Strategy Checks)
   * 2. Unsubscribe sofort (verhindert neue Events)
   * 3. Warte auf laufenden Strategy Check (verhindert Abbruch während UDP-Kommunikation)
   */
  async stopEventListener(): Promise<void> {
    log("info", "strategy", "Stopping Charging Strategy Event-Listener");
    
    // Setze Shutdown-Flag BEVOR unsubscribe (verhindert Race mit laufendem Event)
    this.isShuttingDown = true;
    
    // Unsubscribe sofort (verhindert neue Events)
    if (this.unsubscribeFromHub) {
      this.unsubscribeFromHub();
      this.unsubscribeFromHub = null;
      log("debug", "strategy", "Event-Listener deregistriert - keine neuen Events");
    }
    
    // Warte auf laufenden Strategy-Check (verhindert Abbruch während Wallbox-Kommunikation)
    if (this.runningStrategyPromise) {
      log("debug", "strategy", "Warte auf laufenden Strategy-Check...");
      await this.runningStrategyPromise;
      log("debug", "strategy", "Laufender Strategy-Check abgeschlossen");
    }
    
    log("info", "strategy", "Event-Listener erfolgreich gestoppt");
  }

  getStatus() {
    const context = storage.getChargingContext();
    const settings = storage.getSettings();
    
    return {
      ...context,
      config: settings?.chargingStrategy || null,
      batteryDischarging: this.batteryDischargeSince !== null,
      batteryDischargeDurationMs: this.batteryDischargeSince 
        ? Date.now() - this.batteryDischargeSince.getTime() 
        : 0,
    };
  }
}

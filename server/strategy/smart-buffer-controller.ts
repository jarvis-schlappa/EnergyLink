import type { E3dcLiveData, Settings, SmartBufferConfig, SmartBufferPhase, SmartBufferStatus } from "@shared/schema";
import { storage } from "../core/storage";
import { log } from "../core/logger";
import { e3dcClient } from "../e3dc/client";
import { getE3dcLiveDataHub } from "../e3dc/modbus";
import { broadcastSmartBufferStatus } from "../wallbox/sse";

const DEFAULT_SMART_BUFFER_CONFIG: SmartBufferConfig = {
  latitude: 48.4,
  longitude: 10.0,
  pvArrays: [
    { name: "Wohnhaus SO", azimuthDeg: 140, tiltDeg: 43, kwp: 6.08 },
    { name: "Wohnhaus NW", azimuthDeg: 320, tiltDeg: 43, kwp: 2.56 },
    { name: "Gauben SW", azimuthDeg: 229, tiltDeg: 43, kwp: 1.28 },
  ],
  pvPeakKwp: 9.92,
  batteryCapacityKwh: 13.8,
  feedInLimitWatt: 4960,
  clippingGuardEntryWatt: 4300,
  clippingGuardExitWatt: 3800,
  clippingGuardTargetWatt: 4500,
  maxBatteryChargePower: 3000,
  targetSocEvening: 100,
  forecastRefreshIntervalMin: 15,
  winterRuleEndTimeUtc: "12:45",
  summerRuleEndTimeUtc: "15:00",
};

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function parseUtcHm(hm: string): { hour: number; minute: number } {
  const [h, m] = hm.split(":").map((v) => Number.parseInt(v, 10));
  return {
    hour: Number.isFinite(h) ? clamp(h, 0, 23) : 12,
    minute: Number.isFinite(m) ? clamp(m, 0, 59) : 0,
  };
}

export class SmartBufferController {
  private phase: SmartBufferPhase = "MORNING_HOLD";
  private status: SmartBufferStatus = {
    enabled: false,
    phase: "MORNING_HOLD",
    soc: 0,
    targetSoc: 100,
    regelzeitEnde: new Date().toISOString(),
    targetChargePowerWatt: 0,
    batteryChargeLimitWatt: 0,
    forecastKwh: 0,
    actualKwh: 0,
    feedInWatt: 0,
    phaseChanges: [],
  };
  private unsubscribeFromHub: (() => void) | null = null;
  private runningPromise: Promise<void> | null = null;
  private lastWallboxIp = "";
  private belowExitSince: Date | null = null;
  private lastForecastAt: Date | null = null;
  private lastForecastDay = "";
  private lastSampleAt: Date | null = null;
  private actualKwhDay = "";
  private lastProcessedAt = 0;
  private lastStatusBroadcastKey = "";

  getStatus(): SmartBufferStatus {
    return this.status;
  }

  shouldRunFallback(maxStaleMs = 20_000): boolean {
    if (this.lastProcessedAt === 0) {
      return true;
    }
    return Date.now() - this.lastProcessedAt > maxStaleMs;
  }

  private emitStatusUpdate(): void {
    const key = JSON.stringify({
      enabled: this.status.enabled,
      phase: this.status.phase,
      soc: this.status.soc,
      targetSoc: this.status.targetSoc,
      targetChargePowerWatt: this.status.targetChargePowerWatt,
      batteryChargeLimitWatt: this.status.batteryChargeLimitWatt,
      forecastKwh: this.status.forecastKwh,
      actualKwh: this.status.actualKwh,
      feedInWatt: this.status.feedInWatt,
      phaseChangesLen: this.status.phaseChanges.length,
    });

    if (key === this.lastStatusBroadcastKey) {
      return;
    }

    this.lastStatusBroadcastKey = key;
    broadcastSmartBufferStatus(this.status);
  }

  private resolveConfig(settings: Settings): SmartBufferConfig {
    return {
      ...DEFAULT_SMART_BUFFER_CONFIG,
      ...(settings.smartBuffer || {}),
    };
  }

  private getRuleEnd(now: Date, config: SmartBufferConfig): Date {
    const startOfYear = new Date(Date.UTC(now.getUTCFullYear(), 0, 0));
    const dayOfYear = Math.floor((now.getTime() - startOfYear.getTime()) / 86400000);
    const cosValue = Math.cos(((dayOfYear + 9) / 365) * 2 * Math.PI);

    const winter = parseUtcHm(config.winterRuleEndTimeUtc);
    const summer = parseUtcHm(config.summerRuleEndTimeUtc);
    const winterHours = winter.hour + winter.minute / 60;
    const summerHours = summer.hour + summer.minute / 60;
    const endHours = winterHours + ((summerHours - winterHours) / 2) * (1 - cosValue);

    const end = new Date(now);
    end.setUTCHours(Math.floor(endHours), Math.round((endHours % 1) * 60), 0, 0);
    return end;
  }

  private calculateFillUpTargetWatt(liveData: E3dcLiveData, config: SmartBufferConfig, now: Date): number {
    const ruleEnd = this.getRuleEnd(now, config);
    const remainingHours = (ruleEnd.getTime() - now.getTime()) / 3_600_000;
    const deltaSoc = Math.max(0, config.targetSocEvening - liveData.batterySoc);

    if (deltaSoc <= 0) {
      return 0;
    }

    if (remainingHours <= 0) {
      return config.maxBatteryChargePower;
    }

    const deltaKwh = (deltaSoc / 100) * config.batteryCapacityKwh;
    return clamp((deltaKwh / remainingHours) * 1000, 0, config.maxBatteryChargePower);
  }

  private async refreshForecastIfNeeded(config: SmartBufferConfig, now: Date): Promise<void> {
    const dayKey = now.toISOString().slice(0, 10);
    const refreshMs = config.forecastRefreshIntervalMin * 60_000;

    if (this.lastForecastAt && now.getTime() - this.lastForecastAt.getTime() < refreshMs && this.lastForecastDay === dayKey) {
      return;
    }

    this.lastForecastAt = now;
    this.lastForecastDay = dayKey;

    try {
      const responses = await Promise.all(
        config.pvArrays.map(async (array) => {
          const params = new URLSearchParams({
            latitude: String(config.latitude),
            longitude: String(config.longitude),
            minutely_15: "global_tilted_irradiance_instant",
            tilt: String(array.tiltDeg),
            azimuth: String(array.azimuthDeg - 180),
            forecast_minutely_15: "192",
            timeformat: "unixtime",
          });

          const response = await fetch(`https://api.open-meteo.com/v1/forecast?${params.toString()}`);
          if (!response.ok) {
            throw new Error(`Open-Meteo HTTP ${response.status}`);
          }

          const payload = await response.json() as {
            minutely_15?: {
              time?: number[];
              global_tilted_irradiance_instant?: number[];
            };
          };

          return {
            time: payload.minutely_15?.time ?? [],
            irradiance: payload.minutely_15?.global_tilted_irradiance_instant ?? [],
            kwp: array.kwp,
          };
        }),
      );

      const intervalCount = Math.min(...responses.map((r) => Math.min(r.time.length, r.irradiance.length)));
      let totalKwh = 0;
      const todayBerlin = now.toLocaleDateString("sv-SE", { timeZone: "Europe/Berlin" });

      for (let i = 0; i < intervalCount; i++) {
        const ts = responses[0]?.time[i];
        if (!Number.isFinite(ts)) {
          continue;
        }
        const intervalDayBerlin = new Date((ts as number) * 1000).toLocaleDateString("sv-SE", { timeZone: "Europe/Berlin" });
        if (intervalDayBerlin !== todayBerlin) {
          continue;
        }

        let totalKw = 0;
        for (const response of responses) {
          const irradiance = response.irradiance[i] ?? 0;
          totalKw += (irradiance / 1000) * response.kwp;
        }
        totalKwh += totalKw * 0.25;
      }

      this.status.forecastKwh = Number(totalKwh.toFixed(2));
    } catch (error) {
      log("warning", "strategy", "Smart Buffer: Open-Meteo Forecast fehlgeschlagen", error instanceof Error ? error.message : String(error));
    }
  }

  private pushPhaseChange(nextPhase: SmartBufferPhase, reason: string): void {
    if (nextPhase === this.phase) {
      return;
    }

    const from = this.phase;
    this.phase = nextPhase;
    this.status.phase = nextPhase;
    this.status.phaseChanges = [
      ...this.status.phaseChanges,
      {
        time: new Date().toISOString(),
        from,
        to: nextPhase,
        reason,
      },
    ].slice(-200);

    log("info", "strategy", `Smart Buffer: Phase ${from} -> ${nextPhase} (${reason})`);
  }

  private async applyBatteryLimit(desiredLimitWatt: number): Promise<void> {
    const settings = storage.getSettings();
    if (!settings?.e3dc?.enabled || !e3dcClient.isConfigured()) {
      return;
    }

    const rounded = Math.round(desiredLimitWatt);

    if (rounded <= 0) {
      if (this.status.batteryChargeLimitWatt !== 0) {
        await e3dcClient.setAutomaticMode();
        this.status.batteryChargeLimitWatt = 0;
      }
      return;
    }

    const delta = Math.abs(rounded - this.status.batteryChargeLimitWatt);
    if (delta < 100) {
      return;
    }

    await e3dcClient.setMaxChargePower(rounded);
    this.status.batteryChargeLimitWatt = rounded;
  }

  private updateActualPvEnergy(liveData: E3dcLiveData, now: Date): void {
    const dayKey = now.toISOString().slice(0, 10);

    if (this.actualKwhDay !== dayKey) {
      this.actualKwhDay = dayKey;
      this.status.actualKwh = 0;
      this.lastSampleAt = now;
      return;
    }

    if (!this.lastSampleAt) {
      this.lastSampleAt = now;
      return;
    }

    const deltaHours = clamp((now.getTime() - this.lastSampleAt.getTime()) / 3_600_000, 0, 0.5);
    this.lastSampleAt = now;

    if (deltaHours > 0) {
      this.status.actualKwh = Number((this.status.actualKwh + (Math.max(0, liveData.pvPower) / 1000) * deltaHours).toFixed(2));
    }
  }

  private isSmartBufferEnabled(settings: Settings | null): boolean {
    return settings?.chargingStrategy?.activeStrategy === "smart_buffer";
  }

  private async deactivate(reason: string): Promise<void> {
    if (!this.status.enabled && this.status.batteryChargeLimitWatt === 0) {
      return;
    }

    this.status.enabled = false;
    this.pushPhaseChange("MORNING_HOLD", reason);
    this.belowExitSince = null;

    try {
      await this.applyBatteryLimit(0);
    } catch (error) {
      log("warning", "strategy", "Smart Buffer: Automatik-Restore fehlgeschlagen", error instanceof Error ? error.message : String(error));
    }
    this.emitStatusUpdate();
  }

  async processLiveData(liveData: E3dcLiveData): Promise<void> {
    if (this.runningPromise) {
      return;
    }
    this.lastProcessedAt = Date.now();

    this.runningPromise = (async () => {
      try {
        const settings = storage.getSettings();
        const controlState = storage.getControlState();

        if (!this.isSmartBufferEnabled(settings) || controlState.nightCharging) {
          await this.deactivate("Smart Buffer pausiert");
          return;
        }

        if (!settings) {
          return;
        }

        this.status.enabled = true;

        const now = new Date();
        const config = this.resolveConfig(settings);

        this.updateActualPvEnergy(liveData, now);
        await this.refreshForecastIfNeeded(config, now);

        const feedInWatt = Math.max(0, -liveData.gridPower);
        this.status.feedInWatt = Math.round(feedInWatt);
        this.status.soc = Math.round(liveData.batterySoc);
        this.status.targetSoc = config.targetSocEvening;
        this.status.regelzeitEnde = this.getRuleEnd(now, config).toISOString();

        const fillUpTarget = this.calculateFillUpTargetWatt(liveData, config, now);
        const carConnected = liveData.wallboxPower > 100;
        const availableForBattery = Math.max(0, liveData.pvPower - liveData.housePower);
        let desiredFillUpPower = carConnected ? Math.min(fillUpTarget, availableForBattery) : fillUpTarget;

        if (liveData.gridPower > 0) {
          desiredFillUpPower = 0;
        }

        this.status.targetChargePowerWatt = Math.round(desiredFillUpPower);

        if (this.phase === "MORNING_HOLD") {
          if (feedInWatt > config.clippingGuardEntryWatt) {
            this.pushPhaseChange("CLIPPING_GUARD", `Einspeisung ${Math.round(feedInWatt)}W > ${config.clippingGuardEntryWatt}W`);
          } else if (desiredFillUpPower > 200) {
            this.pushPhaseChange("FILL_UP", "SOC-Ziel erfordert Nachladung");
          } else if (liveData.batterySoc >= 99) {
            this.pushPhaseChange("FULL", "SOC >= 99%");
          }
        } else if (this.phase === "CLIPPING_GUARD") {
          if (liveData.batterySoc >= 95) {
            this.pushPhaseChange("FILL_UP", "SOC >= 95%");
            this.belowExitSince = null;
          } else if (feedInWatt < config.clippingGuardExitWatt) {
            if (!this.belowExitSince) {
              this.belowExitSince = now;
            } else if (now.getTime() - this.belowExitSince.getTime() >= 60_000) {
              this.pushPhaseChange("MORNING_HOLD", `Einspeisung seit 60s < ${config.clippingGuardExitWatt}W`);
              this.belowExitSince = null;
            }
          } else {
            this.belowExitSince = null;
          }
        } else if (this.phase === "FILL_UP") {
          if (liveData.batterySoc >= 99) {
            this.pushPhaseChange("FULL", "SOC >= 99%");
          } else if (feedInWatt > config.clippingGuardEntryWatt) {
            this.pushPhaseChange("CLIPPING_GUARD", "Abregelschutz priorisiert");
          }
        } else if (this.phase === "FULL") {
          if (feedInWatt > config.clippingGuardEntryWatt) {
            this.pushPhaseChange("CLIPPING_GUARD", "Notfall-Abregelschutz");
          } else if (liveData.batterySoc < 95 && desiredFillUpPower > 200) {
            this.pushPhaseChange("FILL_UP", "SOC wieder unter Zielbereich");
          }
        }

        let desiredLimit = 0;

        if (this.phase === "CLIPPING_GUARD") {
          if (feedInWatt > config.feedInLimitWatt - 160) {
            desiredLimit = config.maxBatteryChargePower;
          } else {
            const errorWatt = feedInWatt - config.clippingGuardTargetWatt;
            const currentLimit = this.status.batteryChargeLimitWatt;

            if (Math.abs(errorWatt) <= 150) {
              desiredLimit = currentLimit;
            } else {
              const step = clamp(errorWatt, -500, 500);
              desiredLimit = clamp(currentLimit + step, 0, config.maxBatteryChargePower);
            }
          }
        } else if (this.phase === "FILL_UP") {
          desiredLimit = clamp(desiredFillUpPower, 0, config.maxBatteryChargePower);
        }

        await this.applyBatteryLimit(desiredLimit);
        this.emitStatusUpdate();
      } catch (error) {
        log("error", "strategy", "Smart Buffer Verarbeitung fehlgeschlagen", error instanceof Error ? error.message : String(error));
      } finally {
        this.runningPromise = null;
      }
    })();

    await this.runningPromise;
  }

  async handleStrategySwitch(oldStrategy: string | undefined, newStrategy: string | undefined): Promise<void> {
    if (oldStrategy === "smart_buffer" && newStrategy !== "smart_buffer") {
      await this.deactivate("Strategiewechsel weg von Smart Buffer");
      return;
    }

    if (newStrategy === "smart_buffer") {
      this.status.enabled = true;
      this.status.phase = this.phase;
      this.emitStatusUpdate();
    }
  }

  async startEventListener(wallboxIp: string): Promise<void> {
    this.lastWallboxIp = wallboxIp;
    if (this.unsubscribeFromHub) {
      this.unsubscribeFromHub();
      this.unsubscribeFromHub = null;
    }

    const hub = getE3dcLiveDataHub();
    this.unsubscribeFromHub = hub.subscribe((data) => {
      setImmediate(() => {
        void this.processLiveData(data);
      });
    });

    log("info", "strategy", "Smart Buffer Event-Listener gestartet");
  }

  async stopEventListener(): Promise<void> {
    if (this.unsubscribeFromHub) {
      this.unsubscribeFromHub();
      this.unsubscribeFromHub = null;
    }
    await this.deactivate("Smart Buffer gestoppt");
  }
}

let smartBufferController: SmartBufferController | null = null;

export function getSmartBufferController(): SmartBufferController {
  if (!smartBufferController) {
    smartBufferController = new SmartBufferController();
  }
  return smartBufferController;
}

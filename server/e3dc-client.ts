import {
  DefaultHomePowerPlantConnection,
  E3dcConnectionData,
  RijndaelJsAESCipherFactory,
  DefaultBatteryService,
  DefaultChargingService,
  DefaultLiveDataService,
  ChargingLimits,
} from 'easy-rscp';
import type { E3dcConfig, E3dcBatteryStatus } from '@shared/schema';

class E3dcClient {
  private connection: DefaultHomePowerPlantConnection | null = null;
  private batteryService: DefaultBatteryService | null = null;
  private chargingService: DefaultChargingService | null = null;
  private liveDataService: DefaultLiveDataService | null = null;
  private config: E3dcConfig | null = null;

  async connect(config: E3dcConfig): Promise<void> {
    if (!config.enabled || !config.ipAddress || !config.rscpPassword || !config.portalUsername || !config.portalPassword) {
      throw new Error('E3DC configuration incomplete');
    }

    this.config = config;
    
    const connectionData: E3dcConnectionData = {
      address: config.ipAddress,
      port: 5033,
      portalUser: config.portalUsername,
      portalPassword: config.portalPassword,
      rscpPassword: config.rscpPassword,
    };

    const aesFactory = new RijndaelJsAESCipherFactory(config.rscpPassword);
    this.connection = new DefaultHomePowerPlantConnection(connectionData, aesFactory);
    this.batteryService = new DefaultBatteryService(this.connection);
    this.chargingService = new DefaultChargingService(this.connection);
    this.liveDataService = new DefaultLiveDataService(this.connection);
  }

  async disconnect(): Promise<void> {
    if (this.connection) {
      await this.connection.disconnect();
      this.connection = null;
      this.batteryService = null;
      this.chargingService = null;
      this.liveDataService = null;
    }
  }

  async getBatteryStatus(): Promise<E3dcBatteryStatus> {
    if (!this.liveDataService || !this.chargingService) {
      throw new Error('E3DC not connected');
    }

    const powerState = await this.liveDataService.readPowerState();
    const chargingConfig = await this.chargingService.readConfiguration();

    return {
      soc: powerState.batteryChargingLevel,
      power: powerState.batteryDelivery,
      maxChargePower: chargingConfig.currentLimitations.maxCurrentChargingPower,
      maxDischargePower: chargingConfig.currentLimitations.maxCurrentDischargingPower,
      dischargeLocked: chargingConfig.currentLimitations.maxCurrentDischargingPower === 0,
    };
  }

  async lockDischarge(): Promise<void> {
    if (!this.chargingService) {
      throw new Error('E3DC not connected');
    }

    // Hole aktuelle Konfiguration
    const currentConfig = await this.chargingService.readConfiguration();

    // Setze Entladeleistung auf 0
    const newLimits: ChargingLimits = {
      maxCurrentChargingPower: currentConfig.currentLimitations.maxCurrentChargingPower,
      maxCurrentDischargingPower: 0, // Entladung sperren
      dischargeStartPower: currentConfig.currentLimitations.dischargeStartPower,
      chargingLimitationsEnabled: true,
    };

    await this.chargingService.writeLimits(newLimits);
  }

  async unlockDischarge(maxDischargePower: number = 5000): Promise<void> {
    if (!this.chargingService) {
      throw new Error('E3DC not connected');
    }

    // Hole aktuelle Konfiguration
    const currentConfig = await this.chargingService.readConfiguration();

    // Entferne Entladesperre
    const newLimits: ChargingLimits = {
      maxCurrentChargingPower: currentConfig.currentLimitations.maxCurrentChargingPower,
      maxCurrentDischargingPower: maxDischargePower,
      dischargeStartPower: currentConfig.currentLimitations.dischargeStartPower,
      chargingLimitationsEnabled: true,
    };

    await this.chargingService.writeLimits(newLimits);
  }

  isConnected(): boolean {
    return this.connection !== null;
  }
}

export const e3dcClient = new E3dcClient();

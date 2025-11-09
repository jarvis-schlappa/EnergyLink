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
  private config: E3dcConfig | null = null;

  configure(config: E3dcConfig): void {
    if (!config.enabled || !config.ipAddress || !config.rscpPassword || !config.portalUsername || !config.portalPassword) {
      throw new Error('E3DC configuration incomplete');
    }
    this.config = config;
  }

  disconnect(): void {
    this.config = null;
  }

  private createConnection(): DefaultHomePowerPlantConnection {
    if (!this.config) {
      throw new Error('E3DC not configured');
    }

    const connectionData: E3dcConnectionData = {
      address: this.config.ipAddress!,
      port: 5033,
      portalUser: this.config.portalUsername!,
      portalPassword: this.config.portalPassword!,
      rscpPassword: this.config.rscpPassword!,
    };

    const aesFactory = new RijndaelJsAESCipherFactory(this.config.rscpPassword!);
    return new DefaultHomePowerPlantConnection(connectionData, aesFactory);
  }

  async getBatteryStatus(): Promise<E3dcBatteryStatus> {
    const connection = this.createConnection();
    
    try {
      const liveDataService = new DefaultLiveDataService(connection);
      const chargingService = new DefaultChargingService(connection);

      const powerState = await liveDataService.readPowerState();
      const chargingConfig = await chargingService.readConfiguration();

      return {
        soc: powerState.batteryChargingLevel,
        power: powerState.batteryDelivery,
        maxChargePower: chargingConfig.currentLimitations.maxCurrentChargingPower,
        maxDischargePower: chargingConfig.currentLimitations.maxCurrentDischargingPower,
        dischargeLocked: chargingConfig.currentLimitations.maxCurrentDischargingPower === 0,
      };
    } finally {
      await connection.disconnect();
    }
  }

  async lockDischarge(): Promise<void> {
    const connection = this.createConnection();
    
    try {
      const chargingService = new DefaultChargingService(connection);

      const currentConfig = await chargingService.readConfiguration();

      // Setze Entladeleistung auf 0
      const newLimits: ChargingLimits = {
        maxCurrentChargingPower: currentConfig.currentLimitations.maxCurrentChargingPower,
        maxCurrentDischargingPower: 0, // Entladung sperren
        dischargeStartPower: currentConfig.currentLimitations.dischargeStartPower,
        chargingLimitationsEnabled: true,
      };

      await chargingService.writeLimits(newLimits);
    } finally {
      await connection.disconnect();
    }
  }

  async unlockDischarge(maxDischargePower: number = 5000): Promise<void> {
    const connection = this.createConnection();
    
    try {
      const chargingService = new DefaultChargingService(connection);
      
      // Hole aktuelle Konfiguration
      const currentConfig = await chargingService.readConfiguration();

      // Entferne Entladesperre
      const newLimits: ChargingLimits = {
        maxCurrentChargingPower: currentConfig.currentLimitations.maxCurrentChargingPower,
        maxCurrentDischargingPower: maxDischargePower,
        dischargeStartPower: currentConfig.currentLimitations.dischargeStartPower,
        chargingLimitationsEnabled: true,
      };

      await chargingService.writeLimits(newLimits);
    } finally {
      await connection.disconnect();
    }
  }

  isConfigured(): boolean {
    return this.config !== null && this.config.enabled === true;
  }
}

export const e3dcClient = new E3dcClient();

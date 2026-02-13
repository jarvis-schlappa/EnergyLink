import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Separator } from "@/components/ui/separator";
import { useToast } from "@/hooks/use-toast";
import { useQuery, useMutation } from "@tanstack/react-query";
import { queryClient, apiRequest } from "@/lib/queryClient";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import {
  settingsSchema,
  controlStateSchema,
  buildInfoSchema,
} from "@shared/schema";
import type { Settings, ControlState } from "@shared/schema";
import PageHeader from "@/components/PageHeader";
import BuildInfoDialog from "@/components/BuildInfoDialog";
import DemoModeSection from "@/components/settings/DemoModeSection";
import E3dcIntegrationSection from "@/components/settings/E3dcIntegrationSection";
import FhemSyncSection from "@/components/settings/FhemSyncSection";
import ProwlNotificationSection from "@/components/settings/ProwlNotificationSection";
import ChargingStrategySection from "@/components/settings/ChargingStrategySection";

export default function SettingsPage() {
  const { toast } = useToast();
  const formHydratedRef = useRef(false);
  const [showBuildInfoDialog, setShowBuildInfoDialog] = useState(false);

  // Lade Build-Info (nur einmal, keine Auto-Updates)
  const { data: buildInfoRaw } = useQuery({
    queryKey: ["/api/build-info"],
    staleTime: Infinity,
  });
  const buildInfoResult = buildInfoRaw
    ? buildInfoSchema.safeParse(buildInfoRaw)
    : null;
  const buildInfo = buildInfoResult?.success ? buildInfoResult.data : undefined;

  const {
    data: settings,
    isLoading: isLoadingSettings,
    isSuccess: settingsLoaded,
  } = useQuery<Settings>({
    queryKey: ["/api/settings"],
  });

  const { data: controlState, isLoading: isLoadingControls } =
    useQuery<ControlState>({
      queryKey: ["/api/controls"],
    });

  const form = useForm<Settings>({
    resolver: zodResolver(settingsSchema),
    defaultValues: {
      wallboxIp: "192.168.40.16",
      e3dcIp: "",
      pvSurplusOnUrl: "",
      pvSurplusOffUrl: "",
      nightChargingSchedule: {
        enabled: false,
        startTime: "00:00",
        endTime: "05:00",
      },
      e3dc: {
        enabled: false,
        dischargeLockEnableCommand: "",
        dischargeLockDisableCommand: "",
        gridChargeEnableCommand: "",
        gridChargeDisableCommand: "",
        gridChargeDuringNightCharging: false,
        modbusPauseSeconds: 3,
        pollingIntervalSeconds: 10,
      },
      chargingStrategy: {
        activeStrategy: "off",
        minStartPowerWatt: 1400,
        stopThresholdWatt: 1000,
        startDelaySeconds: 120,
        stopDelaySeconds: 300,
        minCurrentChangeAmpere: 1,
        minChangeIntervalSeconds: 60,
        inputX1Strategy: "max_without_battery",
      },
      prowl: {
        enabled: false,
        apiKey: "",
        events: {
          appStarted: false,
          chargingStarted: true,
          chargingStopped: true,
          currentAdjusted: false,
          plugConnected: false,
          plugDisconnected: false,
          batteryLockActivated: false,
          batteryLockDeactivated: false,
          gridChargingActivated: false,
          gridChargingDeactivated: false,
          gridFrequencyWarning: true,
          gridFrequencyCritical: true,
          strategyChanged: false,
          errors: false,
        },
      },
      gridFrequencyMonitor: {
        enabled: false,
        tier2Threshold: 0.1,
        tier3Threshold: 0.2,
        enableEmergencyCharging: true,
      },
      fhemSync: {
        enabled: false,
        host: "192.168.1.100",
        port: 7072,
      },
      demoMode: false,
      mockWallboxPhases: 3,
      mockWallboxPlugStatus: 7,
    },
  });

  const controlForm = useForm<ControlState>({
    resolver: zodResolver(controlStateSchema),
    defaultValues: {
      pvSurplus: false,
      nightCharging: false,
      batteryLock: false,
      gridCharging: false,
    },
  });

  useEffect(() => {
    if (settings) {
      const strategyDefaults = {
        activeStrategy: "off" as const,
        minStartPowerWatt: 1400,
        stopThresholdWatt: 1000,
        startDelaySeconds: 120,
        stopDelaySeconds: 300,
        minCurrentChangeAmpere: 1,
        minChangeIntervalSeconds: 60,
        inputX1Strategy: "max_without_battery" as const,
      };

      const prowlDefaults = {
        enabled: false,
        apiKey: "",
        events: {
          appStarted: false,
          chargingStarted: true,
          chargingStopped: true,
          currentAdjusted: false,
          plugConnected: false,
          plugDisconnected: false,
          batteryLockActivated: false,
          batteryLockDeactivated: false,
          gridChargingActivated: false,
          gridChargingDeactivated: false,
          gridFrequencyWarning: true,
          gridFrequencyCritical: true,
          strategyChanged: false,
          errors: false,
        },
      };

      const gridFrequencyMonitorDefaults = {
        enabled: false,
        tier2Threshold: 0.1,
        tier3Threshold: 0.2,
        enableEmergencyCharging: true,
      };

      const e3dcDefaults = {
        enabled: false,
        pollingIntervalSeconds: 10,
        prefix: "",
        dischargeLockEnableCommand: "",
        dischargeLockDisableCommand: "",
        gridChargeEnableCommand: "",
        gridChargeDisableCommand: "",
      };

      const fhemSyncDefaults = {
        enabled: false,
        host: "192.168.1.100",
        port: 7072,
      };

      form.reset({
        ...settings,
        e3dc: {
          ...e3dcDefaults,
          ...settings.e3dc,
        },
        fhemSync: {
          ...fhemSyncDefaults,
          ...settings.fhemSync,
        },
        chargingStrategy: {
          ...strategyDefaults,
          ...settings.chargingStrategy,
        },
        prowl: {
          ...prowlDefaults,
          ...settings.prowl,
          events: {
            ...prowlDefaults.events,
            ...settings.prowl?.events,
          },
        },
        gridFrequencyMonitor: {
          ...gridFrequencyMonitorDefaults,
          ...settings.gridFrequencyMonitor,
        },
      });
      formHydratedRef.current = true;
    }
  }, [settings, form]);

  useEffect(() => {
    if (controlState) {
      controlForm.reset(controlState);
    }
  }, [controlState, controlForm]);

  const saveSettingsMutation = useMutation({
    mutationFn: (data: Settings) => apiRequest("POST", "/api/settings", data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/settings"] });
      toast({
        title: "Einstellungen gespeichert",
        description: "Ihre Konfiguration wurde erfolgreich gespeichert.",
      });
    },
    onError: () => {
      // Bei Fehler: Settings neu laden um UI-Zustand zu synchronisieren
      queryClient.invalidateQueries({ queryKey: ["/api/settings"] });
      toast({
        title: "Fehler",
        description: "Die Einstellungen konnten nicht gespeichert werden.",
        variant: "destructive",
      });
    },
  });

  const handleSave = (data: Settings) => {
    saveSettingsMutation.mutate(data);
  };

  return (
    <div className="flex flex-col h-full">
      <div className="flex-1 overflow-y-auto pb-24 pt-6">
        <div className="max-w-2xl mx-auto px-4 space-y-6">
          <PageHeader
            title="Einstellungen"
            onLogoClick={() => setShowBuildInfoDialog(true)}
            isDemoMode={settings?.demoMode}
          />

          <form onSubmit={form.handleSubmit(handleSave)} className="space-y-6">
            <DemoModeSection
              form={form}
              settingsLoaded={settingsLoaded}
              formHydrated={formHydratedRef.current}
              saveSettingsMutation={saveSettingsMutation}
              isLoadingSettings={isLoadingSettings}
            />

            <Separator />

            <div className="space-y-2">
              <Label htmlFor="wallbox-ip" className="text-base font-medium">
                IP-Adresse Wallbox
              </Label>
              <Input
                id="wallbox-ip"
                type="text"
                placeholder="192.168.40.16"
                {...form.register("wallboxIp")}
                className="h-12"
                data-testid="input-wallbox-ip"
                disabled={form.watch("demoMode") ?? false}
              />
              <p className="text-xs text-muted-foreground">
                IP-Adresse Ihrer KEBA P20 Wallbox im lokalen Netzwerk
              </p>
            </div>

            <div className="space-y-2">
              <Label htmlFor="e3dc-ip" className="text-base font-medium">
                IP-Adresse Hauskraftwerk
              </Label>
              <Input
                id="e3dc-ip"
                type="text"
                placeholder="192.168.40.17"
                {...form.register("e3dcIp")}
                className="h-12"
                data-testid="input-e3dc-ip"
                disabled={form.watch("demoMode") ?? false}
              />
              <p className="text-xs text-muted-foreground">
                IP-Adresse Ihres E3DC S10 für Modbus TCP-Zugriff (Port 502)
              </p>
            </div>

            <Separator />

            <E3dcIntegrationSection form={form} />

            <Separator />

            <FhemSyncSection form={form} />

            <Separator />

            <ProwlNotificationSection
              form={form}
              saveSettingsMutation={saveSettingsMutation}
            />

            <Separator />

            <ChargingStrategySection form={form} />

            <Button
              type="submit"
              size="lg"
              className="w-full h-12 text-base font-medium"
              data-testid="button-save-settings"
              disabled={isLoadingSettings || saveSettingsMutation.isPending}
            >
              {saveSettingsMutation.isPending
                ? "Wird gespeichert..."
                : "Einstellungen speichern"}
            </Button>
          </form>
        </div>
      </div>

      <BuildInfoDialog
        open={showBuildInfoDialog}
        onOpenChange={setShowBuildInfoDialog}
        buildInfo={buildInfo}
      />
    </div>
  );
}

import { useState, useCallback, useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { PlugZap, Home, Terminal, Settings } from "lucide-react";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { settingsSchema } from "@shared/schema";
import type { Settings as SettingsType } from "@shared/schema";
import PageHeader from "@/components/PageHeader";
import BuildInfoDialog from "@/components/BuildInfoDialog";
import { buildInfoSchema } from "@shared/schema";
import WallboxTab from "@/components/settings/WallboxTab";
import E3dcTab from "@/components/settings/E3dcTab";
import FhemTab from "@/components/settings/FhemTab";
import SystemTab from "@/components/settings/SystemTab";

const TAB_CONFIG = [
  { value: "wallbox", label: "Wallbox", icon: PlugZap },
  { value: "e3dc", label: "E3DC", icon: Home },
  { value: "fhem", label: "FHEM", icon: Terminal },
  { value: "system", label: "System", icon: Settings },
] as const;

// Default settings for form initialization before server data arrives
const DEFAULT_SETTINGS: SettingsType = {
  wallboxIp: "192.168.40.16",
  e3dcIp: "",
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
    physicalPhaseSwitch: 3,
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
    tier2Threshold: 0.15,
    tier3Threshold: 0.2,
    enableEmergencyCharging: true,
  },
  fhemSync: {
    enabled: false,
    host: "192.168.1.100",
    port: 7072,
    autoCloseGarageOnPlug: false,
  },
  demoMode: false,
  mockWallboxPhases: 3,
  mockWallboxPlugStatus: 7,
};

export default function SettingsPage() {
  const [activeTab, setActiveTab] = useState("wallbox");
  const [dirtyTabs, setDirtyTabs] = useState<Record<string, boolean>>({});
  const [pendingTab, setPendingTab] = useState<string | null>(null);
  const [showBuildInfoDialog, setShowBuildInfoDialog] = useState(false);

  const {
    data: rawSettings,
    isSuccess: settingsLoaded,
  } = useQuery<SettingsType>({
    queryKey: ["/api/settings"],
  });

  // Merge server settings with defaults (memoized to keep stable reference)
  const settings: SettingsType = useMemo(() => rawSettings
    ? {
        ...DEFAULT_SETTINGS,
        ...rawSettings,
        e3dc: { ...DEFAULT_SETTINGS.e3dc!, ...rawSettings.e3dc },
        chargingStrategy: { ...DEFAULT_SETTINGS.chargingStrategy!, ...rawSettings.chargingStrategy },
        prowl: {
          ...DEFAULT_SETTINGS.prowl!,
          ...rawSettings.prowl,
          events: { ...DEFAULT_SETTINGS.prowl!.events, ...rawSettings.prowl?.events },
        },
        gridFrequencyMonitor: { ...DEFAULT_SETTINGS.gridFrequencyMonitor!, ...rawSettings.gridFrequencyMonitor },
        fhemSync: { ...DEFAULT_SETTINGS.fhemSync!, ...rawSettings.fhemSync },
      }
    : DEFAULT_SETTINGS, [rawSettings]);

  // Build info for the dialog
  const { data: buildInfoRaw } = useQuery({
    queryKey: ["/api/build-info"],
    staleTime: Infinity,
  });
  const buildInfoResult = buildInfoRaw ? buildInfoSchema.safeParse(buildInfoRaw) : null;
  const buildInfo = buildInfoResult?.success ? buildInfoResult.data : undefined;

  const handleDirtyChange = useCallback((tab: string) => (dirty: boolean) => {
    setDirtyTabs((prev) => {
      if (prev[tab] === dirty) return prev;
      return { ...prev, [tab]: dirty };
    });
  }, []);

  const handleTabChange = useCallback((newTab: string) => {
    if (dirtyTabs[activeTab]) {
      setPendingTab(newTab);
    } else {
      setActiveTab(newTab);
    }
  }, [activeTab, dirtyTabs]);

  const confirmTabSwitch = useCallback(() => {
    if (pendingTab) {
      setActiveTab(pendingTab);
      setPendingTab(null);
    }
  }, [pendingTab]);

  const cancelTabSwitch = useCallback(() => {
    setPendingTab(null);
  }, []);

  return (
    <div className="flex flex-col h-full">
      <div className="flex-1 overflow-y-auto pb-24 pt-6">
        <div className="max-w-2xl mx-auto px-4 space-y-6">
          <PageHeader
            title="Einstellungen"
            onLogoClick={() => setShowBuildInfoDialog(true)}
            isDemoMode={settings.demoMode}
          />

          <Tabs value={activeTab} onValueChange={handleTabChange}>
            <TabsList data-testid="settings-tabs-list">
              {TAB_CONFIG.map(({ value, label, icon: Icon }) => (
                <TabsTrigger key={value} value={value} data-testid={`tab-${value}`}>
                  <Icon className="w-4 h-4 mr-1.5" />
                  <span>{label}</span>
                  {dirtyTabs[value] && (
                    <span
                      className="ml-1.5 w-2 h-2 rounded-full bg-orange-500 inline-block"
                      data-testid={`dirty-indicator-${value}`}
                    />
                  )}
                </TabsTrigger>
              ))}
            </TabsList>

            <TabsContent value="wallbox">
              <WallboxTab
                settings={settings}
                onDirtyChange={handleDirtyChange("wallbox")}
              />
            </TabsContent>

            <TabsContent value="e3dc">
              <E3dcTab
                settings={settings}
                onDirtyChange={handleDirtyChange("e3dc")}
              />
            </TabsContent>

            <TabsContent value="fhem">
              <FhemTab
                settings={settings}
                onDirtyChange={handleDirtyChange("fhem")}
              />
            </TabsContent>

            <TabsContent value="system">
              <SystemTab
                settings={settings}
                settingsLoaded={settingsLoaded}
                onDirtyChange={handleDirtyChange("system")}
              />
            </TabsContent>
          </Tabs>
        </div>
      </div>

      {/* Tab-Wechsel-Guard Dialog */}
      <Dialog open={pendingTab !== null} onOpenChange={(open) => !open && cancelTabSwitch()}>
        <DialogContent data-testid="dialog-unsaved-changes">
          <DialogHeader>
            <DialogTitle>Ungespeicherte Änderungen</DialogTitle>
            <DialogDescription>
              Du hast ungespeicherte Änderungen in diesem Tab. Möchtest du diese verwerfen?
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={cancelTabSwitch} data-testid="button-cancel-tab-switch">
              Abbrechen
            </Button>
            <Button variant="destructive" onClick={confirmTabSwitch} data-testid="button-confirm-tab-switch">
              Verwerfen
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <BuildInfoDialog
        open={showBuildInfoDialog}
        onOpenChange={setShowBuildInfoDialog}
        buildInfo={buildInfo}
      />
    </div>
  );
}

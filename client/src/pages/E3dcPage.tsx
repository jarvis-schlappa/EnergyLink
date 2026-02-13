import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Battery, Home as HomeIcon, Sun, Grid3x3, AlertCircle, AlertTriangle, CheckCircle, Circle, PlugZap, ShieldOff, Zap, Clock, Settings as SettingsIcon } from "lucide-react";
import { useQuery, useMutation } from "@tanstack/react-query";
import type { E3dcLiveData, Settings, ControlState } from "@shared/schema";
import { buildInfoSchema } from "@shared/schema";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { useState, useEffect } from "react";
import { format } from "date-fns";
import { de } from "date-fns/locale";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { queryClient, apiRequest } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import PageHeader from "@/components/PageHeader";
import BuildInfoDialog from "@/components/BuildInfoDialog";
import BatteryControlDrawer from "@/components/e3dc/BatteryControlDrawer";
import E3dcConsoleDialog from "@/components/e3dc/E3dcConsoleDialog";

export default function E3dcPage() {
  const [showBatteryDrawer, setShowBatteryDrawer] = useState(false);
  const [showBuildInfoDialog, setShowBuildInfoDialog] = useState(false);
  const [showE3dcConsole, setShowE3dcConsole] = useState(false);
  const [relativeUpdateTime, setRelativeUpdateTime] = useState<string>("");
  const [e3dcOperationLocks, setE3dcOperationLocks] = useState({
    batteryLock: false,
    gridCharging: false,
  });
  const { toast } = useToast();

  // Lade Build-Info (nur einmal, keine Auto-Updates)
  const { data: buildInfoRaw } = useQuery({
    queryKey: ["/api/build-info"],
    staleTime: Infinity,
  });
  const buildInfoResult = buildInfoRaw ? buildInfoSchema.safeParse(buildInfoRaw) : null;
  const buildInfo = buildInfoResult?.success ? buildInfoResult.data : undefined;

  const { data: settings, isLoading: isLoadingSettings } = useQuery<Settings>({
    queryKey: ["/api/settings"],
  });

  const { data: controlState, isLoading: isLoadingControls } = useQuery<ControlState>({
    queryKey: ["/api/controls"],
    refetchInterval: 5000,
  });

  const { data: e3dcData, isLoading, error, refetch } = useQuery<E3dcLiveData>({
    queryKey: ["/api/e3dc/live-data"],
    refetchInterval: 5000,
  });

  // Berechne Frequenz-Tier direkt aus dem Wert
  const calculateFrequencyTier = (frequency: number | undefined): number => {
    if (!frequency || frequency === 0) return 0;
    const deviation = Math.abs(frequency - 50.0);
    if (deviation <= 0.1) return 1;
    if (deviation <= 0.2) return 2;
    return 3;
  };
  
  const frequencyTier = calculateFrequencyTier(e3dcData?.gridFrequency);

  const updateControlsMutation = useMutation({
    mutationFn: (newState: ControlState) =>
      apiRequest("POST", "/api/controls", newState),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/controls"] });
    },
    onError: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/controls"] });
    },
  });

  const updateSettingsMutation = useMutation({
    mutationFn: (newSettings: Settings) =>
      apiRequest("POST", "/api/settings", newSettings),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/settings"] });
    },
    onError: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/settings"] });
    },
  });

  // Formatiere Leistungswerte
  const formatPower = (watts: number) => {
    if (watts === 0) return "0 W";
    if (Math.abs(watts) >= 10000) {
      return `${(watts / 1000).toFixed(1)} kW`;
    }
    return `${Math.round(watts)} W`;
  };

  const isDemoMode = settings?.demoMode === true;
  const actualHousePower = (e3dcData?.housePower || 0) - (e3dcData?.wallboxPower || 0);
  const isE3dcEnabled = settings?.e3dc?.enabled === true;

  // Formatiere relative Zeit (Deutsch)
  const formatRelativeTime = (timestamp: string) => {
    const now = new Date();
    const then = new Date(timestamp);
    const diffInSeconds = Math.floor((now.getTime() - then.getTime()) / 1000);

    if (diffInSeconds < 0) return 'gerade eben';
    if (diffInSeconds === 0) return 'gerade eben';
    if (diffInSeconds === 1) return 'vor 1 Sekunde';
    if (diffInSeconds < 60) return `vor ${diffInSeconds} Sekunden`;
    if (diffInSeconds < 120) return 'vor 1 Minute';
    if (diffInSeconds < 3600) {
      const minutes = Math.floor(diffInSeconds / 60);
      return `vor ${minutes} Minuten`;
    }
    if (diffInSeconds < 7200) return 'vor 1 Stunde';
    const hours = Math.floor(diffInSeconds / 3600);
    return `vor ${hours} Stunden`;
  };

  useEffect(() => {
    if (!e3dcData?.timestamp) {
      setRelativeUpdateTime("");
      return;
    }

    const updateRelativeTime = () => {
      setRelativeUpdateTime(formatRelativeTime(e3dcData.timestamp!));
    };

    updateRelativeTime();
    const interval = setInterval(updateRelativeTime, 1000);

    return () => clearInterval(interval);
  }, [e3dcData?.timestamp]);

  const handleControlChange = (field: keyof ControlState, value: boolean) => {
    if (!controlState) return;
    
    if (field === 'batteryLock' || field === 'gridCharging') {
      const modbusPauseSeconds = settings?.e3dc?.modbusPauseSeconds ?? 3;
      const totalLockDuration = modbusPauseSeconds * 2 * 1000;
      
      setE3dcOperationLocks(prev => ({ ...prev, [field]: true }));
      
      setTimeout(() => {
        setE3dcOperationLocks(prev => ({ ...prev, [field]: false }));
      }, totalLockDuration);
    }
    
    const fullState: ControlState = {
      pvSurplus: controlState.pvSurplus,
      batteryLock: field === 'batteryLock' ? value : controlState.batteryLock,
      gridCharging: field === 'gridCharging' ? value : controlState.gridCharging,
      nightCharging: controlState.nightCharging,
    };
    
    queryClient.setQueryData(["/api/controls"], fullState);
    
    updateControlsMutation.mutate(fullState, {
      onError: () => {
        if (field === 'batteryLock' || field === 'gridCharging') {
          setE3dcOperationLocks(prev => ({ ...prev, [field]: false }));
        }
      }
    });
  };

  const handleGridChargeDuringNightChange = (value: boolean) => {
    if (!settings) return;
    
    const updatedSettings: Settings = {
      ...settings,
      e3dc: {
        enabled: settings.e3dc?.enabled || false,
        modbusPauseSeconds: settings.e3dc?.modbusPauseSeconds ?? 3,
        pollingIntervalSeconds: settings.e3dc?.pollingIntervalSeconds ?? 10,
        prefix: settings.e3dc?.prefix,
        dischargeLockEnableCommand: settings.e3dc?.dischargeLockEnableCommand,
        dischargeLockDisableCommand: settings.e3dc?.dischargeLockDisableCommand,
        gridChargeEnableCommand: settings.e3dc?.gridChargeEnableCommand,
        gridChargeDisableCommand: settings.e3dc?.gridChargeDisableCommand,
        gridChargeDuringNightCharging: value,
      },
    };
    
    updateSettingsMutation.mutate(updatedSettings);
  };

  return (
    <div className="flex flex-col h-full">
      <div className="flex-1 overflow-y-auto pb-24 pt-6">
        <div className="max-w-2xl mx-auto px-4 space-y-6">
          <PageHeader
            title="Hauskraftwerk"
            onLogoClick={() => setShowBuildInfoDialog(true)}
            isDemoMode={isDemoMode}
          />

          {/* Fehler-Ansicht */}
          {error ? (
            <Card className="max-w-md">
              <CardHeader>
                <div className="flex items-center gap-2 text-destructive">
                  <AlertCircle className="w-5 h-5" />
                  <CardTitle>Verbindungsfehler</CardTitle>
                </div>
              </CardHeader>
              <CardContent className="space-y-4">
                <p className="text-sm text-muted-foreground">
                  {settings?.e3dcIp 
                    ? `Verbindung zum E3DC S10 (${settings.e3dcIp}) fehlgeschlagen.`
                    : "Verbindung zum E3DC S10 fehlgeschlagen."}
                </p>
                <p className="text-xs text-muted-foreground">
                  Fehler: {error instanceof Error ? error.message : String(error)}
                </p>
                <Button onClick={() => refetch()} className="w-full" data-testid="button-retry">
                  Erneut versuchen
                </Button>
              </CardContent>
            </Card>
          ) : (
            <div className="space-y-4">
            {/* Hausbatterie - Kombinierte Kachel */}
            <Card 
              className={`p-6 relative ${isE3dcEnabled ? 'cursor-pointer hover-elevate active-elevate-2' : ''}`}
              onClick={() => isE3dcEnabled && setShowBatteryDrawer(true)}
              data-testid="card-battery"
            >
              {isLoading ? (
                <Skeleton className="h-24 w-full" />
              ) : e3dcData ? (
                <div>
                  <div className="flex items-center gap-2 mb-4">
                    <Battery className="w-5 h-5 text-muted-foreground" />
                    <span className="text-base font-semibold">Hausbatterie</span>
                    {isE3dcEnabled && (controlState?.batteryLock || controlState?.gridCharging || settings?.e3dc?.gridChargeDuringNightCharging) && (
                      <div className="flex items-center gap-1.5 ml-1">
                        {controlState?.batteryLock && (
                          <ShieldOff className="w-4 h-4 text-muted-foreground" data-testid="icon-battery-lock-active" />
                        )}
                        {controlState?.gridCharging && (
                          <Zap className="w-4 h-4 text-muted-foreground" data-testid="icon-grid-charging-active" />
                        )}
                        {settings?.e3dc?.gridChargeDuringNightCharging && (
                          <Clock className="w-4 h-4 text-muted-foreground" data-testid="icon-grid-charge-night-active" />
                        )}
                      </div>
                    )}
                  </div>
                  
                  <div className="space-y-2">
                    <div className="flex items-center justify-between">
                      <span className="text-sm text-muted-foreground">Ladezustand (SOC)</span>
                      <span className="text-xl font-bold" data-testid="text-battery-soc">
                        {e3dcData.batterySoc}%
                      </span>
                    </div>
                    
                    <div className="flex items-center justify-between">
                      <span className="text-sm text-muted-foreground">Leistung</span>
                      <span className="text-xl font-bold" data-testid="text-battery-power">
                        {e3dcData.batteryPower < 0 ? '-' : ''}{formatPower(Math.abs(e3dcData.batteryPower))}
                      </span>
                    </div>
                  </div>
                </div>
              ) : null}
              {isE3dcEnabled && (
                <TooltipProvider>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <div className="absolute top-3 right-3">
                        <SettingsIcon 
                          className="w-4 h-4 text-muted-foreground" 
                          data-testid="icon-config-indicator-battery"
                        />
                      </div>
                    </TooltipTrigger>
                    <TooltipContent>
                      <p>Konfiguration verfügbar</p>
                    </TooltipContent>
                  </Tooltip>
                </TooltipProvider>
              )}
            </Card>

            {/* PV, Wallbox, Hausverbrauch, Netz - 2x2 Grid */}
            <div className="grid grid-cols-2 gap-3">
              <Card className="p-6">
                {isLoading ? (
                  <Skeleton className="h-16 w-full" />
                ) : e3dcData ? (
                  <div>
                    <div className="flex items-center gap-2 mb-3">
                      <Sun className="w-4 h-4 text-muted-foreground" />
                      <span className="text-base font-semibold">PV</span>
                    </div>
                    <div className="text-2xl font-bold" data-testid="text-pv-power">
                      {formatPower(e3dcData.pvPower)}
                    </div>
                  </div>
                ) : null}
              </Card>

              <Card className="p-6">
                {isLoading ? (
                  <Skeleton className="h-16 w-full" />
                ) : e3dcData ? (
                  <div>
                    <div className="flex items-center gap-2 mb-3">
                      <PlugZap className="w-4 h-4 text-muted-foreground" />
                      <span className="text-base font-semibold">Wallbox</span>
                    </div>
                    <div className="text-2xl font-bold" data-testid="text-wallbox-power">
                      {formatPower(e3dcData.wallboxPower)}
                    </div>
                  </div>
                ) : null}
              </Card>

              <Card className="p-6">
                {isLoading ? (
                  <Skeleton className="h-16 w-full" />
                ) : e3dcData ? (
                  <div>
                    <div className="flex items-center gap-2 mb-3">
                      <HomeIcon className="w-4 h-4 text-muted-foreground" />
                      <span className="text-base font-semibold">Haus</span>
                    </div>
                    <div className="text-2xl font-bold" data-testid="text-house-power">
                      {formatPower(actualHousePower)}
                    </div>
                  </div>
                ) : null}
              </Card>

              <Card className="p-6">
                {isLoading ? (
                  <Skeleton className="h-16 w-full" />
                ) : e3dcData ? (
                  <div>
                    <div className="flex items-center gap-2 mb-3">
                      <Grid3x3 className="w-4 h-4 text-muted-foreground" />
                      <span className="text-base font-semibold">Netz</span>
                    </div>
                    <div className="space-y-0.5">
                      <div className="text-2xl font-bold" data-testid="text-grid-power">
                        {formatPower(Math.abs(e3dcData.gridPower))}
                      </div>
                      <div className="text-xs text-muted-foreground" data-testid="text-grid-direction">
                        {e3dcData.gridPower < 0 ? "Einspeisung" : "Bezug"}
                      </div>
                    </div>
                  </div>
                ) : null}
              </Card>
            </div>

            {/* System-Informationen */}
            <Card 
              className={`${isE3dcEnabled ? 'cursor-pointer hover-elevate active-elevate-2' : ''}`}
              onClick={() => isE3dcEnabled && setShowE3dcConsole(true)}
              data-testid="card-efficiency"
            >
              <CardHeader className="pb-3">
                <CardTitle className="text-base">System-Informationen</CardTitle>
              </CardHeader>
              <CardContent className="space-y-2 pb-4">
                {isLoading ? (
                  <>
                    <Skeleton className="h-6 w-full" />
                    <Skeleton className="h-6 w-full" />
                  </>
                ) : e3dcData ? (
                  <>
                    <div className="flex items-center justify-between">
                      <span className="text-sm text-muted-foreground">Autarkie</span>
                      <span className="text-lg font-semibold" data-testid="text-autarky">{e3dcData.autarky}%</span>
                    </div>
                    <div className="flex items-center justify-between">
                      <span className="text-sm text-muted-foreground">Netzfrequenz</span>
                      <div className="flex items-center gap-2">
                        {frequencyTier === 0 && (
                          <Circle className="w-4 h-4 text-muted-foreground" data-testid="icon-frequency-unknown" />
                        )}
                        {frequencyTier === 1 && (
                          <CheckCircle className="w-4 h-4 text-green-500" data-testid="icon-frequency-ok" />
                        )}
                        {frequencyTier === 2 && (
                          <AlertTriangle className="w-4 h-4 text-yellow-500" data-testid="icon-frequency-warning" />
                        )}
                        {frequencyTier === 3 && (
                          <AlertCircle className="w-4 h-4 text-red-500" data-testid="icon-frequency-critical" />
                        )}
                        <span className="text-lg font-semibold" data-testid="text-grid-frequency">{e3dcData.gridFrequency?.toFixed(2) ?? 'N/A'} Hz</span>
                      </div>
                    </div>
                  </>
                ) : null}
              </CardContent>
            </Card>

            {/* Letztes Update */}
            {e3dcData?.timestamp && relativeUpdateTime && (
              <div className="text-xs text-left text-muted-foreground" data-testid="text-last-update">
                Letztes Update: {format(new Date(e3dcData.timestamp), 'HH:mm:ss', { locale: de })} ({relativeUpdateTime})
              </div>
            )}
            </div>
          )}
        </div>
      </div>

      <BatteryControlDrawer
        open={showBatteryDrawer}
        onOpenChange={setShowBatteryDrawer}
        controlState={controlState}
        settings={settings}
        isLoadingControls={isLoadingControls}
        isLoadingSettings={isLoadingSettings}
        isControlMutationPending={updateControlsMutation.isPending}
        isSettingsMutationPending={updateSettingsMutation.isPending}
        e3dcOperationLocks={e3dcOperationLocks}
        onControlChange={handleControlChange}
        onGridChargeDuringNightChange={handleGridChargeDuringNightChange}
      />

      <E3dcConsoleDialog
        open={showE3dcConsole}
        onOpenChange={setShowE3dcConsole}
      />

      <BuildInfoDialog
        open={showBuildInfoDialog}
        onOpenChange={setShowBuildInfoDialog}
        buildInfo={buildInfo}
      />
    </div>
  );
}

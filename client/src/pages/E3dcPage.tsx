import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Battery, Home as HomeIcon, Sun, Grid3x3, TrendingUp, TrendingDown, AlertCircle, PlugZap, ShieldOff, Zap, Clock, Settings as SettingsIcon, Info, Play } from "lucide-react";
import { useQuery, useMutation } from "@tanstack/react-query";
import type { E3dcLiveData, Settings, ControlState } from "@shared/schema";
import { buildInfoSchema } from "@shared/schema";
import { Link } from "wouter";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { useState, useEffect } from "react";
import { format } from "date-fns";
import { de } from "date-fns/locale";
import {
  Drawer,
  DrawerClose,
  DrawerContent,
  DrawerDescription,
  DrawerFooter,
  DrawerHeader,
  DrawerTitle,
} from "@/components/ui/drawer";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import { queryClient, apiRequest } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";

export default function E3dcPage() {
  const [showBatteryDrawer, setShowBatteryDrawer] = useState(false);
  const [showBuildInfoDialog, setShowBuildInfoDialog] = useState(false);
  const [showE3dcConsole, setShowE3dcConsole] = useState(false);
  const [relativeUpdateTime, setRelativeUpdateTime] = useState<string>("");
  const [e3dcOperationLocks, setE3dcOperationLocks] = useState({
    batteryLock: false,
    gridCharging: false,
  });
  const [commandInput, setCommandInput] = useState("");
  const [commandOutput, setCommandOutput] = useState("");
  const { toast } = useToast();

  // Lade Build-Info (nur einmal, keine Auto-Updates)
  const { data: buildInfoRaw } = useQuery({
    queryKey: ["/api/build-info"],
    staleTime: Infinity,
  });
  const buildInfoResult = buildInfoRaw ? buildInfoSchema.safeParse(buildInfoRaw) : null;
  const buildInfo = buildInfoResult?.success ? buildInfoResult.data : undefined;

  // Lade Settings (für Fehler-Anzeige bei Connection-Fehlern)
  const { data: settings, isLoading: isLoadingSettings } = useQuery<Settings>({
    queryKey: ["/api/settings"],
  });

  // Lade Control State
  const { data: controlState, isLoading: isLoadingControls } = useQuery<ControlState>({
    queryKey: ["/api/controls"],
    refetchInterval: 5000, // Automatisch alle 5 Sekunden aktualisieren
  });

  // Lade E3DC Live-Daten (Backend liefert automatisch Mock wenn keine IP konfiguriert)
  const { data: e3dcData, isLoading, error, refetch } = useQuery<E3dcLiveData>({
    queryKey: ["/api/e3dc/live-data"],
    refetchInterval: 5000, // Aktualisiere alle 5 Sekunden
  });

  // Mutation für Control State Updates (MUSS vor jedem Return definiert werden!)
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

  // Mutation für Settings Updates (gridChargeDuringNightCharging)
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

  // Mutation für E3DC Command Execution
  const executeCommandMutation = useMutation({
    mutationFn: async (command: string) => {
      const res = await apiRequest("POST", "/api/e3dc/execute-command", { command });
      const data = await res.json();
      return data as { output: string };
    },
    onSuccess: (data: { output: string }) => {
      setCommandOutput(data.output);
    },
    onError: (error) => {
      const errorMessage = error instanceof Error ? error.message : String(error);
      setCommandOutput(`Fehler: ${errorMessage}`);
    },
  });

  // Formatiere Leistungswerte: Unter 10 kW in Watt, ab 10 kW in kW
  const formatPower = (watts: number) => {
    if (watts === 0) return "0 W";
    if (Math.abs(watts) >= 10000) {
      return `${(watts / 1000).toFixed(1)} kW`;
    }
    return `${Math.round(watts)} W`;
  };

  // Demo-Modus aktiv wenn in Settings aktiviert
  const isDemoMode = settings?.demoMode === true;

  // Berechne ob Batterie lädt oder entlädt
  const isBatteryCharging = (e3dcData?.batteryPower || 0) > 100;
  const isBatteryDischarging = (e3dcData?.batteryPower || 0) < -100;

  // Berechne Hausverbrauch ohne Wallbox
  const actualHousePower = (e3dcData?.housePower || 0) - (e3dcData?.wallboxPower || 0);

  // E3DC Integration aktiv?
  const isE3dcEnabled = settings?.e3dc?.enabled === true;

  // Formatiere relative Zeit (Deutsch)
  const formatRelativeTime = (timestamp: string) => {
    const now = new Date();
    const then = new Date(timestamp);
    const diffInSeconds = Math.floor((now.getTime() - then.getTime()) / 1000);

    // Schutz gegen Zukunfts-Timestamps (Systemuhr-Differenzen)
    if (diffInSeconds < 0) {
      return 'gerade eben';
    }

    if (diffInSeconds === 0) {
      return 'gerade eben';
    }
    
    if (diffInSeconds === 1) {
      return 'vor 1 Sekunde';
    }
    
    if (diffInSeconds < 60) {
      return `vor ${diffInSeconds} Sekunden`;
    }
    
    if (diffInSeconds < 120) {
      return 'vor 1 Minute';
    }
    
    if (diffInSeconds < 3600) {
      const minutes = Math.floor(diffInSeconds / 60);
      return `vor ${minutes} Minuten`;
    }
    
    if (diffInSeconds < 7200) {
      return 'vor 1 Stunde';
    }
    
    const hours = Math.floor(diffInSeconds / 3600);
    return `vor ${hours} Stunden`;
  };

  // Update relative time every second
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
    
    // Für batteryLock und gridCharging: Optimistic Update + Lock während E3DC-Pause
    if (field === 'batteryLock' || field === 'gridCharging') {
      // Modbus-Pause-Dauer aus Settings (Standard: 3 Sekunden, 2x für vor+nach Befehl)
      const modbusPauseSeconds = settings?.e3dc?.modbusPauseSeconds ?? 3;
      const totalLockDuration = modbusPauseSeconds * 2 * 1000; // In Millisekunden
      
      // Setze Lock für diese Operation
      setE3dcOperationLocks(prev => ({ ...prev, [field]: true }));
      
      // Entferne Lock nach Pause-Dauer
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
    
    // Optimistic Update: Lokale State sofort aktualisieren
    queryClient.setQueryData(["/api/controls"], fullState);
    
    updateControlsMutation.mutate(fullState, {
      onError: () => {
        // Bei Fehler: Locks sofort entfernen
        if (field === 'batteryLock' || field === 'gridCharging') {
          setE3dcOperationLocks(prev => ({ ...prev, [field]: false }));
        }
        // Cache wird durch onError in der Mutation invalidiert
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
          {/* Header */}
          <div className="flex items-center justify-between gap-3">
            <button 
              onClick={() => setShowBuildInfoDialog(true)}
              className="flex items-center gap-3 hover-elevate active-elevate-2 rounded-lg p-2 -m-2 transition-all"
              aria-label="App-Informationen anzeigen"
              data-testid="button-show-build-info"
            >
              <img src="/apple-touch-icon.png" alt="EnergyLink" className="w-10 h-10 rounded-lg" />
              <h1 className="text-2xl font-bold mb-0">Hauskraftwerk</h1>
            </button>
            {isDemoMode && (
              <Badge variant="secondary" className="text-xs shrink-0" data-testid="badge-demo-mode">
                Demo
              </Badge>
            )}
          </div>

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
                  {/* Header */}
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
                  
                  {/* Werte */}
                  <div className="space-y-2">
                    {/* Ladezustand */}
                    <div className="flex items-center justify-between">
                      <span className="text-sm text-muted-foreground">Ladezustand (SOC)</span>
                      <span className="text-xl font-bold" data-testid="text-battery-soc">
                        {e3dcData.batterySoc}%
                      </span>
                    </div>
                    
                    {/* Leistung */}
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
              {/* PV-Leistung */}
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

              {/* Wallbox */}
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

              {/* Hausverbrauch */}
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

              {/* Netz */}
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

            {/* Effizienzwerte */}
            <Card 
              className={`${isE3dcEnabled ? 'cursor-pointer hover-elevate active-elevate-2' : ''}`}
              onClick={() => isE3dcEnabled && setShowE3dcConsole(true)}
              data-testid="card-efficiency"
            >
              <CardHeader className="pb-3">
                <CardTitle className="text-base">Effizienz</CardTitle>
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
                      <span className="text-sm text-muted-foreground">Eigenverbrauch</span>
                      <span className="text-lg font-semibold" data-testid="text-self-consumption">{e3dcData.selfConsumption}%</span>
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

      {/* Batterie-Steuerung Drawer */}
      <Drawer open={showBatteryDrawer} onOpenChange={setShowBatteryDrawer}>
        <DrawerContent>
          <div className="mx-auto w-full max-w-sm">
            <DrawerHeader>
              <DrawerTitle>Batterie-Steuerung</DrawerTitle>
              <DrawerDescription>
                Einstellungen für die Hausbatterie
              </DrawerDescription>
            </DrawerHeader>
            <div className="p-4 space-y-4">
              {/* Batterie-Entladesperre */}
              <div className="flex items-start justify-between gap-4">
                <div className="space-y-0.5">
                  <div className="flex items-center gap-2">
                    <ShieldOff className="w-4 h-4 text-muted-foreground" />
                    <Label htmlFor="battery-lock-drawer" className="text-sm font-medium">
                      Batterie-Entladesperre
                    </Label>
                  </div>
                  <p className="text-xs text-muted-foreground">
                    Die Entladung der Hausbatterie ist gesperrt
                  </p>
                </div>
                <Switch
                  id="battery-lock-drawer"
                  checked={controlState?.batteryLock || false}
                  onCheckedChange={(checked) => handleControlChange("batteryLock", checked)}
                  disabled={isLoadingControls || updateControlsMutation.isPending || e3dcOperationLocks.batteryLock}
                  data-testid="switch-battery-lock"
                />
              </div>

              {/* Netzstrom-Laden */}
              <div className="flex items-start justify-between gap-4">
                <div className="space-y-0.5">
                  <div className="flex items-center gap-2">
                    <Zap className="w-4 h-4 text-muted-foreground" />
                    <Label htmlFor="grid-charging-drawer" className="text-sm font-medium">
                      Netzstrom-Laden
                    </Label>
                  </div>
                  <p className="text-xs text-muted-foreground">
                    Die Hausbatterie wird mit Netzstrom geladen
                  </p>
                </div>
                <Switch
                  id="grid-charging-drawer"
                  checked={controlState?.gridCharging || false}
                  onCheckedChange={(checked) => handleControlChange("gridCharging", checked)}
                  disabled={isLoadingControls || updateControlsMutation.isPending || e3dcOperationLocks.gridCharging}
                  data-testid="switch-grid-charging"
                />
              </div>

              {/* Netzstrom-Laden während zeitgesteuerter Ladung */}
              <div className="flex items-start justify-between gap-4">
                <div className="space-y-0.5">
                  <div className="flex items-center gap-2">
                    <Clock className="w-4 h-4 text-muted-foreground" />
                    <Label htmlFor="grid-charge-night-drawer" className="text-sm font-medium">
                      Netzstrom bei zeitgesteuerter Ladung
                    </Label>
                  </div>
                  <p className="text-xs text-muted-foreground">
                    Hausbatterie mit Netzstrom laden während zeitgesteuerter Ladung
                  </p>
                </div>
                <Switch
                  id="grid-charge-night-drawer"
                  checked={settings?.e3dc?.gridChargeDuringNightCharging || false}
                  onCheckedChange={handleGridChargeDuringNightChange}
                  disabled={isLoadingSettings || updateSettingsMutation.isPending}
                  data-testid="switch-e3dc-grid-charge-night"
                />
              </div>
            </div>
            <DrawerFooter>
              <DrawerClose asChild>
                <Button variant="outline" data-testid="button-close-drawer">Schließen</Button>
              </DrawerClose>
            </DrawerFooter>
          </div>
        </DrawerContent>
      </Drawer>

      {/* E3DC Console Dialog */}
      <Dialog open={showE3dcConsole} onOpenChange={setShowE3dcConsole}>
        <DialogContent className="max-w-2xl" data-testid="dialog-e3dc-console">
          <DialogHeader>
            <DialogTitle>E3DC Console</DialogTitle>
            <DialogDescription>
              Direktes Ausführen von e3dcset Befehlen (ohne Prefix)
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div className="flex gap-2">
              <Input
                type="text"
                placeholder="z.B.: -s discharge 1  oder  -c 3000"
                value={commandInput}
                onChange={(e) => setCommandInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    executeCommandMutation.mutate(commandInput);
                  }
                }}
                disabled={executeCommandMutation.isPending}
                data-testid="input-e3dc-command"
              />
              <Button
                onClick={() => executeCommandMutation.mutate(commandInput)}
                disabled={executeCommandMutation.isPending || !commandInput.trim()}
                data-testid="button-execute-command"
              >
                <Play className="w-4 h-4 mr-2" />
                Run
              </Button>
            </div>
            
            {/* Output Display (ca. 10 Zeilen) */}
            <div className="bg-muted rounded-md p-3 font-mono text-sm min-h-[200px] max-h-[240px] overflow-y-auto border">
              <div className="text-muted-foreground whitespace-pre-wrap break-words" data-testid="text-command-output">
                {commandOutput || "Output wird hier angezeigt..."}
              </div>
            </div>

            <p className="text-xs text-muted-foreground">
              Der e3dcset-Prefix wird automatisch hinzugefügt. Geben Sie nur die Parameter ein.
            </p>
          </div>
        </DialogContent>
      </Dialog>

      <Dialog open={showBuildInfoDialog} onOpenChange={setShowBuildInfoDialog}>
        <DialogContent className="max-w-md" data-testid="dialog-build-info">
          <DialogHeader>
            <div className="flex items-center gap-2">
              <Info className="w-5 h-5 text-primary" />
              <DialogTitle>EnergyLink App</DialogTitle>
            </div>
            <DialogDescription>
              Smarte Steuerung von KEBA P20 Wallbox und E3DC S10 Hauskraftwerk
            </DialogDescription>
          </DialogHeader>
          
          {buildInfo ? (
            <div className="space-y-4">
              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1">
                  <p className="text-xs font-medium text-muted-foreground">Version</p>
                  <p className="text-sm font-mono" data-testid="text-build-version">
                    v{buildInfo.version}
                  </p>
                </div>
                <div className="space-y-1">
                  <p className="text-xs font-medium text-muted-foreground">Branch</p>
                  <p className="text-sm font-mono" data-testid="text-build-branch">
                    {buildInfo.branch}
                  </p>
                </div>
              </div>
              
              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1">
                  <p className="text-xs font-medium text-muted-foreground">Commit</p>
                  <p className="text-sm font-mono" data-testid="text-build-commit">
                    {buildInfo.commit}
                  </p>
                </div>
                <div className="space-y-1">
                  <p className="text-xs font-medium text-muted-foreground">Build</p>
                  <p className="text-sm" data-testid="text-build-time">
                    {new Date(buildInfo.buildTime).toLocaleDateString("de-DE", {
                      year: "numeric",
                      month: "2-digit",
                      day: "2-digit",
                    })}, {new Date(buildInfo.buildTime).toLocaleTimeString("de-DE", {
                      hour: "2-digit",
                      minute: "2-digit",
                    })}
                  </p>
                </div>
              </div>
            </div>
          ) : (
            <p className="text-sm text-muted-foreground">
              Build-Informationen konnten nicht geladen werden
            </p>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}

import { useEffect, useState, useRef } from "react";
import { Battery, Plug, Zap, AlertCircle, Gauge, Sparkles, Clock } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Slider } from "@/components/ui/slider";
import StatusCard from "@/components/StatusCard";
import PageHeader from "@/components/PageHeader";
import BuildInfoDialog from "@/components/BuildInfoDialog";
import CableDetailDrawer from "@/components/status/CableDetailDrawer";
import EnergyDetailDrawer from "@/components/status/EnergyDetailDrawer";
import ChargingControlDrawer, { STRATEGY_OPTIONS } from "@/components/status/ChargingControlDrawer";
import { useQuery, useMutation } from "@tanstack/react-query";
import { queryClient, apiRequest } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import type { WallboxStatus, ControlState, Settings, PlugStatusTracking, ChargingContext, ChargingStrategy, BuildInfo } from "@shared/schema";
import { useWallboxSSE } from "@/hooks/use-wallbox-sse";
import { useStatus } from "@/hooks/use-status";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { format } from "date-fns";
import { de } from "date-fns/locale";


export default function StatusPage() {
  const { toast } = useToast();
  const errorCountRef = useRef(0);
  const [showError, setShowError] = useState(false);
  const [currentAmpere, setCurrentAmpere] = useState(16);
  const previousNightChargingRef = useRef<boolean | undefined>(undefined);
  const [waitingForConfirmation, setWaitingForConfirmation] = useState(false);
  const [showCableDrawer, setShowCableDrawer] = useState(false);
  const [showEnergyDrawer, setShowEnergyDrawer] = useState(false);
  const [showChargingControlDrawer, setShowChargingControlDrawer] = useState(false);
  const [showBuildInfoDialog, setShowBuildInfoDialog] = useState(false);
  const [relativeUpdateTime, setRelativeUpdateTime] = useState<string>("");
  const [liveCountdown, setLiveCountdown] = useState<number | null>(null);
  const [liveStopCountdown, setLiveStopCountdown] = useState<number | null>(null);
  const [isButtonLocked, setIsButtonLocked] = useState(false);
  const [loadingTimedOut, setLoadingTimedOut] = useState(false);

  useEffect(() => {
    const timer = setTimeout(() => setLoadingTimedOut(true), 10000);
    return () => clearTimeout(timer);
  }, []);

  const { status: sseStatus, isConnected: sseConnected } = useWallboxSSE({
    onStatusUpdate: (newStatus) => {
      queryClient.setQueryData(["/api/wallbox/status"], newStatus);
    }
  });

  const { data: status, isLoading, error } = useQuery<WallboxStatus>({
    queryKey: ["/api/wallbox/status"],
    refetchInterval: 5000,
  });

  const displayStatus = sseStatus || status;

  // Consolidated poll: one request instead of 5 separate ones
  // useStatus() also distributes data into individual query caches for backwards compat
  const { data: consolidatedStatus } = useStatus(5000);
  const controlState = consolidatedStatus?.controls;
  const settings = consolidatedStatus?.settings;
  const plugTracking = consolidatedStatus?.plugTracking;
  const chargingContext = consolidatedStatus?.chargingContext;
  const buildInfo = consolidatedStatus?.buildInfo;

  useEffect(() => {
    if (displayStatus) {
      errorCountRef.current = 0;
      setShowError(false);
      if (displayStatus?.maxCurr > 0) {
        const maxAllowed = displayStatus?.phases === 3 ? 16 : 32;
        const newCurrent = Math.min(Math.round(displayStatus?.maxCurr), maxAllowed);
        setCurrentAmpere(newCurrent);
      }
      if (displayStatus?.power > 0 && waitingForConfirmation) {
        setWaitingForConfirmation(false);
      }
    } else if (error) {
      errorCountRef.current += 1;
      if (errorCountRef.current >= 3) {
        setShowError(true);
      }
    }
  }, [displayStatus, error, waitingForConfirmation]);

  useEffect(() => {
    if (previousNightChargingRef.current !== undefined) {
      if (controlState && status && controlState.nightCharging && !previousNightChargingRef.current) {
        const maxAllowed = displayStatus?.phases === 3 ? 16 : 32;
        setCurrentAmpere(maxAllowed);
        setCurrentMutation.mutate(maxAllowed);
      }
    }
    previousNightChargingRef.current = controlState?.nightCharging;
  }, [controlState?.nightCharging, status]);

  useEffect(() => {
    if (chargingContext?.remainingStartDelay !== undefined && chargingContext.remainingStartDelay > 0) {
      setLiveCountdown(chargingContext.remainingStartDelay);
      const interval = setInterval(() => {
        setLiveCountdown(prev => {
          if (prev === null || prev <= 0) return 0;
          return prev - 1;
        });
      }, 1000);
      return () => clearInterval(interval);
    } else {
      setLiveCountdown(null);
    }
  }, [chargingContext?.remainingStartDelay]);

  useEffect(() => {
    if (chargingContext?.remainingStopDelay !== undefined && chargingContext.remainingStopDelay > 0) {
      setLiveStopCountdown(chargingContext.remainingStopDelay);
      const interval = setInterval(() => {
        setLiveStopCountdown(prev => {
          if (prev === null || prev <= 0) return 0;
          return prev - 1;
        });
      }, 1000);
      return () => clearInterval(interval);
    } else {
      setLiveStopCountdown(null);
    }
  }, [chargingContext?.remainingStopDelay]);

  /** Invalidate consolidated status to trigger immediate refetch after mutations */
  const invalidateStatus = () => queryClient.invalidateQueries({ queryKey: ["/api/status"] });

  const startChargingMutation = useMutation({
    mutationFn: (strategy?: string) => apiRequest("POST", "/api/wallbox/start", { strategy }),
    onSuccess: () => {
      setWaitingForConfirmation(true);
      queryClient.invalidateQueries({ queryKey: ["/api/wallbox/status"] });
      invalidateStatus();
    },
    onError: () => {
      setWaitingForConfirmation(false);
      // Revert optimistic update
      queryClient.invalidateQueries({ queryKey: ["/api/wallbox/status"] });
      toast({
        title: "Fehler",
        description: "Laden konnte nicht gestartet werden.",
        variant: "destructive",
      });
    },
  });

  const stopChargingMutation = useMutation({
    mutationFn: () => apiRequest("POST", "/api/wallbox/stop"),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/wallbox/status"] });
      invalidateStatus();
    },
    onError: () => {
      // Revert optimistic update
      queryClient.invalidateQueries({ queryKey: ["/api/wallbox/status"] });
      toast({
        title: "Fehler",
        description: "Laden konnte nicht gestoppt werden.",
        variant: "destructive",
      });
    },
  });

  const setCurrentMutation = useMutation({
    mutationFn: (current: number) => apiRequest("POST", "/api/wallbox/current", { current }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/wallbox/status"] });
    },
    onError: () => {
      if (displayStatus?.maxCurr) {
        setCurrentAmpere(Math.round(displayStatus.maxCurr));
      }
      toast({
        title: "Fehler",
        description: "Ladestrom konnte nicht geändert werden.",
        variant: "destructive",
      });
    },
  });

  const updateSettingsMutation = useMutation({
    mutationFn: (newSettings: Settings) =>
      apiRequest("POST", "/api/settings", newSettings),
    onSuccess: () => {
      invalidateStatus();
    },
    onError: () => {
      invalidateStatus();
    },
  });

  const updateControlsMutation = useMutation({
    mutationFn: (newState: ControlState) =>
      apiRequest("POST", "/api/controls", newState),
    onSuccess: () => {
      invalidateStatus();
    },
    onError: () => {
      invalidateStatus();
    },
  });

  const handleToggleCharging = () => {
    setIsButtonLocked(true);
    setTimeout(() => setIsButtonLocked(false), 800);
    
    const currentlyCharging = displayStatus?.state === 3;
    if (currentlyCharging) {
      // Optimistic update: Button sofort auf "Gestoppt" wechseln (Issue #94)
      queryClient.setQueryData(["/api/wallbox/status"], (old: WallboxStatus | undefined) =>
        old ? { ...old, state: 5, power: 0 } : old
      );
      stopChargingMutation.mutate();
    } else {
      // Optimistic update: Button sofort auf "Laden" wechseln (Issue #94)
      queryClient.setQueryData(["/api/wallbox/status"], (old: WallboxStatus | undefined) =>
        old ? { ...old, state: 3 } : old
      );
      const targetStrategy = settings?.chargingStrategy?.inputX1Strategy || "max_without_battery";
      startChargingMutation.mutate(targetStrategy);
    }
  };

  const handleCurrentChange = (value: number[]) => {
    setCurrentAmpere(value[0]);
  };

  const handleCurrentCommit = () => {
    setCurrentMutation.mutate(currentAmpere);
  };

  const handleNightChargingToggle = (enabled: boolean) => {
    if (!settings) return;
    
    const updatedSettings: Settings = {
      ...settings,
      nightChargingSchedule: {
        enabled,
        startTime: settings.nightChargingSchedule?.startTime || "00:00",
        endTime: settings.nightChargingSchedule?.endTime || "05:00",
      },
    };
    
    updateSettingsMutation.mutate(updatedSettings);
  };

  const handleNightTimeChange = (field: 'startTime' | 'endTime', value: string) => {
    if (!settings) return;
    
    const updatedSettings: Settings = {
      ...settings,
      nightChargingSchedule: {
        enabled: settings.nightChargingSchedule?.enabled || false,
        startTime: field === 'startTime' ? value : (settings.nightChargingSchedule?.startTime || "00:00"),
        endTime: field === 'endTime' ? value : (settings.nightChargingSchedule?.endTime || "05:00"),
      },
    };
    
    updateSettingsMutation.mutate(updatedSettings);
  };

  const handleStrategyChange = (strategy: ChargingStrategy) => {
    if (!settings) return;
    
    const updatedSettings: Settings = {
      ...settings,
      chargingStrategy: {
        minStartPowerWatt: settings.chargingStrategy?.minStartPowerWatt ?? 1400,
        stopThresholdWatt: settings.chargingStrategy?.stopThresholdWatt ?? 1000,
        startDelaySeconds: settings.chargingStrategy?.startDelaySeconds ?? 120,
        stopDelaySeconds: settings.chargingStrategy?.stopDelaySeconds ?? 300,
        physicalPhaseSwitch: settings.chargingStrategy?.physicalPhaseSwitch ?? 3,
        minCurrentChangeAmpere: settings.chargingStrategy?.minCurrentChangeAmpere ?? 1,
        minChangeIntervalSeconds: settings.chargingStrategy?.minChangeIntervalSeconds ?? 60,
        inputX1Strategy: settings.chargingStrategy?.inputX1Strategy ?? "max_without_battery",
        activeStrategy: strategy,
      },
    };
    
    updateSettingsMutation.mutate(updatedSettings);
    
    toast({
      title: "Strategie geändert",
      description: STRATEGY_OPTIONS.find(s => s.value === strategy)?.label || strategy,
    });
  };

  const getPlugStatus = (plug: number) => {
    switch (plug) {
      case 0: return "Nicht verbunden";
      case 1: return "Verbunden an Wallbox";
      case 3: return "Nicht eingesteckt";
      case 5: return "Eingesteckt";
      case 7: return "Eingesteckt und verriegelt";
      default: return "Unbekannt";
    }
  };

  const getStatusBadge = (state: number) => {
    switch (state) {
      case 0: return "Startbereit";
      case 1: return "Nicht bereit";
      case 2: return "Bereit";
      case 3: return "Lädt";
      case 4: return "Fehler";
      case 5: return "Unterbrochen";
      default: return "Unbekannt";
    }
  };

  const getPhaseInfo = () => {
    if (!status || !isCharging) return undefined;
    
    const phases = displayStatus?.phases || 0;
    if (phases === 0) return undefined;

    const activePhases = [
      (displayStatus?.i1 || 0) >= 1,
      (displayStatus?.i2 || 0) >= 1,
      (displayStatus?.i3 || 0) >= 1,
    ].filter(Boolean).length;

    if (phases === 3 && activePhases === 2) {
      return "3-phasig - lädt mit 2 Phasen";
    }
    
    return `${phases}-phasig`;
  };

  const isCharging = displayStatus?.state === 3;
  const isPluggedIn = (displayStatus?.plug || 0) >= 3;
  const power = displayStatus?.power || 0;
  const energySession = (displayStatus?.ePres || 0) / 1000;
  const energyTotal = (displayStatus?.eTotal || 0) / 1000;
  const energy = energySession;
  const phases = displayStatus?.phases || 0;

  const getStrategyLabel = (strategy: string | undefined) => {
    const option = STRATEGY_OPTIONS.find(opt => opt.value === strategy);
    return option?.label || "Aus";
  };

  const getBadgeLabel = (strategy: string | undefined) => {
    switch (strategy) {
      case "surplus_battery_prio":
      case "surplus_vehicle_prio":
        return "Überschussladung";
      case "max_with_battery":
      case "max_without_battery":
        return "Max Power";
      default:
        return "Aus";
    }
  };

  const getStatusIcons = () => {
    const icons = [];
    
    if (chargingContext?.isActive && chargingContext.strategy !== "off") {
      icons.push({
        icon: Sparkles,
        label: `Strategie: ${getStrategyLabel(chargingContext.strategy)}`,
        color: "text-muted-foreground"
      });
    }
    
    if (settings?.nightChargingSchedule?.enabled) {
      icons.push({
        icon: Clock,
        label: "Zeitgesteuerte Ladung aktiv",
        color: "text-muted-foreground"
      });
    }
    return icons;
  };

  const formatTime = (timeString: string) => {
    try {
      const [hours, minutes] = timeString.split(':');
      const date = new Date();
      date.setHours(parseInt(hours), parseInt(minutes));
      return new Intl.DateTimeFormat('de-DE', {
        hour: '2-digit',
        minute: '2-digit'
      }).format(date);
    } catch {
      return timeString;
    }
  };

  const getScheduleTimeRange = () => {
    if (!settings?.nightChargingSchedule) return '';
    const start = formatTime(settings.nightChargingSchedule.startTime);
    const end = formatTime(settings.nightChargingSchedule.endTime);
    return `${start} - ${end}`;
  };

  const formatRelativeTime = (timestamp: string) => {
    const now = new Date();
    const then = new Date(timestamp);
    const diffInSeconds = Math.floor((now.getTime() - then.getTime()) / 1000);

    if (diffInSeconds < 0) return 'gerade eben';
    if (diffInSeconds < 60) return `vor ${diffInSeconds} Sekunde${diffInSeconds !== 1 ? 'n' : ''}`;
    if (diffInSeconds < 3600) {
      const minutes = Math.floor(diffInSeconds / 60);
      return `vor ${minutes} Minute${minutes !== 1 ? 'n' : ''}`;
    }
    if (diffInSeconds < 86400) {
      const hours = Math.floor(diffInSeconds / 3600);
      return `vor ${hours} Stunde${hours !== 1 ? 'n' : ''}`;
    }
    const days = Math.floor(diffInSeconds / 86400);
    return `vor ${days} Tag${days !== 1 ? 'en' : ''}`;
  };

  useEffect(() => {
    if (!status?.lastUpdated) {
      setRelativeUpdateTime("");
      return;
    }

    const updateRelativeTime = () => {
      setRelativeUpdateTime(formatRelativeTime(displayStatus?.lastUpdated!));
    };

    updateRelativeTime();
    const interval = setInterval(updateRelativeTime, 1000);

    return () => clearInterval(interval);
  }, [status?.lastUpdated]);

  if (isLoading && !status && !loadingTimedOut) {
    return (
      <div className="flex flex-col items-center justify-center h-full">
        <div className="text-center space-y-4">
          <Zap className="w-12 h-12 text-primary mx-auto animate-pulse" />
          <p className="text-muted-foreground">Lade Wallbox-Status...</p>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full">
      <div className="flex-1 overflow-y-auto pb-24 pt-6">
        <div className="max-w-2xl mx-auto px-4 space-y-6">
          <PageHeader
            title="Wallbox"
            onLogoClick={() => setShowBuildInfoDialog(true)}
            isDemoMode={settings?.demoMode}
          />

          {showError && (
            <Alert variant="destructive" data-testid="alert-error">
              <AlertCircle className="h-4 w-4" />
              <AlertDescription>
                Verbindung zur Wallbox fehlgeschlagen. Bitte überprüfen Sie die IP-Adresse in den Einstellungen.
              </AlertDescription>
            </Alert>
          )}

          <div className="space-y-4">
            <StatusCard
              icon={Zap}
              title="Ladeleistung"
              value={isLoading ? "..." : power.toFixed(1)}
              unit="kW"
              status={isCharging ? "charging" : "stopped"}
              badge={
                isLoading 
                  ? "..." 
                  : waitingForConfirmation 
                  ? "Warte auf Bestätigung" 
                  : (() => {
                      const strategy = settings?.chargingStrategy?.activeStrategy;
                      const isSurplusStrategy = strategy === "surplus_battery_prio" || strategy === "surplus_vehicle_prio";
                      
                      if (chargingContext && !chargingContext.isActive && strategy === "off" && settings?.nightChargingSchedule?.enabled && !isCharging) {
                        return getScheduleTimeRange();
                      }
                      
                      if (isSurplusStrategy) {
                        if (isCharging && liveStopCountdown !== null && liveStopCountdown > 0) {
                          return `Stopp in ${liveStopCountdown}s`;
                        }
                        if (isCharging) return getBadgeLabel(strategy);
                        if (liveCountdown !== null && liveCountdown > 0) {
                          return `Start in ${liveCountdown}s`;
                        }
                        return "Warte auf Überschuss";
                      }
                      
                      if (strategy && strategy !== "off") return getBadgeLabel(strategy);
                      return getStatusBadge(status?.state || 0);
                    })()
              }
              additionalInfo={getPhaseInfo()}
              statusIcons={getStatusIcons()}
              onClick={() => setShowChargingControlDrawer(true)}
              showConfigIcon={true}
            />

            <Card data-testid="card-current-control">
              <CardHeader className="pb-3">
                <div className="flex items-center justify-between gap-2">
                  <div className="flex items-center gap-2">
                    <Gauge className="w-5 h-5 text-primary" />
                    <CardTitle className="text-base font-semibold">
                      Ladestrom {(() => {
                        const strategy = settings?.chargingStrategy?.activeStrategy;
                        const isSurplusStrategy = strategy === "surplus_battery_prio" || strategy === "surplus_vehicle_prio";
                        if (isSurplusStrategy) return Math.round(status?.maxCurr || 0);
                        return currentAmpere;
                      })()}A
                    </CardTitle>
                  </div>
                  {(() => {
                    const strategy = settings?.chargingStrategy?.activeStrategy;
                    const isSurplusStrategy = strategy === "surplus_battery_prio" || strategy === "surplus_vehicle_prio";
                    
                    if (isSurplusStrategy) {
                      return (
                        <Badge variant="secondary" className="text-xs shrink-0" data-testid="badge-auto-regulated">
                          Automatisch geregelt
                        </Badge>
                      );
                    }
                    
                    if (controlState?.pvSurplus) {
                      return (
                        <span className="text-sm text-muted-foreground" data-testid="text-pv-surplus-active">
                          PV-Überschuss aktiv
                        </span>
                      );
                    }
                    
                    return null;
                  })()}
                </div>
              </CardHeader>
              <CardContent className="space-y-4">
                <Slider
                  value={[(() => {
                    const strategy = settings?.chargingStrategy?.activeStrategy;
                    const isSurplusStrategy = strategy === "surplus_battery_prio" || strategy === "surplus_vehicle_prio";
                    if (isSurplusStrategy) return Math.round(status?.maxCurr || 6);
                    return currentAmpere;
                  })()]}
                  onValueChange={handleCurrentChange}
                  onValueCommit={handleCurrentCommit}
                  min={6}
                  max={phases === 3 ? 16 : 32}
                  step={1}
                  disabled={
                    setCurrentMutation.isPending || 
                    !isPluggedIn || 
                    (() => {
                      const strategy = settings?.chargingStrategy?.activeStrategy;
                      return strategy === "surplus_battery_prio" || strategy === "surplus_vehicle_prio";
                    })()
                  }
                  data-testid="slider-current"
                />
                <div className="flex justify-between text-xs text-muted-foreground">
                  <span>6A</span>
                  <span>{phases === 3 ? "16A" : "32A"}</span>
                </div>
              </CardContent>
            </Card>

            <StatusCard
              icon={Battery}
              title="Geladene Energie"
              value={isLoading ? "..." : energy.toFixed(1)}
              unit="kWh"
              status={isCharging ? "charging" : "stopped"}
              onClick={() => setShowEnergyDrawer(true)}
            />

            <StatusCard
              icon={Plug}
              title="Kabelverbindung"
              value={isLoading ? "..." : getPlugStatus(status?.plug || 0)}
              status={isCharging ? "charging" : isPluggedIn ? "ready" : "stopped"}
              compact={true}
              onClick={() => setShowCableDrawer(true)}
            />

            <Button
              onClick={handleToggleCharging}
              size="lg"
              variant={isCharging ? "destructive" : "default"}
              className="w-full h-12 text-base font-medium"
              data-testid="button-toggle-charging"
              disabled={isLoading || isButtonLocked || startChargingMutation.isPending || stopChargingMutation.isPending}
            >
              {isButtonLocked || startChargingMutation.isPending || stopChargingMutation.isPending
                ? "Wird verarbeitet..."
                : isCharging
                ? controlState?.nightCharging
                  ? "Stoppe zeitgesteuerte Ladung"
                  : `Stoppe ${getStrategyLabel(settings?.chargingStrategy?.activeStrategy || "off")}`
                : `Starte ${getStrategyLabel(settings?.chargingStrategy?.inputX1Strategy || "max_without_battery")}`}
            </Button>

            {displayStatus?.lastUpdated && relativeUpdateTime && (
              <div className="text-xs text-left text-muted-foreground" data-testid="text-last-update">
                Letztes Update: {format(new Date(displayStatus.lastUpdated), 'HH:mm:ss', { locale: de })} ({relativeUpdateTime})
              </div>
            )}
          </div>
        </div>
      </div>

      <CableDetailDrawer
        open={showCableDrawer}
        onOpenChange={setShowCableDrawer}
        plugStatus={status?.plug || 0}
        plugTracking={plugTracking}
        getPlugStatus={getPlugStatus}
      />

      <EnergyDetailDrawer
        open={showEnergyDrawer}
        onOpenChange={setShowEnergyDrawer}
        energySession={energySession}
        energyTotal={energyTotal}
      />

      <ChargingControlDrawer
        open={showChargingControlDrawer}
        onOpenChange={setShowChargingControlDrawer}
        settings={settings}
        updateSettingsMutation={updateSettingsMutation}
        onStrategyChange={handleStrategyChange}
        onNightChargingToggle={handleNightChargingToggle}
        onNightTimeChange={handleNightTimeChange}
      />

      <BuildInfoDialog
        open={showBuildInfoDialog}
        onOpenChange={setShowBuildInfoDialog}
        buildInfo={buildInfo}
      />
    </div>
  );
}

import { useEffect, useCallback } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Separator } from "@/components/ui/separator";
import { PlugZap } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { useQuery, useMutation } from "@tanstack/react-query";
import { queryClient, apiRequest } from "@/lib/queryClient";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { settingsSchema, buildInfoSchema } from "@shared/schema";
import type { Settings, WallboxStatus, BuildInfo } from "@shared/schema";
import WebPushSection from "./WebPushSection";

// Demo X1 Input Control (extracted from original DemoModeSection)
function DemoInputControl() {
  const { toast } = useToast();
  const { data: wallboxStatus } = useQuery<WallboxStatus>({
    queryKey: ["/api/wallbox/status"],
    refetchInterval: 2000,
  });

  const currentInput = wallboxStatus?.input ?? 0;

  const setInputMutation = useMutation({
    mutationFn: (input: 0 | 1) =>
      apiRequest("POST", "/api/wallbox/demo-input", { input }),
    onSuccess: (_, input) => {
      queryClient.invalidateQueries({ queryKey: ["/api/wallbox/status"] });
      toast({
        title: "Input gesetzt",
        description: `Potenzialfreier Kontakt auf ${input === 1 ? "EIN" : "AUS"} gesetzt`,
      });
    },
    onError: () => {
      toast({
        title: "Fehler",
        description: "Input konnte nicht gesetzt werden",
        variant: "destructive",
      });
    },
  });

  return (
    <div className="flex items-center justify-between">
      <div className="space-y-0.5">
        <div className="flex items-center gap-2">
          <PlugZap className="w-4 h-4 text-muted-foreground" />
          <Label htmlFor="demo-input-toggle" className="text-sm font-medium">
            Potenzialfreier Kontakt (X1)
          </Label>
        </div>
        <p className="text-xs text-muted-foreground">
          Enable-Eingang der Mock-Wallbox: {currentInput === 1 ? "Eingeschaltet" : "Ausgeschaltet"}
        </p>
      </div>
      <Switch
        id="demo-input-toggle"
        checked={currentInput === 1}
        onCheckedChange={(checked) => setInputMutation.mutate(checked ? 1 : 0)}
        disabled={setInputMutation.isPending}
        data-testid="switch-demo-input"
      />
    </div>
  );
}

// Prowl Event Groups
const PROWL_EVENT_GROUPS = [
  {
    title: "⚡ Laden & Verbindung",
    testId: "prowl-group-charging",
    events: [
      { id: "charging-started", field: "prowl.events.chargingStarted" as const, label: "Ladung gestartet" },
      { id: "charging-stopped", field: "prowl.events.chargingStopped" as const, label: "Ladung gestoppt" },
      { id: "current-adjusted", field: "prowl.events.currentAdjusted" as const, label: "Strom angepasst" },
      { id: "plug-connected", field: "prowl.events.plugConnected" as const, label: "Auto angesteckt" },
      { id: "plug-disconnected", field: "prowl.events.plugDisconnected" as const, label: "Auto abgesteckt" },
    ],
  },
  {
    title: "🔋 Batterie & Netz",
    testId: "prowl-group-battery",
    events: [
      { id: "battery-lock-activated", field: "prowl.events.batteryLockActivated" as const, label: "Entladesperre an" },
      { id: "battery-lock-deactivated", field: "prowl.events.batteryLockDeactivated" as const, label: "Entladesperre aus" },
      { id: "grid-charging-activated", field: "prowl.events.gridChargingActivated" as const, label: "Batterie-Netzladung an" },
      { id: "grid-charging-deactivated", field: "prowl.events.gridChargingDeactivated" as const, label: "Batterie-Netzladung aus" },
      { id: "grid-frequency-warning", field: "prowl.events.gridFrequencyWarning" as const, label: "Frequenz Warnung" },
      { id: "grid-frequency-critical", field: "prowl.events.gridFrequencyCritical" as const, label: "Frequenz Kritisch" },
    ],
  },
  {
    title: "⚙️ System & Fehler",
    testId: "prowl-group-system",
    events: [
      { id: "strategy-changed", field: "prowl.events.strategyChanged" as const, label: "Strategie gewechselt" },
      { id: "app-started", field: "prowl.events.appStarted" as const, label: "App gestartet" },
      { id: "errors", field: "prowl.events.errors" as const, label: "Fehler aufgetreten" },
    ],
  },
] as const;

interface SystemTabProps {
  settings: Settings;
  settingsLoaded: boolean;
  onDirtyChange: (dirty: boolean) => void;
}

export default function SystemTab({ settings, settingsLoaded, onDirtyChange }: SystemTabProps) {
  const { toast } = useToast();

  // Build info
  const { data: buildInfoRaw } = useQuery({
    queryKey: ["/api/build-info"],
    staleTime: Infinity,
  });
  const buildInfoResult = buildInfoRaw ? buildInfoSchema.safeParse(buildInfoRaw) : null;
  const buildInfo: BuildInfo | undefined = buildInfoResult?.success ? buildInfoResult.data : undefined;

  const form = useForm<Settings>({
    resolver: zodResolver(settingsSchema),
    defaultValues: settings,
  });

  useEffect(() => {
    form.reset(settings);
  }, [settings, form]);

  const isDirty = form.formState.isDirty;

  useEffect(() => {
    onDirtyChange(isDirty);
  }, [isDirty, onDirtyChange]);

  const saveMutation = useMutation({
    mutationFn: (data: Settings) => apiRequest("POST", "/api/settings", data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/settings"] });
      // Invalidiere alle Daten-Queries damit nach Demo-Toggle sofort Mock-/Realdaten angezeigt werden
      queryClient.invalidateQueries({ queryKey: ["/api/wallbox/status"] });
      queryClient.invalidateQueries({ queryKey: ["/api/status"] });
      queryClient.invalidateQueries({ queryKey: ["/api/e3dc/live-data"] });
      queryClient.invalidateQueries({ queryKey: ["/api/controls"] });
      toast({
        title: "System-Einstellungen gespeichert",
        description: "Die Konfiguration wurde erfolgreich aktualisiert.",
      });
    },
    onError: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/settings"] });
      toast({
        title: "Fehler",
        description: "Die Einstellungen konnten nicht gespeichert werden.",
        variant: "destructive",
      });
    },
  });

  const handleSave = useCallback((data: Settings) => {
    saveMutation.mutate(data);
  }, [saveMutation]);

  const handleToggleSave = useCallback((field: string, value: boolean) => {
    const current = form.getValues();
    const path = field.split(".");
    const updated = { ...current };
    let obj: any = updated;
    for (let i = 0; i < path.length - 1; i++) {
      obj[path[i]] = { ...obj[path[i]] };
      obj = obj[path[i]];
    }
    obj[path[path.length - 1]] = value;
    saveMutation.mutate(updated);
  }, [form, saveMutation]);

  const demoMode = form.watch("demoMode") ?? false;
  const prowlEnabled = form.watch("prowl.enabled");

  return (
    <form onSubmit={form.handleSubmit(handleSave)} className="space-y-4" data-testid="system-tab">
      {/* Demo-Modus */}
      <div className="border rounded-lg p-4 space-y-3 bg-accent/30">
        <div className="flex items-center justify-between">
          <div className="space-y-0.5">
            <Label htmlFor="demo-mode" className="text-base font-medium">
              Demo-Modus
            </Label>
            <p className="text-xs text-muted-foreground">
              Verwendet simulierte Daten ohne echte Hardware
            </p>
          </div>
          <Switch
            id="demo-mode"
            checked={demoMode}
            onCheckedChange={(checked) => {
              if (!settingsLoaded) {
                toast({
                  title: "Bitte warten",
                  description: "Einstellungen werden geladen...",
                });
                return;
              }
              form.setValue("demoMode", checked);
              handleToggleSave("demoMode", checked);
            }}
            data-testid="switch-demo-mode"
            disabled={!settingsLoaded || saveMutation.isPending}
          />
        </div>

        {demoMode && (
          <>
            <Separator />

            <div className="border rounded-lg p-4 space-y-3 bg-card">
              <div className="space-y-2">
                <Label htmlFor="mock-wallbox-phases" className="text-sm font-medium">
                  Phasenanzahl
                </Label>
                <Select
                  value={String(form.watch("mockWallboxPhases") ?? 3)}
                  onValueChange={(value) =>
                    form.setValue("mockWallboxPhases", Number(value) as 1 | 3, { shouldDirty: true })
                  }
                >
                  <SelectTrigger id="mock-wallbox-phases" className="h-12" data-testid="select-mock-phases">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="1">1 Phase (einphasig)</SelectItem>
                    <SelectItem value="3">3 Phasen (dreiphasig)</SelectItem>
                  </SelectContent>
                </Select>
              </div>

              <DemoInputControl />

              <div className="space-y-2">
                <Label htmlFor="mock-plug-status" className="text-sm font-medium">
                  Kabel-Status (Plug)
                </Label>
                <Select
                  value={String(form.watch("mockWallboxPlugStatus") ?? 7)}
                  onValueChange={(value) =>
                    form.setValue("mockWallboxPlugStatus", Number(value), { shouldDirty: true })
                  }
                >
                  <SelectTrigger id="mock-plug-status" className="h-12" data-testid="select-mock-plug">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="0">0 - Getrennt (unplugged)</SelectItem>
                    <SelectItem value="1">1 - In Buchse (in socket)</SelectItem>
                    <SelectItem value="3">3 - Verriegelt (locked)</SelectItem>
                    <SelectItem value="5">5 - Bereit (ready)</SelectItem>
                    <SelectItem value="7">7 - Laden / Verriegelt (charging)</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>

            <div className="space-y-2">
              <Label className="text-sm font-medium">Simulierte Tageszeit</Label>
              <div className="flex items-center gap-3">
                <Switch
                  id="mock-time-enabled"
                  checked={form.watch("mockTimeEnabled") ?? false}
                  onCheckedChange={(checked) => {
                    form.setValue("mockTimeEnabled", checked, { shouldDirty: true });
                    if (checked) {
                      const now = new Date();
                      const y = now.getFullYear();
                      const m = String(now.getMonth() + 1).padStart(2, "0");
                      const d = String(now.getDate()).padStart(2, "0");
                      form.setValue("mockDateTime", `${y}-${m}-${d}T12:00`, { shouldDirty: true });
                    } else {
                      form.setValue("mockDateTime", "", { shouldDirty: true });
                    }
                  }}
                  data-testid="switch-mock-time-enabled"
                />
                {form.watch("mockTimeEnabled") && (
                  <Input
                    id="mock-datetime"
                    type="datetime-local"
                    {...form.register("mockDateTime")}
                    className="h-12 border-none bg-transparent p-0 pl-3 text-left focus-visible:ring-0"
                    data-testid="input-mock-datetime"
                  />
                )}
              </div>
              <p className="text-xs text-muted-foreground">
                Datum steuert Jahreszeit (Winter: ~3.5kW Peak, Sommer: ~8kW Peak), Uhrzeit die PV-Kurve
              </p>
            </div>
          </>
        )}
      </div>

      <Separator />

      {/* Prowl-Benachrichtigungen */}
      <div className="border rounded-lg p-4 space-y-3">
        <div className="flex items-center justify-between">
          <div className="space-y-0.5">
            <Label htmlFor="prowl-enabled" className="text-sm font-medium">
              Push-Benachrichtigungen (Prowl)
            </Label>
            <p className="text-xs text-muted-foreground">
              Erhalte Benachrichtigungen über Lade- und Systemereignisse
            </p>
          </div>
          <Switch
            id="prowl-enabled"
            checked={prowlEnabled}
            onCheckedChange={(checked) => {
              form.setValue("prowl.enabled", checked);
              handleToggleSave("prowl.enabled", checked);
            }}
            data-testid="switch-prowl-enabled"
          />
        </div>

        {prowlEnabled && (
          <>
            <Separator />

            <div className="space-y-4">
              <div className="space-y-2">
                <Label htmlFor="prowl-api-key" className="text-sm font-medium">
                  Prowl API Key
                </Label>
                <Input
                  id="prowl-api-key"
                  type="password"
                  placeholder="40 Zeichen API Key"
                  {...form.register("prowl.apiKey")}
                  className="h-12 font-mono"
                  data-testid="input-prowl-api-key"
                />
                <p className="text-xs text-muted-foreground">
                  API Key von{" "}
                  <a href="https://www.prowlapp.com" target="_blank" rel="noopener noreferrer" className="underline">
                    prowlapp.com
                  </a>
                </p>
              </div>

              <Separator />

              {/* Event-Gruppen */}
              <div className="space-y-4">
                <Label className="text-sm font-medium">Ereignis-Benachrichtigungen</Label>

                {PROWL_EVENT_GROUPS.map((group) => (
                  <div key={group.testId} className="space-y-2" data-testid={group.testId}>
                    <p className="text-xs font-medium text-muted-foreground">{group.title}</p>
                    {group.events.map(({ id, field, label }) => (
                      <div key={id} className="flex items-center justify-between">
                        <Label htmlFor={`event-${id}`} className="text-xs font-normal">
                          {label}
                        </Label>
                        <Switch
                          id={`event-${id}`}
                          checked={form.watch(field)}
                          onCheckedChange={(checked) =>
                            form.setValue(field, checked, { shouldDirty: true })
                          }
                          data-testid={`switch-event-${id}`}
                        />
                      </div>
                    ))}
                  </div>
                ))}
              </div>

              <Separator />

              <Button
                type="button"
                variant="outline"
                onClick={async () => {
                  try {
                    const currentSettings = form.getValues();
                    await fetch("/api/settings", {
                      method: "POST",
                      headers: { "Content-Type": "application/json" },
                      body: JSON.stringify(currentSettings),
                    });
                    const response = await fetch("/api/prowl/test", { method: "POST" });
                    if (response.ok) {
                      toast({
                        title: "Test-Benachrichtigung gesendet",
                        description: "Prüfe dein Smartphone (kann bis zu 1 Minute dauern)",
                      });
                    } else {
                      const error = await response.json();
                      toast({
                        title: "Test fehlgeschlagen",
                        description: error.error || "Prüfe API Key und Logs",
                        variant: "destructive",
                      });
                    }
                  } catch {
                    toast({
                      title: "Fehler",
                      description: "Test-Benachrichtigung konnte nicht gesendet werden",
                      variant: "destructive",
                    });
                  }
                }}
                className="w-full"
                data-testid="button-prowl-test"
              >
                Test-Benachrichtigung senden
              </Button>
            </div>
          </>
        )}
      </div>

      {/* Web Push-Benachrichtigungen */}
      <WebPushSection form={form} handleToggleSave={handleToggleSave} />

      <Separator />

      {/* Build-Info */}
      <div className="border rounded-lg p-4 space-y-3">
        <Label className="text-sm font-medium">Build-Info</Label>
        {buildInfo ? (
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1">
              <p className="text-xs font-medium text-muted-foreground">Version</p>
              <p className="text-sm font-mono" data-testid="text-build-version">v{buildInfo.version}</p>
            </div>
            <div className="space-y-1">
              <p className="text-xs font-medium text-muted-foreground">Branch</p>
              <p className="text-sm font-mono" data-testid="text-build-branch">{buildInfo.branch}</p>
            </div>
            <div className="space-y-1">
              <p className="text-xs font-medium text-muted-foreground">Commit</p>
              <p className="text-sm font-mono" data-testid="text-build-commit">{buildInfo.commit}</p>
            </div>
            <div className="space-y-1">
              <p className="text-xs font-medium text-muted-foreground">Build-Datum</p>
              <p className="text-sm" data-testid="text-build-time">
                {new Date(buildInfo.buildTime).toLocaleDateString("de-DE", {
                  year: "numeric",
                  month: "2-digit",
                  day: "2-digit",
                })}
              </p>
            </div>
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">Build-Info wird geladen...</p>
        )}
      </div>

      {/* Save Button */}
      {isDirty && (
        <Button
          type="submit"
          size="lg"
          className="w-full h-12 text-base font-medium"
          data-testid="button-save-system"
          disabled={saveMutation.isPending}
        >
          {saveMutation.isPending ? "Wird gespeichert..." : "System-Einstellungen speichern"}
        </Button>
      )}
    </form>
  );
}

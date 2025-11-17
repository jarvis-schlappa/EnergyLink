import { useEffect, useRef, useState } from "react";
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
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "@/components/ui/accordion";
import { Separator } from "@/components/ui/separator";
import { Badge } from "@/components/ui/badge";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useToast } from "@/hooks/use-toast";
import { useQuery, useMutation } from "@tanstack/react-query";
import { queryClient, apiRequest } from "@/lib/queryClient";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import {
  settingsSchema,
  controlStateSchema,
  wallboxStatusSchema,
  buildInfoSchema,
} from "@shared/schema";
import type { Settings, ControlState, WallboxStatus } from "@shared/schema";
import { PlugZap, Info } from "lucide-react";

function DemoInputControl() {
  const { toast } = useToast();

  // Hole aktuellen Input-Status von Wallbox
  const { data: wallboxStatus } = useQuery<WallboxStatus>({
    queryKey: ["/api/wallbox/status"],
    refetchInterval: 2000,
  });

  const currentInput = wallboxStatus?.input ?? 0;

  // Mutation für Input-Toggle
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

  const handleToggle = (checked: boolean) => {
    const newValue = checked ? 1 : 0;
    setInputMutation.mutate(newValue);
  };

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <div className="space-y-0.5">
          <div className="flex items-center gap-2">
            <PlugZap className="w-4 h-4 text-muted-foreground" />
            <Label htmlFor="demo-input-toggle" className="text-sm font-medium">
              Potenzialfreier Kontakt (X1)
            </Label>
          </div>
          <p className="text-xs text-muted-foreground">
            Enable-Eingang der Mock-Wallbox:{" "}
            {currentInput === 1 ? "Eingeschaltet" : "Ausgeschaltet"}
          </p>
        </div>
        <Switch
          id="demo-input-toggle"
          checked={currentInput === 1}
          onCheckedChange={handleToggle}
          disabled={setInputMutation.isPending}
          data-testid="switch-demo-input"
        />
      </div>
    </div>
  );
}

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
          chargingStarted: true,
          chargingStopped: true,
          currentAdjusted: false,
          plugConnected: false,
          plugDisconnected: false,
          batteryLockActivated: false,
          batteryLockDeactivated: false,
          strategyChanged: false,
          errors: false,
        },
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

      form.reset({
        ...settings,
        chargingStrategy: {
          ...strategyDefaults,
          ...settings.chargingStrategy,
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

  const updateControlsMutation = useMutation({
    mutationFn: (newState: ControlState) =>
      apiRequest("POST", "/api/controls", newState),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/controls"] });
      toast({
        title: "Steuerung aktualisiert",
        description: "Die SmartHome-Funktion wurde erfolgreich geändert.",
      });
    },
    onError: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/controls"] });
      toast({
        title: "Fehler",
        description: "Die Steuerung konnte nicht aktualisiert werden.",
        variant: "destructive",
      });
    },
  });

  const handleSave = (data: Settings) => {
    saveSettingsMutation.mutate(data);
  };

  const handleControlChange = (field: keyof ControlState, value: boolean) => {
    controlForm.setValue(field, value);

    // Sende nur das geänderte Feld - nightCharging wird NIE vom Client gesendet
    const currentState = controlForm.getValues();
    const updates: Partial<ControlState> = {
      [field]: value,
    };

    // Füge alle anderen Felder hinzu AUSSER nightCharging (scheduler-only)
    const fullState: ControlState = {
      pvSurplus: field === "pvSurplus" ? value : currentState.pvSurplus,
      batteryLock: field === "batteryLock" ? value : currentState.batteryLock,
      gridCharging:
        field === "gridCharging" ? value : currentState.gridCharging,
      nightCharging: currentState.nightCharging, // Immer aktueller Wert, wird nicht geändert
    };

    updateControlsMutation.mutate(fullState);
  };

  return (
    <div className="flex flex-col h-full">
      <div className="flex-1 overflow-y-auto pb-24 pt-6">
        <div className="max-w-2xl mx-auto px-4 space-y-6">
          <div className="flex items-center justify-between gap-3 mb-2">
            <button
              onClick={() => setShowBuildInfoDialog(true)}
              className="flex items-center gap-3 hover-elevate active-elevate-2 rounded-lg p-2 -m-2 transition-all"
              aria-label="App-Informationen anzeigen"
              data-testid="button-show-build-info"
            >
              <img
                src="/apple-touch-icon.png"
                alt="EnergyLink"
                className="w-10 h-10 rounded-lg"
              />
              <h1 className="text-2xl font-bold mb-0">Einstellungen</h1>
            </button>
            {settings?.demoMode && (
              <Badge
                variant="secondary"
                className="text-xs shrink-0"
                data-testid="badge-demo-mode"
              >
                Demo
              </Badge>
            )}
          </div>

          <form onSubmit={form.handleSubmit(handleSave)} className="space-y-6">
            <div className="flex flex-col p-4 border rounded-lg space-y-3 bg-accent/30">
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
                  checked={form.watch("demoMode") ?? false}
                  onCheckedChange={(checked) => {
                    if (!settingsLoaded || !formHydratedRef.current) {
                      toast({
                        title: "Bitte warten",
                        description: "Einstellungen werden geladen...",
                      });
                      return;
                    }

                    form.setValue("demoMode", checked);
                    const currentSettings = form.getValues();
                    saveSettingsMutation.mutate(currentSettings);
                  }}
                  data-testid="switch-demo-mode"
                  disabled={
                    isLoadingSettings ||
                    !formHydratedRef.current ||
                    saveSettingsMutation.isPending
                  }
                />
              </div>

              {form.watch("demoMode") && (
                <>
                  <Separator />

                  <div className="border rounded-lg p-4 space-y-3 bg-card">
                    <div className="space-y-0.5">
                      <Label className="text-sm font-medium">
                        Mock-Wallbox Parameter
                      </Label>
                      <p className="text-xs text-muted-foreground">
                        Simulierte Hardware-Zustände der Wallbox
                      </p>
                    </div>

                    <Separator />

                    <div className="space-y-2">
                      <Label
                        htmlFor="mock-wallbox-phases"
                        className="text-sm font-medium"
                      >
                        Phasenanzahl
                      </Label>
                      <Select
                        value={String(form.watch("mockWallboxPhases") ?? 3)}
                        onValueChange={(value) =>
                          form.setValue(
                            "mockWallboxPhases",
                            Number(value) as 1 | 3,
                          )
                        }
                      >
                        <SelectTrigger
                          id="mock-wallbox-phases"
                          className="h-12"
                          data-testid="select-mock-phases"
                        >
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="1">1 Phase (einphasig)</SelectItem>
                          <SelectItem value="3">
                            3 Phasen (dreiphasig)
                          </SelectItem>
                        </SelectContent>
                      </Select>
                      <p className="text-xs text-muted-foreground">
                        Simuliert den physischen Phasen-Umschalter
                      </p>
                    </div>

                    <DemoInputControl />

                    <div className="space-y-2">
                      <Label
                        htmlFor="mock-plug-status"
                        className="text-sm font-medium"
                      >
                        Kabel-Status (Plug)
                      </Label>
                      <Select
                        value={String(form.watch("mockWallboxPlugStatus") ?? 7)}
                        onValueChange={(value) =>
                          form.setValue("mockWallboxPlugStatus", Number(value))
                        }
                      >
                        <SelectTrigger
                          id="mock-plug-status"
                          className="h-12"
                          data-testid="select-mock-plug"
                        >
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="0">
                            0 - Getrennt (unplugged)
                          </SelectItem>
                          <SelectItem value="1">
                            1 - In Buchse (in socket)
                          </SelectItem>
                          <SelectItem value="3">
                            3 - Verriegelt (locked)
                          </SelectItem>
                          <SelectItem value="5">5 - Bereit (ready)</SelectItem>
                          <SelectItem value="7">
                            7 - Laden / Verriegelt (charging)
                          </SelectItem>
                        </SelectContent>
                      </Select>
                      <p className="text-xs text-muted-foreground">
                        Simuliert Kabelstatus für Broadcast-Test
                      </p>
                    </div>
                  </div>

                  <div className="space-y-2">
                    <Label className="text-sm font-medium">
                      Simulierte Tageszeit
                    </Label>
                    <div className="flex items-center gap-3">
                      <Switch
                        id="mock-time-enabled"
                        checked={form.watch("mockTimeEnabled") ?? false}
                        onCheckedChange={(checked) => {
                          form.setValue("mockTimeEnabled", checked);
                          if (checked) {
                            const now = new Date();
                            const year = now.getFullYear();
                            const month = String(now.getMonth() + 1).padStart(
                              2,
                              "0",
                            );
                            const day = String(now.getDate()).padStart(2, "0");
                            form.setValue(
                              "mockDateTime",
                              `${year}-${month}-${day}T12:00`,
                            );
                          } else {
                            form.setValue("mockDateTime", "");
                          }
                        }}
                        data-testid="switch-mock-time-enabled"
                      />
                      {form.watch("mockTimeEnabled") && (
                        <Input
                          id="mock-datetime"
                          type="datetime-local"
                          {...form.register("mockDateTime")}
                          className="h-12 border-none bg-transparent p-0 pl-3 text-left focus-visible:ring-0 [-webkit-appearance:none] [&::-webkit-calendar-picker-indicator]:dark:invert [&::-webkit-date-and-time-value]:text-left [&::-webkit-datetime-edit]:p-0 [&::-webkit-datetime-edit-text]:p-0 [&::-webkit-datetime-edit-text]:m-0 [&::-webkit-datetime-edit-fields-wrapper]:p-0"
                          data-testid="input-mock-datetime"
                        />
                      )}
                    </div>
                    <p className="text-xs text-muted-foreground">
                      Datum steuert Jahreszeit (Winter: ~3.5kW Peak, Sommer:
                      ~8kW Peak), Uhrzeit die PV-Kurve
                    </p>
                  </div>

                  <Separator />

                  <Button
                    type="button"
                    onClick={() => {
                      const currentSettings = form.getValues();
                      saveSettingsMutation.mutate(currentSettings);
                    }}
                    disabled={saveSettingsMutation.isPending}
                    className="w-full"
                    data-testid="button-save-demo-settings"
                  >
                    {saveSettingsMutation.isPending
                      ? "Speichern..."
                      : "Demo-Einstellungen speichern"}
                  </Button>
                </>
              )}
            </div>

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

            <div className="border rounded-lg p-4 space-y-3">
              <div className="flex items-center justify-between">
                <div className="space-y-0.5">
                  <Label htmlFor="e3dc-enabled" className="text-sm font-medium">
                    E3DC-Integration
                  </Label>
                  <p className="text-xs text-muted-foreground">
                    Steuerung über Kommandozeilen-Tool e3dcset
                  </p>
                </div>
                <Switch
                  id="e3dc-enabled"
                  checked={form.watch("e3dc.enabled")}
                  onCheckedChange={(checked) =>
                    form.setValue("e3dc.enabled", checked)
                  }
                  data-testid="switch-e3dc-enabled"
                />
              </div>

              {form.watch("e3dc.enabled") && (
                <>
                  <Separator />

                  <Accordion type="single" collapsible className="w-full">
                    <AccordionItem value="e3dc-config" className="border-none">
                      <div className="flex items-center justify-between">
                        <Label className="text-sm font-medium">
                          Konfiguration e3dcset
                        </Label>
                        <AccordionTrigger className="hover:no-underline p-0 h-auto" />
                      </div>

                      <AccordionContent>
                        <div className="space-y-4 pt-2">
                          <div className="p-3 rounded-md bg-muted">
                            <p className="text-xs text-muted-foreground">
                              <strong>Hinweis:</strong> Der Prefix wird
                              automatisch vor jeden Parameter gesetzt. Geben Sie
                              in den folgenden Feldern nur die spezifischen
                              Parameter ein (z.B. "-d 1").
                            </p>
                          </div>

                          <div className="space-y-2">
                            <Label
                              htmlFor="e3dc-prefix"
                              className="text-sm font-medium"
                            >
                              CLI-Tool & Konfiguration (Prefix)
                            </Label>
                            <Input
                              id="e3dc-prefix"
                              type="text"
                              placeholder="/opt/keba-wallbox/e3dcset -p /opt/keba-wallbox/e3dcset.config"
                              {...form.register("e3dc.prefix")}
                              className="h-12 font-mono text-sm"
                              data-testid="input-e3dc-prefix"
                            />
                            <p className="text-xs text-muted-foreground">
                              Gemeinsamer Teil aller Befehle (Pfad zum Tool +
                              Konfigurationsdatei)
                            </p>
                          </div>

                          <div className="space-y-2">
                            <Label
                              htmlFor="e3dc-discharge-lock-enable"
                              className="text-sm font-medium"
                            >
                              Entladesperre aktivieren (Parameter)
                            </Label>
                            <Input
                              id="e3dc-discharge-lock-enable"
                              type="text"
                              placeholder="-d 1"
                              {...form.register(
                                "e3dc.dischargeLockEnableCommand",
                              )}
                              className="h-12 font-mono text-sm"
                              data-testid="input-e3dc-discharge-lock-enable"
                            />
                            <p className="text-xs text-muted-foreground">
                              Parameter zum Aktivieren der Entladesperre
                            </p>
                          </div>

                          <div className="space-y-2">
                            <Label
                              htmlFor="e3dc-discharge-lock-disable"
                              className="text-sm font-medium"
                            >
                              Entladesperre deaktivieren (Parameter)
                            </Label>
                            <Input
                              id="e3dc-discharge-lock-disable"
                              type="text"
                              placeholder="-a"
                              {...form.register(
                                "e3dc.dischargeLockDisableCommand",
                              )}
                              className="h-12 font-mono text-sm"
                              data-testid="input-e3dc-discharge-lock-disable"
                            />
                            <p className="text-xs text-muted-foreground">
                              Parameter zum Deaktivieren der Entladesperre
                            </p>
                          </div>

                          <Separator />

                          <div className="space-y-4">
                            <div className="space-y-2">
                              <Label
                                htmlFor="e3dc-grid-charge-enable"
                                className="text-sm font-medium"
                              >
                                Netzstrom-Laden aktivieren (Parameter)
                              </Label>
                              <Input
                                id="e3dc-grid-charge-enable"
                                type="text"
                                placeholder="-c 2500 -e 6000"
                                {...form.register(
                                  "e3dc.gridChargeEnableCommand",
                                )}
                                className="h-12 font-mono text-sm"
                                data-testid="input-e3dc-grid-charge-enable"
                              />
                              <p className="text-xs text-muted-foreground">
                                Parameter zum Aktivieren des Netzstrom-Ladens
                              </p>
                            </div>

                            <div className="space-y-2">
                              <Label
                                htmlFor="e3dc-grid-charge-disable"
                                className="text-sm font-medium"
                              >
                                Netzstrom-Laden deaktivieren (Parameter)
                              </Label>
                              <Input
                                id="e3dc-grid-charge-disable"
                                type="text"
                                placeholder="-e 0"
                                {...form.register(
                                  "e3dc.gridChargeDisableCommand",
                                )}
                                className="h-12 font-mono text-sm"
                                data-testid="input-e3dc-grid-charge-disable"
                              />
                              <p className="text-xs text-muted-foreground">
                                Parameter zum Deaktivieren des Netzstrom-Ladens
                              </p>
                            </div>
                          </div>

                          <div className="p-3 rounded-md bg-muted">
                            <p className="text-xs text-muted-foreground">
                              <strong>Hinweis:</strong> Die E3DC-Integration
                              steuert die Batterie-Entladesperre und das
                              Netzstrom-Laden direkt über das e3dcset CLI-Tool.
                              Stellen Sie sicher, dass die entsprechenden
                              Befehle korrekt konfiguriert sind.
                            </p>
                          </div>
                        </div>
                      </AccordionContent>
                    </AccordionItem>
                  </Accordion>
                </>
              )}
            </div>

            <Separator />

            <div className="border rounded-lg p-4 space-y-3">
              <div className="flex items-center justify-between">
                <div className="space-y-0.5">
                  <Label htmlFor="fhem-sync-enabled" className="text-sm font-medium">
                    FHEM E3DC Sync
                  </Label>
                  <p className="text-xs text-muted-foreground">
                    Sendet E3DC-Daten alle 10s an FHEM Device 'S10'
                  </p>
                </div>
                <Switch
                  id="fhem-sync-enabled"
                  checked={form.watch("fhemSync.enabled")}
                  onCheckedChange={(checked) =>
                    form.setValue("fhemSync.enabled", checked)
                  }
                  data-testid="switch-fhem-sync-enabled"
                />
              </div>

              {form.watch("fhemSync.enabled") && (
                <>
                  <Separator />

                  <div className="space-y-4">
                    <div className="space-y-2">
                      <Label
                        htmlFor="fhem-host"
                        className="text-sm font-medium"
                      >
                        FHEM Server IP
                      </Label>
                      <Input
                        id="fhem-host"
                        type="text"
                        placeholder="192.168.40.11"
                        {...form.register("fhemSync.host")}
                        className="h-12"
                        data-testid="input-fhem-host"
                      />
                      <p className="text-xs text-muted-foreground">
                        IP-Adresse des FHEM-Servers
                      </p>
                    </div>

                    <div className="space-y-2">
                      <Label
                        htmlFor="fhem-port"
                        className="text-sm font-medium"
                      >
                        FHEM Telnet Port
                      </Label>
                      <Input
                        id="fhem-port"
                        type="number"
                        min="1"
                        max="65535"
                        step="1"
                        {...form.register("fhemSync.port", { valueAsNumber: true })}
                        className="h-12"
                        data-testid="input-fhem-port"
                      />
                      <p className="text-xs text-muted-foreground">
                        Telnet Port des FHEM-Servers (Standard: 7072)
                      </p>
                    </div>

                    <div className="p-3 rounded-md bg-muted">
                      <p className="text-xs text-muted-foreground">
                        <strong>ℹ️ Hinweis:</strong> Es werden 5 E3DC-Werte übertragen: sonne (PV-Leistung), haus (Hausverbrauch), soc (Batterie-Ladezustand), netz (Netzbezug/-einspeisung), speicher (Batterieleistung)
                      </p>
                    </div>
                  </div>
                </>
              )}
            </div>

            <Separator />

            <div className="border rounded-lg p-4 space-y-3">
              <div className="flex items-center justify-between">
                <div className="space-y-0.5">
                  <Label htmlFor="prowl-enabled" className="text-sm font-medium">
                    Prowl Push-Benachrichtigungen
                  </Label>
                  <p className="text-xs text-muted-foreground">
                    Erhalte Benachrichtigungen über Ladeereignisse auf iOS/Android
                  </p>
                </div>
                <Switch
                  id="prowl-enabled"
                  checked={form.watch("prowl.enabled")}
                  onCheckedChange={(checked) =>
                    form.setValue("prowl.enabled", checked)
                  }
                  data-testid="switch-prowl-enabled"
                />
              </div>

              {form.watch("prowl.enabled") && (
                <>
                  <Separator />

                  <div className="space-y-4">
                    <div className="space-y-2">
                      <Label
                        htmlFor="prowl-api-key"
                        className="text-sm font-medium"
                      >
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
                        API Key von <a href="https://www.prowlapp.com" target="_blank" rel="noopener noreferrer" className="underline">prowlapp.com</a>
                      </p>
                    </div>

                    <div className="p-3 rounded-md bg-muted">
                      <p className="text-xs text-muted-foreground">
                        <strong>ℹ️ Hinweis:</strong> Prowl sendet Benachrichtigungen an iOS und Android. Registriere dich kostenlos auf prowlapp.com und kopiere den API Key hierher.
                      </p>
                    </div>

                    <Separator />

                    <div className="space-y-3">
                      <Label className="text-sm font-medium">
                        Benachrichtigungen aktivieren
                      </Label>
                      
                      <div className="space-y-2">
                        <div className="flex items-center justify-between">
                          <Label htmlFor="event-charging-started" className="text-xs font-normal">
                            Ladung gestartet
                          </Label>
                          <Switch
                            id="event-charging-started"
                            checked={form.watch("prowl.events.chargingStarted")}
                            onCheckedChange={(checked) =>
                              form.setValue("prowl.events.chargingStarted", checked)
                            }
                            data-testid="switch-event-charging-started"
                          />
                        </div>
                        
                        <div className="flex items-center justify-between">
                          <Label htmlFor="event-charging-stopped" className="text-xs font-normal">
                            Ladung gestoppt
                          </Label>
                          <Switch
                            id="event-charging-stopped"
                            checked={form.watch("prowl.events.chargingStopped")}
                            onCheckedChange={(checked) =>
                              form.setValue("prowl.events.chargingStopped", checked)
                            }
                            data-testid="switch-event-charging-stopped"
                          />
                        </div>
                        
                        <div className="flex items-center justify-between">
                          <Label htmlFor="event-current-adjusted" className="text-xs font-normal">
                            Ladestrom angepasst
                          </Label>
                          <Switch
                            id="event-current-adjusted"
                            checked={form.watch("prowl.events.currentAdjusted")}
                            onCheckedChange={(checked) =>
                              form.setValue("prowl.events.currentAdjusted", checked)
                            }
                            data-testid="switch-event-current-adjusted"
                          />
                        </div>
                        
                        <div className="flex items-center justify-between">
                          <Label htmlFor="event-plug-connected" className="text-xs font-normal">
                            Auto angesteckt
                          </Label>
                          <Switch
                            id="event-plug-connected"
                            checked={form.watch("prowl.events.plugConnected")}
                            onCheckedChange={(checked) =>
                              form.setValue("prowl.events.plugConnected", checked)
                            }
                            data-testid="switch-event-plug-connected"
                          />
                        </div>
                        
                        <div className="flex items-center justify-between">
                          <Label htmlFor="event-plug-disconnected" className="text-xs font-normal">
                            Auto abgesteckt
                          </Label>
                          <Switch
                            id="event-plug-disconnected"
                            checked={form.watch("prowl.events.plugDisconnected")}
                            onCheckedChange={(checked) =>
                              form.setValue("prowl.events.plugDisconnected", checked)
                            }
                            data-testid="switch-event-plug-disconnected"
                          />
                        </div>
                        
                        <div className="flex items-center justify-between">
                          <Label htmlFor="event-battery-lock-activated" className="text-xs font-normal">
                            Entladesperre aktiviert
                          </Label>
                          <Switch
                            id="event-battery-lock-activated"
                            checked={form.watch("prowl.events.batteryLockActivated")}
                            onCheckedChange={(checked) =>
                              form.setValue("prowl.events.batteryLockActivated", checked)
                            }
                            data-testid="switch-event-battery-lock-activated"
                          />
                        </div>
                        
                        <div className="flex items-center justify-between">
                          <Label htmlFor="event-battery-lock-deactivated" className="text-xs font-normal">
                            Entladesperre deaktiviert
                          </Label>
                          <Switch
                            id="event-battery-lock-deactivated"
                            checked={form.watch("prowl.events.batteryLockDeactivated")}
                            onCheckedChange={(checked) =>
                              form.setValue("prowl.events.batteryLockDeactivated", checked)
                            }
                            data-testid="switch-event-battery-lock-deactivated"
                          />
                        </div>
                        
                        <div className="flex items-center justify-between">
                          <Label htmlFor="event-strategy-changed" className="text-xs font-normal">
                            Strategie gewechselt
                          </Label>
                          <Switch
                            id="event-strategy-changed"
                            checked={form.watch("prowl.events.strategyChanged")}
                            onCheckedChange={(checked) =>
                              form.setValue("prowl.events.strategyChanged", checked)
                            }
                            data-testid="switch-event-strategy-changed"
                          />
                        </div>
                        
                        <div className="flex items-center justify-between">
                          <Label htmlFor="event-errors" className="text-xs font-normal">
                            Fehler aufgetreten
                          </Label>
                          <Switch
                            id="event-errors"
                            checked={form.watch("prowl.events.errors")}
                            onCheckedChange={(checked) =>
                              form.setValue("prowl.events.errors", checked)
                            }
                            data-testid="switch-event-errors"
                          />
                        </div>
                      </div>
                    </div>

                    <Separator />

                    <div className="flex flex-col gap-2">
                      <Button
                        type="button"
                        onClick={() => {
                          const currentSettings = form.getValues();
                          saveSettingsMutation.mutate(currentSettings);
                        }}
                        disabled={saveSettingsMutation.isPending}
                        className="w-full"
                        data-testid="button-save-prowl-settings"
                      >
                        {saveSettingsMutation.isPending
                          ? "Speichern..."
                          : "Prowl-Einstellungen speichern"}
                      </Button>

                      <Button
                        type="button"
                        variant="outline"
                        onClick={async () => {
                          try {
                            const settings = form.getValues();
                            await fetch("/api/settings", {
                              method: "POST",
                              headers: { "Content-Type": "application/json" },
                              body: JSON.stringify(settings),
                            });
                            
                            const response = await fetch("/api/prowl/test", {
                              method: "POST",
                            });
                            
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
                          } catch (error) {
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
                  </div>
                </>
              )}
            </div>

            <Separator />

            <div className="border rounded-lg p-4 space-y-3">
              <Accordion type="single" collapsible className="w-full">
                <AccordionItem value="strategy-params" className="border-none">
                  <div className="space-y-2">
                    <div className="flex items-center justify-between">
                      <Label className="text-base font-medium">
                        Ladestrategie-Parameter
                      </Label>
                      <AccordionTrigger className="hover:no-underline p-0 h-auto" />
                    </div>
                    <p className="text-xs text-muted-foreground">
                      Die aktive Strategie kann auf der Statusseite gewählt
                      werden
                    </p>
                  </div>

                  <Separator className="my-3" />

                  <AccordionContent>
                    <div className="space-y-4 pt-2">
                      <div className="space-y-2">
                        <Label
                          htmlFor="min-start-power"
                          className="text-sm font-medium"
                        >
                          Mindest-Startleistung (W)
                        </Label>
                        <Input
                          id="min-start-power"
                          type="number"
                          min="500"
                          max="5000"
                          step="1"
                          {...form.register(
                            "chargingStrategy.minStartPowerWatt",
                            { valueAsNumber: true },
                          )}
                          className="h-12"
                          data-testid="input-min-start-power"
                        />
                        <p className="text-xs text-muted-foreground">
                          Mindest-Überschuss zum Starten der Ladung (500-5000 W)
                        </p>
                      </div>

                      <div className="space-y-2">
                        <Label
                          htmlFor="stop-threshold"
                          className="text-sm font-medium"
                        >
                          Stopp-Schwellwert (W)
                        </Label>
                        <Input
                          id="stop-threshold"
                          type="number"
                          min="300"
                          max="3000"
                          step="1"
                          {...form.register(
                            "chargingStrategy.stopThresholdWatt",
                            { valueAsNumber: true },
                          )}
                          className="h-12"
                          data-testid="input-stop-threshold"
                        />
                        <p className="text-xs text-muted-foreground">
                          Unterschreitet der Überschuss diesen Wert, wird die
                          Ladung gestoppt (300-3000 W)
                        </p>
                      </div>

                      <div className="space-y-2">
                        <Label
                          htmlFor="start-delay"
                          className="text-sm font-medium"
                        >
                          Start-Verzögerung (Sekunden)
                        </Label>
                        <Input
                          id="start-delay"
                          type="number"
                          min="30"
                          max="600"
                          step="1"
                          {...form.register(
                            "chargingStrategy.startDelaySeconds",
                            { valueAsNumber: true },
                          )}
                          className="h-12"
                          data-testid="input-start-delay"
                        />
                        <p className="text-xs text-muted-foreground">
                          Wartezeit bevor Ladung startet (30-600 s)
                        </p>
                      </div>

                      <div className="space-y-2">
                        <Label
                          htmlFor="stop-delay"
                          className="text-sm font-medium"
                        >
                          Stopp-Verzögerung (Sekunden)
                        </Label>
                        <Input
                          id="stop-delay"
                          type="number"
                          min="60"
                          max="900"
                          step="1"
                          {...form.register(
                            "chargingStrategy.stopDelaySeconds",
                            { valueAsNumber: true },
                          )}
                          className="h-12"
                          data-testid="input-stop-delay"
                        />
                        <p className="text-xs text-muted-foreground">
                          Wartezeit bevor Ladung stoppt (60-900 s)
                        </p>
                      </div>

                      <div className="space-y-2">
                        <Label
                          htmlFor="min-current-change"
                          className="text-sm font-medium"
                        >
                          Mindest-Stromänderung (A)
                        </Label>
                        <Input
                          id="min-current-change"
                          type="number"
                          min="0.1"
                          max="5"
                          step="0.1"
                          {...form.register(
                            "chargingStrategy.minCurrentChangeAmpere",
                            { valueAsNumber: true },
                          )}
                          className="h-12"
                          data-testid="input-min-current-change"
                        />
                        <p className="text-xs text-muted-foreground">
                          Mindestdifferenz für Stromänderung (0.1-5 A)
                        </p>
                      </div>

                      <div className="space-y-2">
                        <Label
                          htmlFor="min-change-interval"
                          className="text-sm font-medium"
                        >
                          Mindest-Änderungsintervall (Sekunden)
                        </Label>
                        <Input
                          id="min-change-interval"
                          type="number"
                          min="10"
                          max="300"
                          step="1"
                          {...form.register(
                            "chargingStrategy.minChangeIntervalSeconds",
                            { valueAsNumber: true },
                          )}
                          className="h-12"
                          data-testid="input-min-change-interval"
                        />
                        <p className="text-xs text-muted-foreground">
                          Mindestabstand zwischen Stromänderungen (10-300 s)
                        </p>
                      </div>
                    </div>
                  </AccordionContent>

                  <Separator className="my-3" />

                  <div className="space-y-2 pt-2">
                    <Label
                      htmlFor="input-x1-strategy"
                      className="text-sm font-medium"
                    >
                      Standard-Ladestrategie
                    </Label>
                    <Select
                      value={
                        form.watch("chargingStrategy.inputX1Strategy") ??
                        "max_without_battery"
                      }
                      onValueChange={(value) =>
                        form.setValue(
                          "chargingStrategy.inputX1Strategy",
                          value as any,
                        )
                      }
                    >
                      <SelectTrigger
                        id="input-x1-strategy"
                        className="h-12"
                        data-testid="select-input-x1-strategy"
                      >
                        <SelectValue placeholder="Strategie wählen" />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="off">Aus</SelectItem>
                        <SelectItem value="surplus_battery_prio">
                          PV-Überschuss (Batterie-Priorität)
                        </SelectItem>
                        <SelectItem value="surplus_vehicle_prio">
                          PV-Überschuss (Fahrzeug-Priorität)
                        </SelectItem>
                        <SelectItem value="max_with_battery">
                          Max Power (mit Batterie)
                        </SelectItem>
                        <SelectItem value="max_without_battery">
                          Max Power (ohne Batterie)
                        </SelectItem>
                      </SelectContent>
                    </Select>
                    <p className="text-xs text-muted-foreground">
                      Wird aktiviert beim Klick auf "Laden starten" und bei geschlossenem X1-Kontakt der Wallbox
                    </p>
                  </div>
                </AccordionItem>
              </Accordion>
            </div>

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
                  <p className="text-xs font-medium text-muted-foreground">
                    Version
                  </p>
                  <p
                    className="text-sm font-mono"
                    data-testid="text-build-version"
                  >
                    v{buildInfo.version}
                  </p>
                </div>
                <div className="space-y-1">
                  <p className="text-xs font-medium text-muted-foreground">
                    Branch
                  </p>
                  <p
                    className="text-sm font-mono"
                    data-testid="text-build-branch"
                  >
                    {buildInfo.branch}
                  </p>
                </div>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1">
                  <p className="text-xs font-medium text-muted-foreground">
                    Commit
                  </p>
                  <p
                    className="text-sm font-mono"
                    data-testid="text-build-commit"
                  >
                    {buildInfo.commit}
                  </p>
                </div>
                <div className="space-y-1">
                  <p className="text-xs font-medium text-muted-foreground">
                    Build
                  </p>
                  <p className="text-sm" data-testid="text-build-time">
                    {new Date(buildInfo.buildTime).toLocaleDateString("de-DE", {
                      year: "numeric",
                      month: "2-digit",
                      day: "2-digit",
                    })}
                    ,{" "}
                    {new Date(buildInfo.buildTime).toLocaleTimeString("de-DE", {
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

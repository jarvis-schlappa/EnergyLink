import { useEffect, useState } from "react";
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
import type { WallboxStatus, Settings } from "@shared/schema";
import type { UseFormReturn } from "react-hook-form";

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

interface DemoModeSectionProps {
  form: UseFormReturn<Settings>;
  settingsLoaded: boolean;
  formHydrated: boolean;
  saveSettingsMutation: ReturnType<typeof useMutation<unknown, Error, Settings>>;
  isLoadingSettings: boolean;
}

export default function DemoModeSection({
  form,
  settingsLoaded,
  formHydrated,
  saveSettingsMutation,
  isLoadingSettings,
}: DemoModeSectionProps) {
  const { toast } = useToast();

  return (
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
            if (!settingsLoaded || !formHydrated) {
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
            !formHydrated ||
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
  );
}

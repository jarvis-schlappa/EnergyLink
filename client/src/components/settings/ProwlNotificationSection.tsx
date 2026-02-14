import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Separator } from "@/components/ui/separator";
import { useToast } from "@/hooks/use-toast";
import type { Settings } from "@shared/schema";
import type { UseFormReturn } from "react-hook-form";
import type { useMutation } from "@tanstack/react-query";

interface ProwlNotificationSectionProps {
  form: UseFormReturn<Settings>;
  saveSettingsMutation: ReturnType<typeof useMutation<unknown, Error, Settings>>;
}

export default function ProwlNotificationSection({
  form,
  saveSettingsMutation,
}: ProwlNotificationSectionProps) {
  const { toast } = useToast();

  return (
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
                {[
                  { id: "charging-started", field: "prowl.events.chargingStarted" as const, label: "Ladung gestartet" },
                  { id: "charging-stopped", field: "prowl.events.chargingStopped" as const, label: "Ladung gestoppt" },
                  { id: "current-adjusted", field: "prowl.events.currentAdjusted" as const, label: "Ladestrom angepasst" },
                  { id: "plug-connected", field: "prowl.events.plugConnected" as const, label: "Auto angesteckt" },
                  { id: "plug-disconnected", field: "prowl.events.plugDisconnected" as const, label: "Auto abgesteckt" },
                  { id: "battery-lock-activated", field: "prowl.events.batteryLockActivated" as const, label: "Entladesperre aktiviert" },
                  { id: "battery-lock-deactivated", field: "prowl.events.batteryLockDeactivated" as const, label: "Entladesperre deaktiviert" },
                  { id: "grid-charging-activated", field: "prowl.events.gridChargingActivated" as const, label: "Netzstrom-Laden aktiviert" },
                  { id: "grid-charging-deactivated", field: "prowl.events.gridChargingDeactivated" as const, label: "Netzstrom-Laden deaktiviert" },
                  { id: "grid-frequency-warning", field: "prowl.events.gridFrequencyWarning" as const, label: "Netzfrequenz Warnung (Tier 2)" },
                  { id: "grid-frequency-critical", field: "prowl.events.gridFrequencyCritical" as const, label: "Netzfrequenz Kritisch (Tier 3)" },
                  { id: "strategy-changed", field: "prowl.events.strategyChanged" as const, label: "Strategie gewechselt" },
                  { id: "errors", field: "prowl.events.errors" as const, label: "Fehler aufgetreten" },
                ].map(({ id, field, label }) => (
                  <div key={id} className="flex items-center justify-between">
                    <Label htmlFor={`event-${id}`} className="text-xs font-normal">
                      {label}
                    </Label>
                    <Switch
                      id={`event-${id}`}
                      checked={form.watch(field)}
                      onCheckedChange={(checked) =>
                        form.setValue(field, checked)
                      }
                      data-testid={`switch-event-${id}`}
                    />
                  </div>
                ))}
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
  );
}

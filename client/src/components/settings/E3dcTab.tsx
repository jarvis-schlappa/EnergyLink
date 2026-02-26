import { useEffect, useCallback } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "@/components/ui/accordion";
import { Separator } from "@/components/ui/separator";
import { Info } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { useMutation } from "@tanstack/react-query";
import { queryClient, apiRequest } from "@/lib/queryClient";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { settingsSchema } from "@shared/schema";
import type { Settings } from "@shared/schema";

interface E3dcTabProps {
  settings: Settings;
  onDirtyChange: (dirty: boolean) => void;
}

export default function E3dcTab({ settings, onDirtyChange }: E3dcTabProps) {
  const { toast } = useToast();

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
      toast({
        title: "E3DC-Einstellungen gespeichert",
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

  // Sofort-Save für Toggles
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

  const e3dcEnabled = form.watch("e3dc.enabled");
  const gridFreqEnabled = form.watch("gridFrequencyMonitor.enabled");

  return (
    <form onSubmit={form.handleSubmit(handleSave)} className="space-y-4" data-testid="e3dc-tab">
      {/* E3DC-Integration Toggle */}
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
            checked={e3dcEnabled}
            onCheckedChange={(checked) => {
              form.setValue("e3dc.enabled", checked);
              handleToggleSave("e3dc.enabled", checked);
            }}
            data-testid="switch-e3dc-enabled"
          />
        </div>
      </div>

      {e3dcEnabled && (
        <>
          {/* Verbindung */}
          <div className="border rounded-lg p-4 space-y-3">
            <Label className="text-sm font-medium">Verbindung</Label>

            <div className="space-y-2">
              <Label htmlFor="e3dc-ip" className="text-sm font-medium">
                IP-Adresse Hauskraftwerk
              </Label>
              <Input
                id="e3dc-ip"
                type="text"
                placeholder="192.168.40.17"
                {...form.register("e3dcIp")}
                className="h-12"
                data-testid="input-e3dc-ip"
              />
              <p className="text-xs text-muted-foreground">
                E3DC S10 – Modbus TCP (Port 502)
              </p>
            </div>

            <div className="space-y-2">
              <Label htmlFor="e3dc-polling-interval" className="text-sm font-medium">
                Polling-Intervall (s)
              </Label>
              <Input
                id="e3dc-polling-interval"
                type="number"
                min="5"
                max="60"
                step="1"
                placeholder="10"
                {...form.register("e3dc.pollingIntervalSeconds", { valueAsNumber: true })}
                className="h-12"
                data-testid="input-e3dc-polling-interval"
              />
              <p className="text-xs text-muted-foreground">
                Aktualisierungsintervall für E3DC-Daten (5–60 Sekunden, Standard: 10)
              </p>
            </div>
          </div>

          {/* Netzfrequenz-Überwachung */}
          <div className="border rounded-lg p-4 space-y-3">
            <div className="flex items-center justify-between">
              <div className="space-y-0.5">
                <Label htmlFor="grid-freq-enabled" className="text-sm font-medium">
                  Netzfrequenz-Überwachung
                </Label>
                <p className="text-xs text-muted-foreground">
                  Überwache Netzfrequenz und reagiere auf Abweichungen
                </p>
              </div>
              <Switch
                id="grid-freq-enabled"
                checked={gridFreqEnabled}
                onCheckedChange={(checked) => {
                  form.setValue("gridFrequencyMonitor.enabled", checked);
                  handleToggleSave("gridFrequencyMonitor.enabled", checked);
                }}
                data-testid="switch-grid-freq-enabled"
              />
            </div>

            {gridFreqEnabled && (
              <div className="space-y-4 pl-4 border-l-2 border-muted">
                <div className="space-y-2">
                  <Label htmlFor="tier2-threshold" className="text-sm font-medium">
                    Warnschwelle (Hz)
                  </Label>
                  <Input
                    id="tier2-threshold"
                    type="number"
                    min="0.01"
                    max="0.5"
                    step="0.01"
                    {...form.register("gridFrequencyMonitor.tier2Threshold", { valueAsNumber: true })}
                    className="h-12"
                    data-testid="input-tier2-threshold"
                  />
                  <p className="text-xs text-muted-foreground">
                    Abweichung von 50 Hz für Warnung (Standard: 0,15 Hz). Abweichungen bis 0,10 Hz sind im Normalbetrieb häufig.
                  </p>
                </div>

                <div className="space-y-2">
                  <Label htmlFor="tier3-threshold" className="text-sm font-medium">
                    Alarmschwelle (Hz)
                  </Label>
                  <Input
                    id="tier3-threshold"
                    type="number"
                    min="0.1"
                    max="1.0"
                    step="0.01"
                    {...form.register("gridFrequencyMonitor.tier3Threshold", { valueAsNumber: true })}
                    className="h-12"
                    data-testid="input-tier3-threshold"
                  />
                  <p className="text-xs text-muted-foreground">
                    Abweichung von 50 Hz für kritischen Modus (Standard: 0,20 Hz)
                  </p>
                </div>

                <div className="flex items-center justify-between">
                  <div className="space-y-0.5">
                    <Label htmlFor="emergency-charging" className="text-xs font-normal">
                      Notladung aktivieren
                    </Label>
                    <p className="text-xs text-muted-foreground">
                      Batterie zu 90% laden bei kritischer Frequenz
                    </p>
                  </div>
                  <Switch
                    id="emergency-charging"
                    checked={form.watch("gridFrequencyMonitor.enableEmergencyCharging")}
                    onCheckedChange={(checked) =>
                      form.setValue("gridFrequencyMonitor.enableEmergencyCharging", checked, { shouldDirty: true })
                    }
                    data-testid="switch-emergency-charging"
                  />
                </div>

                {/* Cross-Tab-Hinweis */}
                <div className="flex items-start gap-2 p-3 rounded-md bg-blue-50 border border-blue-200">
                  <Info className="w-4 h-4 text-blue-600 shrink-0 mt-0.5" />
                  <p className="text-xs text-blue-800" data-testid="cross-ref-system">
                    ⚙️ Benachrichtigungen für Frequenz-Events → Tab System
                  </p>
                </div>
              </div>
            )}
          </div>

          {/* e3dcset Konfiguration (Collapsible) */}
          <div className="border rounded-lg p-4">
            <Accordion type="single" collapsible className="w-full">
              <AccordionItem value="e3dc-config" className="border-none">
                <div className="flex items-center justify-between">
                  <Label className="text-sm font-medium">e3dcset Konfiguration</Label>
                  <AccordionTrigger className="hover:no-underline p-0 h-auto" />
                </div>

                <AccordionContent>
                  <div className="space-y-4 pt-2">
                    <div className="p-3 rounded-md bg-muted">
                      <p className="text-xs text-muted-foreground">
                        <strong>Hinweis:</strong> Der Prefix wird automatisch vor jeden Parameter gesetzt. Geben Sie in den folgenden Feldern nur die spezifischen Parameter ein (z.B. &quot;-d 1&quot;).
                      </p>
                    </div>

                    <div className="space-y-2">
                      <Label htmlFor="e3dc-prefix" className="text-sm font-medium">
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
                    </div>

                    <div className="space-y-2">
                      <Label htmlFor="e3dc-discharge-lock-enable" className="text-sm font-medium">
                        Entladesperre aktivieren
                      </Label>
                      <Input
                        id="e3dc-discharge-lock-enable"
                        type="text"
                        placeholder="-d 1"
                        {...form.register("e3dc.dischargeLockEnableCommand")}
                        className="h-12 font-mono text-sm"
                        data-testid="input-e3dc-discharge-lock-enable"
                      />
                    </div>

                    <div className="space-y-2">
                      <Label htmlFor="e3dc-discharge-lock-disable" className="text-sm font-medium">
                        Entladesperre deaktivieren
                      </Label>
                      <Input
                        id="e3dc-discharge-lock-disable"
                        type="text"
                        placeholder="-a"
                        {...form.register("e3dc.dischargeLockDisableCommand")}
                        className="h-12 font-mono text-sm"
                        data-testid="input-e3dc-discharge-lock-disable"
                      />
                    </div>

                    <Separator />

                    <div className="space-y-2">
                      <Label htmlFor="e3dc-grid-charge-enable" className="text-sm font-medium">
                        Batterie-Netzladung aktivieren
                      </Label>
                      <Input
                        id="e3dc-grid-charge-enable"
                        type="text"
                        placeholder="-c 2500 -e 6000"
                        {...form.register("e3dc.gridChargeEnableCommand")}
                        className="h-12 font-mono text-sm"
                        data-testid="input-e3dc-grid-charge-enable"
                      />
                    </div>

                    <div className="space-y-2">
                      <Label htmlFor="e3dc-grid-charge-disable" className="text-sm font-medium">
                        Batterie-Netzladung deaktivieren
                      </Label>
                      <Input
                        id="e3dc-grid-charge-disable"
                        type="text"
                        placeholder="-e 0"
                        {...form.register("e3dc.gridChargeDisableCommand")}
                        className="h-12 font-mono text-sm"
                        data-testid="input-e3dc-grid-charge-disable"
                      />
                    </div>
                  </div>
                </AccordionContent>
              </AccordionItem>
            </Accordion>
          </div>

          {/* Save Button */}
          {isDirty && (
            <Button
              type="submit"
              size="lg"
              className="w-full h-12 text-base font-medium"
              data-testid="button-save-e3dc"
              disabled={saveMutation.isPending}
            >
              {saveMutation.isPending ? "Wird gespeichert..." : "E3DC-Einstellungen speichern"}
            </Button>
          )}
        </>
      )}
    </form>
  );
}

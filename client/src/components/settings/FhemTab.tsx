import { useEffect, useCallback } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Separator } from "@/components/ui/separator";
import { Info } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { useMutation } from "@tanstack/react-query";
import { queryClient, apiRequest } from "@/lib/queryClient";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { settingsSchema } from "@shared/schema";
import type { Settings } from "@shared/schema";

interface FhemTabProps {
  settings: Settings;
  onDirtyChange: (dirty: boolean) => void;
}

export default function FhemTab({ settings, onDirtyChange }: FhemTabProps) {
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
        title: "FHEM-Einstellungen gespeichert",
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

  const fhemEnabled = form.watch("fhemSync.enabled");

  return (
    <form onSubmit={form.handleSubmit(handleSave)} className="space-y-4" data-testid="fhem-tab">
      {/* FHEM Sync Toggle */}
      <div className="border rounded-lg p-4 space-y-3">
        <div className="flex items-center justify-between">
          <div className="space-y-0.5">
            <Label htmlFor="fhem-sync-enabled" className="text-sm font-medium">
              FHEM E3DC Sync
            </Label>
            <p className="text-xs text-muted-foreground">
              Sendet E3DC-Daten alle 10s an FHEM Device &apos;S10&apos;
            </p>
          </div>
          <Switch
            id="fhem-sync-enabled"
            checked={fhemEnabled}
            onCheckedChange={(checked) => {
              form.setValue("fhemSync.enabled", checked);
              handleToggleSave("fhemSync.enabled", checked);
            }}
            data-testid="switch-fhem-sync-enabled"
          />
        </div>
      </div>

      {fhemEnabled && (
        <>
          {/* Cross-Tab-Hinweis */}
          <div className="flex items-start gap-2 p-3 rounded-md bg-blue-50 border border-blue-200">
            <Info className="w-4 h-4 text-blue-600 shrink-0 mt-0.5" />
            <p className="text-xs text-blue-800" data-testid="cross-ref-e3dc">
              🔋 Erfordert aktivierte E3DC-Integration → Tab E3DC
            </p>
          </div>

          {/* Verbindung */}
          <div className="border rounded-lg p-4 space-y-3">
            <Label className="text-sm font-medium">Verbindung</Label>

            <div className="space-y-2">
              <Label htmlFor="fhem-host" className="text-sm font-medium">
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
              <Label htmlFor="fhem-port" className="text-sm font-medium">
                Telnet Port
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
          </div>

          {/* Garage Auto-Close */}
          <div className="border rounded-lg p-4 space-y-3">
            <div className="flex items-center justify-between">
              <div className="space-y-0.5">
                <Label htmlFor="auto-close-garage" className="text-sm font-medium">
                  Garage Auto-Close
                </Label>
                <p className="text-xs text-muted-foreground">
                  Garagentor schließen wenn Kabel eingesteckt wird (aktor_garagentor)
                </p>
              </div>
              <Switch
                id="auto-close-garage"
                checked={form.watch("fhemSync.autoCloseGarageOnPlug")}
                onCheckedChange={(checked) => {
                  form.setValue("fhemSync.autoCloseGarageOnPlug", checked);
                  handleToggleSave("fhemSync.autoCloseGarageOnPlug", checked);
                }}
                data-testid="switch-auto-close-garage"
              />
            </div>
          </div>

          {/* Info-Box: Übertragene Werte */}
          <div className="p-3 rounded-md bg-muted">
            <p className="text-xs text-muted-foreground">
              <strong>ℹ️ Übertragene Werte:</strong> sonne (PV-Leistung), haus (Hausverbrauch), soc (Batterie-Ladezustand), netz (Netzbezug/-einspeisung), speicher (Batterieleistung)
            </p>
          </div>

          {/* Save Button */}
          {isDirty && (
            <Button
              type="submit"
              size="lg"
              className="w-full h-12 text-base font-medium"
              data-testid="button-save-fhem"
              disabled={saveMutation.isPending}
            >
              {saveMutation.isPending ? "Wird gespeichert..." : "FHEM-Einstellungen speichern"}
            </Button>
          )}
        </>
      )}
    </form>
  );
}

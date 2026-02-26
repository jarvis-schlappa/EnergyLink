import { useEffect, useCallback } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
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
import { useToast } from "@/hooks/use-toast";
import { useMutation } from "@tanstack/react-query";
import { queryClient, apiRequest } from "@/lib/queryClient";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { settingsSchema } from "@shared/schema";
import type { Settings } from "@shared/schema";

interface WallboxTabProps {
  settings: Settings;
  onDirtyChange: (dirty: boolean) => void;
}

export default function WallboxTab({ settings, onDirtyChange }: WallboxTabProps) {
  const { toast } = useToast();

  const form = useForm<Settings>({
    resolver: zodResolver(settingsSchema),
    defaultValues: settings,
  });

  // Sync form when settings change from server
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
        title: "Wallbox-Einstellungen gespeichert",
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

  return (
    <form onSubmit={form.handleSubmit(handleSave)} className="space-y-4" data-testid="wallbox-tab">
      {/* Verbindung */}
      <div className="border rounded-lg p-4 space-y-3">
        <Label className="text-sm font-medium">Verbindung</Label>
        <div className="space-y-2">
          <Label htmlFor="wallbox-ip" className="text-sm font-medium">
            IP-Adresse Wallbox
          </Label>
          <Input
            id="wallbox-ip"
            type="text"
            placeholder="192.168.40.16"
            {...form.register("wallboxIp")}
            className="h-12"
            data-testid="input-wallbox-ip"
          />
          <p className="text-xs text-muted-foreground">
            KEBA P20 im lokalen Netzwerk
          </p>
        </div>
      </div>

      {/* Standard-Ladestrategie */}
      <div className="border rounded-lg p-4 space-y-3">
        <div className="space-y-2">
          <Label htmlFor="input-x1-strategy" className="text-sm font-medium">
            Standard-Ladestrategie
          </Label>
          <Select
            value={form.watch("chargingStrategy.inputX1Strategy") ?? "max_without_battery"}
            onValueChange={(value) =>
              form.setValue("chargingStrategy.inputX1Strategy", value as any, { shouldDirty: true })
            }
          >
            <SelectTrigger id="input-x1-strategy" className="h-12" data-testid="select-input-x1-strategy">
              <SelectValue placeholder="Strategie wählen" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="off">Aus</SelectItem>
              <SelectItem value="surplus_battery_prio">PV-Überschuss (Batterie-Priorität)</SelectItem>
              <SelectItem value="surplus_vehicle_prio">PV-Überschuss (Fahrzeug-Priorität)</SelectItem>
              <SelectItem value="max_with_battery">Max Power (mit Batterie)</SelectItem>
              <SelectItem value="max_without_battery">Max Power (ohne Batterie)</SelectItem>
            </SelectContent>
          </Select>
          <p className="text-xs text-muted-foreground">
            Wird aktiviert bei &quot;Laden starten&quot; und bei geschlossenem X1-Kontakt
          </p>
        </div>
      </div>

      {/* Feintuning (Collapsible) */}
      <div className="border rounded-lg p-4">
        <Accordion type="single" collapsible className="w-full">
          <AccordionItem value="feintuning" className="border-none">
            <div className="flex items-center justify-between">
              <Label className="text-sm font-medium">Feintuning</Label>
              <AccordionTrigger className="hover:no-underline p-0 h-auto" />
            </div>

            <AccordionContent>
              <div className="space-y-4 pt-3">
                <div className="space-y-2">
                  <Label htmlFor="min-start-power" className="text-sm font-medium">
                    Mindest-Startleistung (W)
                  </Label>
                  <Input
                    id="min-start-power"
                    type="number"
                    min="500"
                    max="5000"
                    step="1"
                    {...form.register("chargingStrategy.minStartPowerWatt", { valueAsNumber: true })}
                    className="h-12"
                    data-testid="input-min-start-power"
                  />
                  <p className="text-xs text-muted-foreground">
                    Mindest-Überschuss zum Starten der Ladung (500–5000 W)
                  </p>
                </div>

                <div className="space-y-2">
                  <Label htmlFor="stop-threshold" className="text-sm font-medium">
                    Stopp-Schwellwert (W)
                  </Label>
                  <Input
                    id="stop-threshold"
                    type="number"
                    min="300"
                    max="3000"
                    step="1"
                    {...form.register("chargingStrategy.stopThresholdWatt", { valueAsNumber: true })}
                    className="h-12"
                    data-testid="input-stop-threshold"
                  />
                  <p className="text-xs text-muted-foreground">
                    Unterschreitet der Überschuss diesen Wert, wird die Ladung gestoppt (300–3000 W)
                  </p>
                </div>

                <div className="space-y-2">
                  <Label htmlFor="start-delay" className="text-sm font-medium">
                    Start-Verzögerung (s)
                  </Label>
                  <Input
                    id="start-delay"
                    type="number"
                    min="30"
                    max="600"
                    step="1"
                    {...form.register("chargingStrategy.startDelaySeconds", { valueAsNumber: true })}
                    className="h-12"
                    data-testid="input-start-delay"
                  />
                  <p className="text-xs text-muted-foreground">
                    Wartezeit bevor Ladung startet (30–600 s)
                  </p>
                </div>

                <div className="space-y-2">
                  <Label htmlFor="stop-delay" className="text-sm font-medium">
                    Stopp-Verzögerung (s)
                  </Label>
                  <Input
                    id="stop-delay"
                    type="number"
                    min="60"
                    max="900"
                    step="1"
                    {...form.register("chargingStrategy.stopDelaySeconds", { valueAsNumber: true })}
                    className="h-12"
                    data-testid="input-stop-delay"
                  />
                  <p className="text-xs text-muted-foreground">
                    Wartezeit bevor Ladung stoppt (60–900 s)
                  </p>
                </div>

                <div className="space-y-2">
                  <Label htmlFor="min-current-change" className="text-sm font-medium">
                    Mindest-Regelschritt (A)
                  </Label>
                  <Input
                    id="min-current-change"
                    type="number"
                    min="0.1"
                    max="5"
                    step="0.1"
                    {...form.register("chargingStrategy.minCurrentChangeAmpere", { valueAsNumber: true })}
                    className="h-12"
                    data-testid="input-min-current-change"
                  />
                  <p className="text-xs text-muted-foreground">
                    Mindestdifferenz für Stromänderung (0,1–5 A)
                  </p>
                </div>

                <div className="space-y-2">
                  <Label htmlFor="min-change-interval" className="text-sm font-medium">
                    Regelintervall (s)
                  </Label>
                  <Input
                    id="min-change-interval"
                    type="number"
                    min="10"
                    max="300"
                    step="1"
                    {...form.register("chargingStrategy.minChangeIntervalSeconds", { valueAsNumber: true })}
                    className="h-12"
                    data-testid="input-min-change-interval"
                  />
                  <p className="text-xs text-muted-foreground">
                    Mindestabstand zwischen Stromänderungen (10–300 s)
                  </p>
                </div>
              </div>
            </AccordionContent>
          </AccordionItem>
        </Accordion>
      </div>

      {/* Save Button - nur bei Dirty-State */}
      {isDirty && (
        <Button
          type="submit"
          size="lg"
          className="w-full h-12 text-base font-medium"
          data-testid="button-save-wallbox"
          disabled={saveMutation.isPending}
        >
          {saveMutation.isPending ? "Wird gespeichert..." : "Wallbox-Einstellungen speichern"}
        </Button>
      )}
    </form>
  );
}

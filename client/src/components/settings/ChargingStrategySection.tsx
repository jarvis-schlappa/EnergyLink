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
import type { Settings } from "@shared/schema";
import type { UseFormReturn } from "react-hook-form";

interface ChargingStrategySectionProps {
  form: UseFormReturn<Settings>;
}

export default function ChargingStrategySection({ form }: ChargingStrategySectionProps) {
  return (
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
  );
}

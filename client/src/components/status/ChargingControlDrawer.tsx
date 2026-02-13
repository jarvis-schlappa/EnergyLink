import { Sparkles, Clock } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Separator } from "@/components/ui/separator";
import {
  Drawer,
  DrawerClose,
  DrawerContent,
  DrawerFooter,
  DrawerHeader,
  DrawerTitle,
} from "@/components/ui/drawer";
import type { Settings, ChargingStrategy } from "@shared/schema";
import type { UseMutationResult } from "@tanstack/react-query";

const STRATEGY_OPTIONS: Array<{ value: ChargingStrategy; label: string; description: string }> = [
  { value: "off", label: "Aus", description: "Keine automatische Ladung" },
  { value: "surplus_battery_prio", label: "Überschuss (Batterie priorisiert)", description: "Nur PV Überschuss nutzen" },
  { value: "surplus_vehicle_prio", label: "Überschuss (Fahrzeug priorisiert)", description: "Fahrzeug nur mit PV Überschuss laden" },
  { value: "max_with_battery", label: "Max Power (mit Batterieentladung)", description: "Volle Leistung mit Entladung der Hausbatterie" },
  { value: "max_without_battery", label: "Max Power (ohne Batterieentladung)", description: "Volle Leistung ohne Entladung der Hausbatterie" },
];

export { STRATEGY_OPTIONS };

interface ChargingControlDrawerProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  settings?: Settings;
  updateSettingsMutation: UseMutationResult<unknown, Error, Settings>;
  onStrategyChange: (strategy: ChargingStrategy) => void;
  onNightChargingToggle: (enabled: boolean) => void;
  onNightTimeChange: (field: 'startTime' | 'endTime', value: string) => void;
}

export default function ChargingControlDrawer({
  open,
  onOpenChange,
  settings,
  updateSettingsMutation,
  onStrategyChange,
  onNightChargingToggle,
  onNightTimeChange,
}: ChargingControlDrawerProps) {
  return (
    <Drawer open={open} onOpenChange={onOpenChange}>
      <DrawerContent data-testid="drawer-charging-control">
        <div className="mx-auto w-full max-w-sm">
          <DrawerHeader>
            <DrawerTitle>Fahrzeugladung konfigurieren</DrawerTitle>
          </DrawerHeader>
          <div className="p-4 space-y-4">
            {/* Ladestrategie */}
            <div className="space-y-3">
              <div className="flex items-center gap-2">
                <Sparkles className="w-4 h-4 text-muted-foreground" />
                <Label className="text-sm font-medium">Ladestrategie</Label>
              </div>
              
              <div className="space-y-3">
                {STRATEGY_OPTIONS.filter(opt => opt.value !== "off").map((strategy) => {
                  const isActive = settings?.chargingStrategy?.activeStrategy === strategy.value;
                  const isDisabled = !settings || updateSettingsMutation.isPending;
                  
                  return (
                    <div 
                      key={strategy.value} 
                      className="flex items-start justify-between gap-4"
                    >
                      <div className="space-y-0.5 flex-1">
                        <Label 
                          htmlFor={`strategy-${strategy.value}`} 
                          className="text-sm font-medium cursor-pointer"
                        >
                          {strategy.label}
                        </Label>
                        <p className="text-xs text-muted-foreground">
                          {strategy.description}
                        </p>
                      </div>
                      <Switch
                        id={`strategy-${strategy.value}`}
                        checked={isActive}
                        onCheckedChange={(checked) => {
                          onStrategyChange(checked ? strategy.value : "off");
                        }}
                        disabled={isDisabled}
                        data-testid={`switch-strategy-${strategy.value}`}
                      />
                    </div>
                  );
                })}
              </div>
            </div>

            <Separator />

            {/* Zeitgesteuerte Ladung */}
            <div className="flex items-start justify-between gap-4">
              <div className="space-y-0.5 flex-1">
                <div className="flex items-center gap-2">
                  <Clock className="w-4 h-4 text-muted-foreground" />
                  <Label htmlFor="night-charging-drawer" className="text-sm font-medium">
                    Zeitgesteuerte Ladung
                  </Label>
                </div>
                <p className="text-xs text-muted-foreground">
                  Lädt das Fahrzeug automatisch im hier angegebenen Zeitfenster
                </p>
              </div>
              <Switch
                id="night-charging-drawer"
                checked={settings?.nightChargingSchedule?.enabled || false}
                onCheckedChange={onNightChargingToggle}
                disabled={!settings || updateSettingsMutation.isPending}
                data-testid="switch-night-charging"
              />
            </div>

            {settings?.nightChargingSchedule?.enabled && (
              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1.5">
                  <Label htmlFor="night-start-drawer" className="text-xs font-medium">
                    Startzeit
                  </Label>
                  <Input
                    id="night-start-drawer"
                    type="time"
                    value={settings.nightChargingSchedule.startTime}
                    onChange={(e) => onNightTimeChange('startTime', e.target.value)}
                    className="h-9 text-sm border-none bg-transparent p-0 text-left focus-visible:ring-0 [-webkit-appearance:none] [&::-webkit-calendar-picker-indicator]:dark:invert [&::-webkit-date-and-time-value]:text-left [&::-webkit-datetime-edit]:p-0 [&::-webkit-datetime-edit-text]:p-0 [&::-webkit-datetime-edit-text]:m-0 [&::-webkit-datetime-edit-hour-field]:p-0 [&::-webkit-datetime-edit-hour-field]:m-0 [&::-webkit-datetime-edit-minute-field]:p-0 [&::-webkit-datetime-edit-minute-field]:m-0"
                    data-testid="input-night-start"
                  />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="night-end-drawer" className="text-xs font-medium">
                    Endzeit
                  </Label>
                  <Input
                    id="night-end-drawer"
                    type="time"
                    value={settings.nightChargingSchedule.endTime}
                    onChange={(e) => onNightTimeChange('endTime', e.target.value)}
                    className="h-9 text-sm border-none bg-transparent p-0 text-left focus-visible:ring-0 [-webkit-appearance:none] [&::-webkit-calendar-picker-indicator]:dark:invert [&::-webkit-date-and-time-value]:text-left [&::-webkit-datetime-edit]:p-0 [&::-webkit-datetime-edit-text]:p-0 [&::-webkit-datetime-edit-text]:m-0 [&::-webkit-datetime-edit-hour-field]:p-0 [&::-webkit-datetime-edit-hour-field]:m-0 [&::-webkit-datetime-edit-minute-field]:p-0 [&::-webkit-datetime-edit-minute-field]:m-0"
                    data-testid="input-night-end"
                  />
                </div>
              </div>
            )}
          </div>
          <DrawerFooter>
            <DrawerClose asChild>
              <Button variant="outline" data-testid="button-close-control-drawer">Schließen</Button>
            </DrawerClose>
          </DrawerFooter>
        </div>
      </DrawerContent>
    </Drawer>
  );
}

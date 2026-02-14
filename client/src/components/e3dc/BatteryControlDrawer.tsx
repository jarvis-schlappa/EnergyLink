import { ShieldOff, Zap, Clock } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import {
  Drawer,
  DrawerClose,
  DrawerContent,
  DrawerDescription,
  DrawerFooter,
  DrawerHeader,
  DrawerTitle,
} from "@/components/ui/drawer";
import type { ControlState, Settings } from "@shared/schema";

interface BatteryControlDrawerProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  controlState?: ControlState;
  settings?: Settings;
  isLoadingControls: boolean;
  isLoadingSettings: boolean;
  isControlMutationPending: boolean;
  isSettingsMutationPending: boolean;
  e3dcOperationLocks: { batteryLock: boolean; gridCharging: boolean };
  onControlChange: (field: keyof ControlState, value: boolean) => void;
  onGridChargeDuringNightChange: (value: boolean) => void;
}

export default function BatteryControlDrawer({
  open,
  onOpenChange,
  controlState,
  settings,
  isLoadingControls,
  isLoadingSettings,
  isControlMutationPending,
  isSettingsMutationPending,
  e3dcOperationLocks,
  onControlChange,
  onGridChargeDuringNightChange,
}: BatteryControlDrawerProps) {
  return (
    <Drawer open={open} onOpenChange={onOpenChange}>
      <DrawerContent>
        <div className="mx-auto w-full max-w-sm">
          <DrawerHeader>
            <DrawerTitle>Batterie-Steuerung</DrawerTitle>
            <DrawerDescription>
              Einstellungen für die Hausbatterie
            </DrawerDescription>
          </DrawerHeader>
          <div className="p-4 space-y-4">
            {/* Batterie-Entladesperre */}
            <div className="flex items-start justify-between gap-4">
              <div className="space-y-0.5">
                <div className="flex items-center gap-2">
                  <ShieldOff className="w-4 h-4 text-muted-foreground" />
                  <Label htmlFor="battery-lock-drawer" className="text-sm font-medium">
                    Batterie-Entladesperre
                  </Label>
                </div>
                <p className="text-xs text-muted-foreground">
                  Die Entladung der Hausbatterie ist gesperrt
                </p>
              </div>
              <Switch
                id="battery-lock-drawer"
                checked={controlState?.batteryLock || false}
                onCheckedChange={(checked) => onControlChange("batteryLock", checked)}
                disabled={isLoadingControls || isControlMutationPending || e3dcOperationLocks.batteryLock}
                data-testid="switch-battery-lock"
              />
            </div>

            {/* Netzstrom-Laden */}
            <div className="flex items-start justify-between gap-4">
              <div className="space-y-0.5">
                <div className="flex items-center gap-2">
                  <Zap className="w-4 h-4 text-muted-foreground" />
                  <Label htmlFor="grid-charging-drawer" className="text-sm font-medium">
                    Netzstrom-Laden
                  </Label>
                </div>
                <p className="text-xs text-muted-foreground">
                  Die Hausbatterie wird mit Netzstrom geladen
                </p>
              </div>
              <Switch
                id="grid-charging-drawer"
                checked={controlState?.gridCharging || false}
                onCheckedChange={(checked) => onControlChange("gridCharging", checked)}
                disabled={isLoadingControls || isControlMutationPending || e3dcOperationLocks.gridCharging}
                data-testid="switch-grid-charging"
              />
            </div>

            {/* Netzstrom-Laden während zeitgesteuerter Ladung */}
            <div className="flex items-start justify-between gap-4">
              <div className="space-y-0.5">
                <div className="flex items-center gap-2">
                  <Clock className="w-4 h-4 text-muted-foreground" />
                  <Label htmlFor="grid-charge-night-drawer" className="text-sm font-medium">
                    Netzstrom bei zeitgesteuerter Ladung
                  </Label>
                </div>
                <p className="text-xs text-muted-foreground">
                  Hausbatterie mit Netzstrom laden während zeitgesteuerter Ladung
                </p>
              </div>
              <Switch
                id="grid-charge-night-drawer"
                checked={settings?.e3dc?.gridChargeDuringNightCharging || false}
                onCheckedChange={onGridChargeDuringNightChange}
                disabled={isLoadingSettings || isSettingsMutationPending}
                data-testid="switch-e3dc-grid-charge-night"
              />
            </div>
          </div>
          <DrawerFooter>
            <DrawerClose asChild>
              <Button variant="outline" data-testid="button-close-drawer">Schließen</Button>
            </DrawerClose>
          </DrawerFooter>
        </div>
      </DrawerContent>
    </Drawer>
  );
}

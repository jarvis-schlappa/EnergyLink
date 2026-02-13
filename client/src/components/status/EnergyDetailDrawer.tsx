import { Battery, Zap } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import {
  Drawer,
  DrawerClose,
  DrawerContent,
  DrawerDescription,
  DrawerFooter,
  DrawerHeader,
  DrawerTitle,
} from "@/components/ui/drawer";

interface EnergyDetailDrawerProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  energySession: number;
  energyTotal: number;
}

export default function EnergyDetailDrawer({
  open,
  onOpenChange,
  energySession,
  energyTotal,
}: EnergyDetailDrawerProps) {
  return (
    <Drawer open={open} onOpenChange={onOpenChange}>
      <DrawerContent data-testid="drawer-energy-details">
        <DrawerHeader>
          <DrawerTitle>Geladene Energie</DrawerTitle>
          <DrawerDescription>
            Übersicht über die geladene Energie
          </DrawerDescription>
        </DrawerHeader>
        <div className="px-4 pb-4 space-y-4">
          <div className="space-y-3">
            <div className="flex items-center gap-3">
              <div className="flex items-center justify-center w-12 h-12 rounded-full bg-primary/10">
                <Battery className="w-6 h-6 text-primary" />
              </div>
              <div>
                <p className="text-sm text-muted-foreground">Aktuelle Sitzung</p>
                <p className="text-lg font-semibold" data-testid="text-energy-session">
                  {energySession.toFixed(1)} kWh
                </p>
              </div>
            </div>
          </div>

          <Separator />

          <div className="space-y-3">
            <div className="flex items-center gap-3">
              <div className="flex items-center justify-center w-12 h-12 rounded-full bg-green-500/10 dark:bg-green-400/10">
                <Zap className="w-6 h-6 text-green-500 dark:text-green-400" />
              </div>
              <div>
                <p className="text-sm text-muted-foreground">Gesamtenergie</p>
                <p className="text-lg font-semibold" data-testid="text-energy-total">
                  {energyTotal.toFixed(1)} kWh
                </p>
              </div>
            </div>
          </div>
        </div>
        <DrawerFooter>
          <DrawerClose asChild>
            <Button variant="outline" data-testid="button-close-energy-drawer">Schließen</Button>
          </DrawerClose>
        </DrawerFooter>
      </DrawerContent>
    </Drawer>
  );
}

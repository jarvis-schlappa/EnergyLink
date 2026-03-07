import { Battery, Activity } from "lucide-react";
import {
  Drawer,
  DrawerContent,
  DrawerFooter,
  DrawerHeader,
  DrawerTitle,
  DrawerClose,
} from "@/components/ui/drawer";
import { Button } from "@/components/ui/button";
import type { SmartBufferStatus } from "@shared/schema";

interface SmartBufferDetailDrawerProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  status?: SmartBufferStatus;
}

const phaseLabel: Record<SmartBufferStatus["phase"], string> = {
  MORNING_HOLD: "Puffer halten",
  CLIPPING_GUARD: "Abregelschutz aktiv",
  FILL_UP: "Akku auffüllen",
  FULL: "Akku voll",
};

export default function SmartBufferDetailDrawer({ open, onOpenChange, status }: SmartBufferDetailDrawerProps) {
  const lastEvents = status?.phaseChanges?.slice(-8).reverse() || [];

  return (
    <Drawer open={open} onOpenChange={onOpenChange}>
      <DrawerContent>
        <div className="mx-auto w-full max-w-sm">
          <DrawerHeader>
            <DrawerTitle>Smart Buffer</DrawerTitle>
          </DrawerHeader>

          <div className="px-4 pb-4 space-y-4 text-sm">
            <div className="rounded-lg border p-3 space-y-1">
              <div className="flex items-center gap-2 font-medium">
                <Battery className="h-4 w-4" />
                <span>{status ? phaseLabel[status.phase] : "Kein Status"}</span>
              </div>
              <div className="text-muted-foreground">SOC {status?.soc ?? 0}% / Ziel {status?.targetSoc ?? 100}%</div>
              <div className="text-muted-foreground">Soll-Ladeleistung {Math.round(status?.targetChargePowerWatt ?? 0)}W</div>
              <div className="text-muted-foreground">Akku-Limit {Math.round(status?.batteryChargeLimitWatt ?? 0)}W</div>
            </div>

            <div className="rounded-lg border p-3 space-y-1">
              <div className="flex items-center gap-2 font-medium">
                <Activity className="h-4 w-4" />
                <span>Prognose vs. Ist</span>
              </div>
              <div className="text-muted-foreground">Prognose: {(status?.forecastKwh ?? 0).toFixed(1)} kWh</div>
              <div className="text-muted-foreground">Ist heute: {(status?.actualKwh ?? 0).toFixed(1)} kWh</div>
              <div className="text-muted-foreground">Einspeisung: {Math.round(status?.feedInWatt ?? 0)}W</div>
            </div>

            <div className="rounded-lg border p-3">
              <div className="font-medium mb-2">Phasenwechsel heute</div>
              <div className="space-y-1 text-xs text-muted-foreground">
                {lastEvents.length === 0 && <div>Keine Ereignisse</div>}
                {lastEvents.map((event, idx) => (
                  <div key={`${event.time}-${idx}`}>
                    {new Date(event.time).toLocaleTimeString("de-DE", { hour: "2-digit", minute: "2-digit", second: "2-digit" })}: {phaseLabel[event.from]} -&gt; {phaseLabel[event.to]}
                  </div>
                ))}
              </div>
            </div>
          </div>

          <DrawerFooter>
            <DrawerClose asChild>
              <Button variant="outline">Schließen</Button>
            </DrawerClose>
          </DrawerFooter>
        </div>
      </DrawerContent>
    </Drawer>
  );
}

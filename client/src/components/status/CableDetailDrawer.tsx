import { Plug, Clock } from "lucide-react";
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
import { formatDistanceToNow, format } from "date-fns";
import { de } from "date-fns/locale";
import type { PlugStatusTracking } from "@shared/schema";

interface CableDetailDrawerProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  plugStatus: number;
  plugTracking?: PlugStatusTracking;
  getPlugStatus: (plug: number) => string;
}

export default function CableDetailDrawer({
  open,
  onOpenChange,
  plugStatus,
  plugTracking,
  getPlugStatus,
}: CableDetailDrawerProps) {
  const getLastChangeFormatted = () => {
    if (!plugTracking?.lastPlugChange) return null;
    
    const lastChange = new Date(plugTracking.lastPlugChange);
    const relativeTime = formatDistanceToNow(lastChange, { 
      addSuffix: true, 
      locale: de 
    });
    
    const absoluteTime = format(lastChange, 'dd.MM.yyyy, HH:mm', { locale: de });
    
    return {
      relative: relativeTime,
      absolute: absoluteTime
    };
  };

  return (
    <Drawer open={open} onOpenChange={onOpenChange}>
      <DrawerContent data-testid="drawer-cable-details">
        <DrawerHeader>
          <DrawerTitle>Kabelverbindung</DrawerTitle>
          <DrawerDescription>
            Status der Kabelverbindung zum Auto
          </DrawerDescription>
        </DrawerHeader>
        <div className="px-4 pb-4 space-y-4">
          <div className="space-y-3">
            <div className="flex items-center gap-3">
              <div className="flex items-center justify-center w-12 h-12 rounded-full bg-primary/10">
                <Plug className="w-6 h-6 text-primary" />
              </div>
              <div>
                <p className="text-sm text-muted-foreground">Aktueller Status</p>
                <p className="text-lg font-semibold" data-testid="text-current-cable-status">
                  {getPlugStatus(plugStatus)}
                </p>
              </div>
            </div>
          </div>

          <Separator />

          <div className="space-y-3">
            <div className="flex items-center gap-3">
              <div className="flex items-center justify-center w-12 h-12 rounded-full bg-blue-500/10 dark:bg-blue-400/10">
                <Clock className="w-6 h-6 text-blue-500 dark:text-blue-400" />
              </div>
              <div className="flex-1">
                <p className="text-sm text-muted-foreground">Letzter Statuswechsel</p>
                {getLastChangeFormatted() ? (
                  <div data-testid="section-last-change">
                    <p className="text-lg font-semibold" data-testid="text-last-change-relative">
                      {getLastChangeFormatted()?.relative}
                    </p>
                    <p className="text-sm text-muted-foreground" data-testid="text-last-change-absolute">
                      {getLastChangeFormatted()?.absolute} Uhr
                    </p>
                  </div>
                ) : (
                  <p className="text-base text-muted-foreground" data-testid="text-no-change-tracked">
                    Kein Wechsel seit App-Start erfasst
                  </p>
                )}
              </div>
            </div>
          </div>
        </div>
        <DrawerFooter>
          <DrawerClose asChild>
            <Button variant="outline" data-testid="button-close-cable-drawer">Schließen</Button>
          </DrawerClose>
        </DrawerFooter>
      </DrawerContent>
    </Drawer>
  );
}

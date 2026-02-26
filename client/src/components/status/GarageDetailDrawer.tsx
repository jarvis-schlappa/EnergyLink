import { useRef, useState, useCallback, useEffect } from "react";
import { Warehouse, Clock, Loader2 } from "lucide-react";
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
import type { GarageStatus } from "@shared/schema";

interface GarageDetailDrawerProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  garageStatus: GarageStatus | null;
  onToggle: () => void;
  isToggling: boolean;
}

const LONG_PRESS_DURATION_MS = 2000;

export default function GarageDetailDrawer({
  open,
  onOpenChange,
  garageStatus,
  onToggle,
  isToggling,
}: GarageDetailDrawerProps) {
  const [pressProgress, setPressProgress] = useState(0);
  const pressStartRef = useRef<number | null>(null);
  const animationFrameRef = useRef<number | null>(null);
  const triggeredRef = useRef(false);

  const state = garageStatus?.state ?? "unknown";
  const isMoving = state === "moving";
  const isUnknown = state === "unknown";
  const isDisabled = isMoving || isUnknown || isToggling;

  const getStateLabel = () => {
    switch (state) {
      case "open": return "Offen";
      case "closed": return "Geschlossen";
      case "moving": return "Fährt...";
      default: return "Unbekannt";
    }
  };

  const getStateColor = () => {
    switch (state) {
      case "open": return "text-yellow-600 dark:text-yellow-400";
      case "closed": return "text-green-600 dark:text-green-400";
      case "moving": return "text-blue-500 dark:text-blue-400";
      default: return "text-muted-foreground";
    }
  };

  const getButtonLabel = () => {
    if (isToggling || isMoving) return "Wird verarbeitet...";
    if (state === "open") return "Garage schließen (halten)";
    return "Garage öffnen (halten)";
  };

  const StateIcon = Warehouse;

  const getLastChangeFormatted = () => {
    if (!garageStatus?.lastChanged) return null;
    const lastChange = new Date(garageStatus.lastChanged);
    return {
      relative: formatDistanceToNow(lastChange, { addSuffix: true, locale: de }),
      absolute: format(lastChange, "dd.MM.yyyy, HH:mm", { locale: de }),
    };
  };

  const updateProgress = useCallback(() => {
    if (!pressStartRef.current) return;
    const elapsed = Date.now() - pressStartRef.current;
    const progress = Math.min(elapsed / LONG_PRESS_DURATION_MS, 1);
    setPressProgress(progress);

    if (progress >= 1 && !triggeredRef.current) {
      triggeredRef.current = true;
      // Haptic feedback
      if (navigator.vibrate) navigator.vibrate(50);
      onToggle();
      pressStartRef.current = null;
      setPressProgress(0);
      return;
    }

    animationFrameRef.current = requestAnimationFrame(updateProgress);
  }, [onToggle]);

  const handlePressStart = useCallback(() => {
    if (isDisabled) return;
    pressStartRef.current = Date.now();
    triggeredRef.current = false;
    setPressProgress(0);
    animationFrameRef.current = requestAnimationFrame(updateProgress);
  }, [isDisabled, updateProgress]);

  const handlePressEnd = useCallback(() => {
    pressStartRef.current = null;
    if (animationFrameRef.current) {
      cancelAnimationFrame(animationFrameRef.current);
      animationFrameRef.current = null;
    }
    setPressProgress(0);
  }, []);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      if (animationFrameRef.current) {
        cancelAnimationFrame(animationFrameRef.current);
      }
    };
  }, []);

  return (
    <Drawer open={open} onOpenChange={onOpenChange}>
      <DrawerContent data-testid="drawer-garage-details">
        <DrawerHeader>
          <DrawerTitle>Garagentor</DrawerTitle>
          <DrawerDescription>
            Steuerung des Garagentors
          </DrawerDescription>
        </DrawerHeader>
        <div className="px-4 pb-4 space-y-4">
          <div className="space-y-3">
            <div className="flex items-center gap-3">
              <div className={`flex items-center justify-center w-12 h-12 rounded-full ${
                state === "moving" ? "bg-blue-500/10 dark:bg-blue-400/10" :
                state === "open" ? "bg-yellow-500/10 dark:bg-yellow-400/10" :
                state === "closed" ? "bg-green-500/10 dark:bg-green-400/10" :
                "bg-muted"
              }`}>
                {isMoving ? (
                  <Loader2 className="w-6 h-6 text-blue-500 dark:text-blue-400 animate-spin" />
                ) : (
                  <StateIcon className={`w-6 h-6 ${getStateColor()}`} />
                )}
              </div>
              <div>
                <p className="text-sm text-muted-foreground">Aktueller Status</p>
                <p className={`text-lg font-semibold ${getStateColor()}`} data-testid="text-garage-state">
                  {getStateLabel()}
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
                  <div data-testid="section-garage-last-change">
                    <p className="text-lg font-semibold" data-testid="text-garage-last-change-relative">
                      {getLastChangeFormatted()?.relative}
                    </p>
                    <p className="text-sm text-muted-foreground" data-testid="text-garage-last-change-absolute">
                      {getLastChangeFormatted()?.absolute} Uhr
                    </p>
                  </div>
                ) : (
                  <p className="text-base text-muted-foreground" data-testid="text-no-garage-change">
                    Nicht verfügbar
                  </p>
                )}
              </div>
            </div>
          </div>

          <Separator />

          {/* Long-Press Toggle Button */}
          <div className="relative">
            <Button
              className="w-full h-14 text-base font-medium relative overflow-hidden select-none touch-none"
              variant={state === "open" ? "destructive" : "default"}
              disabled={isDisabled}
              onMouseDown={handlePressStart}
              onMouseUp={handlePressEnd}
              onMouseLeave={handlePressEnd}
              onTouchStart={handlePressStart}
              onTouchEnd={handlePressEnd}
              onTouchCancel={handlePressEnd}
              data-testid="button-garage-toggle"
            >
              {/* Progress overlay */}
              {pressProgress > 0 && (
                <div
                  className="absolute inset-0 bg-white/20 transition-none"
                  style={{ width: `${pressProgress * 100}%` }}
                  data-testid="garage-toggle-progress"
                />
              )}
              <span className="relative z-10">{getButtonLabel()}</span>
            </Button>
          </div>
        </div>
        <DrawerFooter>
          <DrawerClose asChild>
            <Button variant="outline" data-testid="button-close-garage-drawer">Schließen</Button>
          </DrawerClose>
        </DrawerFooter>
      </DrawerContent>
    </Drawer>
  );
}

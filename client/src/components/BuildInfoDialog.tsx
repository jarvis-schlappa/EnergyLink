import { Info } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import type { BuildInfo } from "@shared/schema";

interface BuildInfoDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  buildInfo?: BuildInfo;
}

export default function BuildInfoDialog({ open, onOpenChange, buildInfo }: BuildInfoDialogProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md" data-testid="dialog-build-info">
        <DialogHeader>
          <div className="flex items-center gap-2">
            <Info className="w-5 h-5 text-primary" />
            <DialogTitle>EnergyLink App</DialogTitle>
          </div>
          <DialogDescription>
            Smarte Steuerung von KEBA P20 Wallbox und E3DC S10 Hauskraftwerk
          </DialogDescription>
        </DialogHeader>

        {buildInfo ? (
          <div className="space-y-4">
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1">
                <p className="text-xs font-medium text-muted-foreground">
                  Version
                </p>
                <p
                  className="text-sm font-mono"
                  data-testid="text-build-version"
                >
                  v{buildInfo.version}
                </p>
              </div>
              <div className="space-y-1">
                <p className="text-xs font-medium text-muted-foreground">
                  Branch
                </p>
                <p
                  className="text-sm font-mono"
                  data-testid="text-build-branch"
                >
                  {buildInfo.branch}
                </p>
              </div>
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1">
                <p className="text-xs font-medium text-muted-foreground">
                  Commit
                </p>
                <p
                  className="text-sm font-mono"
                  data-testid="text-build-commit"
                >
                  {buildInfo.commit}
                </p>
              </div>
              <div className="space-y-1">
                <p className="text-xs font-medium text-muted-foreground">
                  Build
                </p>
                <p className="text-sm" data-testid="text-build-time">
                  {new Date(buildInfo.buildTime).toLocaleDateString("de-DE", {
                    year: "numeric",
                    month: "2-digit",
                    day: "2-digit",
                  })}
                  ,{" "}
                  {new Date(buildInfo.buildTime).toLocaleTimeString("de-DE", {
                    hour: "2-digit",
                    minute: "2-digit",
                  })}
                </p>
              </div>
            </div>
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">
            Build-Informationen konnten nicht geladen werden
          </p>
        )}
      </DialogContent>
    </Dialog>
  );
}

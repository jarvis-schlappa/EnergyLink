import { useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { queryClient, apiRequest } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import type { LogEntry, LogSettings, LogLevel, Settings } from "@shared/schema";
import { buildInfoSchema } from "@shared/schema";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from "@/components/ui/sheet";
import { Button } from "@/components/ui/button";
import { Filter } from "lucide-react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import PageHeader from "@/components/PageHeader";
import BuildInfoDialog from "@/components/BuildInfoDialog";
import LogFilterCard, { type LogCategory } from "@/components/logs/LogFilterCard";
import LogEntryItem from "@/components/logs/LogEntryItem";

export default function LogsPage() {
  const { toast } = useToast();
  const [filterLevel, setFilterLevel] = useState<LogLevel | "all">("all");
  const [selectedCategories, setSelectedCategories] = useState<LogCategory[]>(
    [],
  );
  const [textFilter, setTextFilter] = useState("");
  const [showBuildInfoDialog, setShowBuildInfoDialog] = useState(false);

  // Lade Build-Info (nur einmal, keine Auto-Updates)
  const { data: buildInfoRaw } = useQuery({
    queryKey: ["/api/build-info"],
    staleTime: Infinity,
  });
  const buildInfoResult = buildInfoRaw
    ? buildInfoSchema.safeParse(buildInfoRaw)
    : null;
  const buildInfo = buildInfoResult?.success ? buildInfoResult.data : undefined;

  const {
    data: logs = [],
    isLoading: logsLoading,
    refetch,
  } = useQuery<LogEntry[]>({
    queryKey: ["/api/logs"],
    refetchInterval: 2000,
  });

  const { data: logSettings } = useQuery<LogSettings>({
    queryKey: ["/api/logs/settings"],
  });

  const { data: settings } = useQuery<Settings>({
    queryKey: ["/api/settings"],
  });

  const updateLogLevelMutation = useMutation({
    mutationFn: (level: LogLevel) =>
      apiRequest("POST", "/api/logs/settings", { level }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/logs/settings"] });
      toast({
        title: "Log-Level aktualisiert",
        description: "Die Einstellung wurde gespeichert.",
      });
    },
    onError: () => {
      toast({
        title: "Fehler",
        description: "Log-Level konnte nicht aktualisiert werden.",
        variant: "destructive",
      });
    },
  });

  const clearLogsMutation = useMutation({
    mutationFn: () => apiRequest("DELETE", "/api/logs"),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/logs"] });
      toast({
        title: "Logs gelöscht",
        description: "Alle Log-Einträge wurden entfernt.",
      });
    },
    onError: () => {
      toast({
        title: "Fehler",
        description: "Logs konnten nicht gelöscht werden.",
        variant: "destructive",
      });
    },
  });

  const logLevelPriority: Record<LogLevel, number> = {
    trace: 0,
    debug: 1,
    info: 2,
    warning: 3,
    error: 4,
  };

  const filteredLogs = logs
    .filter((log) => {
      if (filterLevel === "all") return true;
      const logPriority = logLevelPriority[log.level];
      const filterPriority = logLevelPriority[filterLevel];
      return logPriority >= filterPriority;
    })
    .filter(
      (log) =>
        selectedCategories.length === 0 ||
        selectedCategories.includes(log.category as LogCategory),
    )
    .filter((log) => {
      if (!textFilter.trim()) return true;
      const searchText = textFilter.toLowerCase();
      return (
        log.message.toLowerCase().includes(searchText) ||
        log.details?.toLowerCase().includes(searchText) ||
        log.category.toLowerCase().includes(searchText)
      );
    })
    .reverse();

  const toggleCategory = (category: LogCategory) => {
    setSelectedCategories((prev) =>
      prev.includes(category)
        ? prev.filter((c) => c !== category)
        : [...prev, category],
    );
  };

  return (
    <div className="flex flex-col h-full">
      <div className="flex-1 overflow-y-auto pb-24 pt-6">
        <div className="max-w-4xl mx-auto px-4 space-y-6">
          <PageHeader
            title="Logs"
            onLogoClick={() => setShowBuildInfoDialog(true)}
            isDemoMode={settings?.demoMode}
          />

          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-base">Log-Level</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="flex flex-col gap-2">
                <Select
                  value={logSettings?.level || "info"}
                  onValueChange={(value) =>
                    updateLogLevelMutation.mutate(value as LogLevel)
                  }
                  data-testid="select-log-level"
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="trace">
                      Trace (sehr detailliert, inkl. HTTP)
                    </SelectItem>
                    <SelectItem value="debug">
                      Debug (alle Meldungen)
                    </SelectItem>
                    <SelectItem value="info">Info (Standard)</SelectItem>
                    <SelectItem value="warning">Warning (Warnungen)</SelectItem>
                    <SelectItem value="error">Error (nur Fehler)</SelectItem>
                  </SelectContent>
                </Select>
                <p className="text-xs text-muted-foreground">
                  Bestimmt welche Log-Meldungen aufgezeichnet werden
                </p>
              </div>
            </CardContent>
          </Card>

          {filteredLogs.length === 0 && !logsLoading && (
            <Alert data-testid="alert-no-logs">
              <Filter className="h-4 w-4" />
              <AlertDescription>
                Keine Log-Einträge vorhanden. Sobald die Wallbox abgefragt wird
                oder Webhooks aufgerufen werden, erscheinen hier die Logs.
              </AlertDescription>
            </Alert>
          )}

          <div className="space-y-3">
            {filteredLogs.map((log) => (
              <LogEntryItem key={log.id} log={log} />
            ))}
          </div>

          {logsLoading && filteredLogs.length === 0 && (
            <div className="text-center text-muted-foreground py-8">
              Lade Logs...
            </div>
          )}
        </div>
      </div>

      <BuildInfoDialog
        open={showBuildInfoDialog}
        onOpenChange={setShowBuildInfoDialog}
        buildInfo={buildInfo}
      />

      <div className="fixed bottom-20 right-4 z-50">
        <Sheet>
          <SheetTrigger asChild>
            <Button
              size="lg"
              className="rounded-full shadow-lg h-14 w-14"
              data-testid="fab-filter"
            >
              <Filter className="w-5 h-5" />
            </Button>
          </SheetTrigger>
          <SheetContent side="bottom" className="h-[80vh] overflow-y-auto">
            <SheetHeader>
              <SheetTitle>Filter</SheetTitle>
            </SheetHeader>
            <LogFilterCard
              filterLevel={filterLevel}
              onFilterLevelChange={setFilterLevel}
              textFilter={textFilter}
              onTextFilterChange={setTextFilter}
              selectedCategories={selectedCategories}
              onToggleCategory={toggleCategory}
              onClearCategories={() => setSelectedCategories([])}
              onRefresh={() => refetch()}
              onClearLogs={() => clearLogsMutation.mutate()}
              isClearingLogs={clearLogsMutation.isPending}
            />
          </SheetContent>
        </Sheet>
      </div>
    </div>
  );
}

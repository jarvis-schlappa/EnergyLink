import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Trash2, RefreshCw } from "lucide-react";
import type { LogLevel } from "@shared/schema";

type LogCategory =
  | "wallbox"
  | "wallbox-mock"
  | "e3dc"
  | "e3dc-poller"
  | "e3dc-mock"
  | "fhem"
  | "fhem-mock"
  | "webhook"
  | "system"
  | "storage"
  | "grid-frequency";

const ALL_CATEGORIES: LogCategory[] = [
  "wallbox",
  "wallbox-mock",
  "e3dc",
  "e3dc-poller",
  "e3dc-mock",
  "fhem",
  "fhem-mock",
  "webhook",
  "system",
  "storage",
  "grid-frequency",
];

function getCategoryLabel(category: LogCategory): string {
  switch (category) {
    case "wallbox":
      return "Wallbox";
    case "wallbox-mock":
      return "Wallbox Mock";
    case "e3dc":
      return "E3DC";
    case "e3dc-poller":
      return "E3DC Poller";
    case "e3dc-mock":
      return "E3DC Mock";
    case "fhem":
      return "FHEM";
    case "fhem-mock":
      return "FHEM Mock";
    case "webhook":
      return "Webhook";
    case "system":
      return "System";
    case "storage":
      return "Storage";
    case "grid-frequency":
      return "Netzfrequenz-Monitor";
  }
}

function getCategoryColor(category: string) {
  switch (category) {
    case "wallbox":
      return "bg-blue-500 text-white dark:bg-blue-600";
    case "wallbox-mock":
      return "bg-blue-400 text-white dark:bg-blue-500";
    case "e3dc":
      return "bg-orange-500 text-white dark:bg-orange-600";
    case "e3dc-poller":
      return "bg-orange-600 text-white dark:bg-orange-700";
    case "e3dc-mock":
      return "bg-orange-400 text-white dark:bg-orange-500";
    case "fhem":
      return "bg-teal-500 text-white dark:bg-teal-600";
    case "fhem-mock":
      return "bg-teal-400 text-white dark:bg-teal-500";
    case "webhook":
      return "bg-green-500 text-white dark:bg-green-600";
    case "system":
      return "bg-purple-500 text-white dark:bg-purple-600";
    case "storage":
      return "bg-gray-500 text-white dark:bg-gray-600";
    case "grid-frequency":
      return "bg-red-500 text-white dark:bg-red-600";
    default:
      return "bg-muted text-muted-foreground";
  }
}

export { ALL_CATEGORIES, getCategoryLabel, getCategoryColor };
export type { LogCategory };

interface LogFilterCardProps {
  filterLevel: LogLevel | "all";
  onFilterLevelChange: (level: LogLevel | "all") => void;
  textFilter: string;
  onTextFilterChange: (text: string) => void;
  selectedCategories: LogCategory[];
  onToggleCategory: (category: LogCategory) => void;
  onClearCategories: () => void;
  onRefresh: () => void;
  onClearLogs: () => void;
  isClearingLogs: boolean;
}

export default function LogFilterCard({
  filterLevel,
  onFilterLevelChange,
  textFilter,
  onTextFilterChange,
  selectedCategories,
  onToggleCategory,
  onClearCategories,
  onRefresh,
  onClearLogs,
  isClearingLogs,
}: LogFilterCardProps) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base flex items-center justify-between">
          <span>Filter</span>
          <div className="flex gap-2">
            <Button
              size="sm"
              variant="outline"
              onClick={onRefresh}
              data-testid="button-refresh-logs"
            >
              <RefreshCw className="h-4 w-4" />
            </Button>
            <Button
              size="sm"
              variant="destructive"
              onClick={onClearLogs}
              disabled={isClearingLogs}
              data-testid="button-clear-logs"
            >
              <Trash2 className="h-4 w-4" />
            </Button>
          </div>
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex flex-col gap-2">
          <label className="text-sm text-muted-foreground">Level</label>
          <Select
            value={filterLevel}
            onValueChange={(value) =>
              onFilterLevelChange(value as LogLevel | "all")
            }
            data-testid="select-filter-level"
          >
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">Alle</SelectItem>
              <SelectItem value="trace">Trace (und höher)</SelectItem>
              <SelectItem value="debug">Debug (und höher)</SelectItem>
              <SelectItem value="info">Info (und höher)</SelectItem>
              <SelectItem value="warning">Warning (und höher)</SelectItem>
              <SelectItem value="error">Nur Error</SelectItem>
            </SelectContent>
          </Select>
        </div>

        <div className="flex flex-col gap-2">
          <label className="text-sm text-muted-foreground">Text-Suche</label>
          <Input
            type="text"
            placeholder="Durchsuche Nachricht, Details und Kategorie..."
            value={textFilter}
            onChange={(e) => onTextFilterChange(e.target.value)}
            data-testid="input-text-filter"
          />
          <p className="text-xs text-muted-foreground">
            Filtere Logs nach beliebigem Text (Groß-/Kleinschreibung wird ignoriert)
          </p>
        </div>

        <div className="flex flex-col gap-3">
          <div className="flex items-center justify-between">
            <label className="text-sm text-muted-foreground">
              Kategorien (
              {selectedCategories.length > 0
                ? selectedCategories.length
                : "Alle"}
              )
            </label>
            {selectedCategories.length > 0 && (
              <Button
                size="sm"
                variant="ghost"
                onClick={onClearCategories}
                className="h-6 text-xs"
                data-testid="button-clear-category-filter"
              >
                Alle auswählen
              </Button>
            )}
          </div>
          <div className="flex flex-wrap gap-2">
            {ALL_CATEGORIES.map((category) => {
              const isSelected = selectedCategories.includes(category);
              return (
                <Badge
                  key={category}
                  className={`cursor-pointer transition-all ${
                    isSelected
                      ? getCategoryColor(category)
                      : "bg-muted text-muted-foreground hover-elevate"
                  }`}
                  onClick={() => onToggleCategory(category)}
                  data-testid={`badge-filter-${category}`}
                >
                  {getCategoryLabel(category)}
                </Badge>
              );
            })}
          </div>
          <p className="text-xs text-muted-foreground">
            Klicke auf Kategorien um sie zu filtern. Ohne Auswahl werden
            alle angezeigt.
          </p>
        </div>
      </CardContent>
    </Card>
  );
}

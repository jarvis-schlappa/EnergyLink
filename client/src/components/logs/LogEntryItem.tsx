import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import type { LogEntry, LogLevel } from "@shared/schema";
import { getCategoryColor } from "./LogFilterCard";

function getLevelColor(level: LogLevel) {
  switch (level) {
    case "trace":
      return "bg-gray-400 text-white dark:bg-gray-500";
    case "debug":
      return "bg-muted text-muted-foreground";
    case "info":
      return "bg-primary text-primary-foreground";
    case "warning":
      return "bg-yellow-500 text-white dark:bg-yellow-600";
    case "error":
      return "bg-destructive text-destructive-foreground";
  }
}

function formatTimestamp(timestamp: string) {
  const date = new Date(timestamp);
  return date.toLocaleTimeString("de-DE", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

interface LogEntryItemProps {
  log: LogEntry;
}

export default function LogEntryItem({ log }: LogEntryItemProps) {
  return (
    <Card
      className="overflow-hidden"
      data-testid={`log-entry-${log.id}`}
    >
      <CardContent className="p-4">
        <div className="flex items-start gap-3">
          <div className="flex flex-col gap-1 min-w-0 flex-1">
            <div className="flex items-center gap-2 flex-wrap">
              <Badge
                className={getLevelColor(log.level)}
                data-testid={`badge-level-${log.level}`}
              >
                {log.level.toUpperCase()}
              </Badge>
              <Badge
                className={getCategoryColor(log.category)}
                data-testid={`badge-category-${log.category}`}
              >
                {log.category}
              </Badge>
              <span
                className="text-xs text-muted-foreground"
                data-testid={`text-timestamp-${log.id}`}
              >
                {formatTimestamp(log.timestamp)}
              </span>
            </div>
            <p
              className="text-sm font-medium"
              data-testid={`text-message-${log.id}`}
            >
              {log.message}
            </p>
            {log.details && (
              <p
                className="text-xs text-muted-foreground font-mono break-all"
                data-testid={`text-details-${log.id}`}
              >
                {log.details}
              </p>
            )}
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

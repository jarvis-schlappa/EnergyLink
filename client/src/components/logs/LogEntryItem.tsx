import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import type { LogEntry, LogLevel } from "@shared/schema";
import { getCategoryColor } from "./LogFilterCard";
import {
  AlertCircle,
  AlertTriangle,
  Info,
  Bug,
  Code,
} from "lucide-react";

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

function getLevelIconBg(level: LogLevel) {
  switch (level) {
    case "error":
      return "bg-destructive/10 text-destructive";
    case "warning":
      return "bg-yellow-500/10 text-yellow-600 dark:text-yellow-400";
    case "info":
      return "bg-primary/10 text-primary";
    case "debug":
      return "bg-muted text-muted-foreground";
    case "trace":
      return "bg-gray-100 text-gray-400 dark:bg-gray-800 dark:text-gray-500";
  }
}

function LevelIcon({ level }: { level: LogLevel }) {
  const iconClass = "w-4 h-4";
  switch (level) {
    case "error":
      return <AlertCircle className={iconClass} data-testid="icon-error" />;
    case "warning":
      return <AlertTriangle className={iconClass} data-testid="icon-warning" />;
    case "info":
      return <Info className={iconClass} data-testid="icon-info" />;
    case "debug":
      return <Bug className={iconClass} data-testid="icon-debug" />;
    case "trace":
      return <Code className={iconClass} data-testid="icon-trace" />;
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
      <CardContent className="p-5">
        <div className="flex items-start gap-3">
          <div
            className={`w-8 h-8 rounded-full flex items-center justify-center shrink-0 ${getLevelIconBg(log.level)}`}
            data-testid={`level-icon-container-${log.id}`}
          >
            <LevelIcon level={log.level} />
          </div>

          <div className="flex flex-col gap-2 min-w-0 flex-1">
            <div className="flex items-center gap-2 flex-wrap">
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
              className="text-base font-medium leading-snug"
              data-testid={`text-message-${log.id}`}
            >
              {log.message}
            </p>
            {log.details && (
              <p
                className="text-sm text-muted-foreground font-mono break-all bg-muted/50 p-2 rounded"
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

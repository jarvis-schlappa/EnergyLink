import { Badge } from "@/components/ui/badge";

interface PageHeaderProps {
  title: string;
  onLogoClick: () => void;
  isDemoMode?: boolean;
}

export default function PageHeader({ title, onLogoClick, isDemoMode }: PageHeaderProps) {
  return (
    <div className="flex items-center justify-between gap-3">
      <button
        onClick={onLogoClick}
        className="flex items-center gap-3 hover-elevate active-elevate-2 rounded-lg p-2 -m-2 transition-all"
        aria-label="App-Informationen anzeigen"
        data-testid="button-show-build-info"
      >
        <img
          src="/apple-touch-icon.png"
          alt="EnergyLink"
          className="w-10 h-10 rounded-lg"
        />
        <h1 className="text-2xl font-bold mb-0">{title}</h1>
      </button>
      {isDemoMode && (
        <Badge
          variant="secondary"
          className="text-xs shrink-0"
          data-testid="badge-demo-mode"
        >
          Demo
        </Badge>
      )}
    </div>
  );
}

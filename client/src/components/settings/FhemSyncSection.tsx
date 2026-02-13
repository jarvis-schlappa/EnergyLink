import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Separator } from "@/components/ui/separator";
import type { Settings } from "@shared/schema";
import type { UseFormReturn } from "react-hook-form";

interface FhemSyncSectionProps {
  form: UseFormReturn<Settings>;
}

export default function FhemSyncSection({ form }: FhemSyncSectionProps) {
  return (
    <div className="border rounded-lg p-4 space-y-3">
      <div className="flex items-center justify-between">
        <div className="space-y-0.5">
          <Label htmlFor="fhem-sync-enabled" className="text-sm font-medium">
            FHEM E3DC Sync
          </Label>
          <p className="text-xs text-muted-foreground">
            Sendet E3DC-Daten alle 10s an FHEM Device 'S10'
          </p>
        </div>
        <Switch
          id="fhem-sync-enabled"
          checked={form.watch("fhemSync.enabled")}
          onCheckedChange={(checked) =>
            form.setValue("fhemSync.enabled", checked)
          }
          data-testid="switch-fhem-sync-enabled"
        />
      </div>

      {form.watch("fhemSync.enabled") && (
        <>
          <Separator />

          <div className="space-y-4">
            <div className="space-y-2">
              <Label
                htmlFor="fhem-host"
                className="text-sm font-medium"
              >
                FHEM Server IP
              </Label>
              <Input
                id="fhem-host"
                type="text"
                placeholder="192.168.40.11"
                {...form.register("fhemSync.host")}
                className="h-12"
                data-testid="input-fhem-host"
              />
              <p className="text-xs text-muted-foreground">
                IP-Adresse des FHEM-Servers
              </p>
            </div>

            <div className="space-y-2">
              <Label
                htmlFor="fhem-port"
                className="text-sm font-medium"
              >
                FHEM Telnet Port
              </Label>
              <Input
                id="fhem-port"
                type="number"
                min="1"
                max="65535"
                step="1"
                {...form.register("fhemSync.port", { valueAsNumber: true })}
                className="h-12"
                data-testid="input-fhem-port"
              />
              <p className="text-xs text-muted-foreground">
                Telnet Port des FHEM-Servers (Standard: 7072)
              </p>
            </div>

            <div className="p-3 rounded-md bg-muted">
              <p className="text-xs text-muted-foreground">
                <strong>ℹ️ Hinweis:</strong> Es werden 5 E3DC-Werte übertragen: sonne (PV-Leistung), haus (Hausverbrauch), soc (Batterie-Ladezustand), netz (Netzbezug/-einspeisung), speicher (Batterieleistung)
              </p>
            </div>
          </div>
        </>
      )}
    </div>
  );
}

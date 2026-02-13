import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "@/components/ui/accordion";
import { Separator } from "@/components/ui/separator";
import type { Settings } from "@shared/schema";
import type { UseFormReturn } from "react-hook-form";

interface E3dcIntegrationSectionProps {
  form: UseFormReturn<Settings>;
}

export default function E3dcIntegrationSection({ form }: E3dcIntegrationSectionProps) {
  return (
    <div className="border rounded-lg p-4 space-y-3">
      <div className="flex items-center justify-between">
        <div className="space-y-0.5">
          <Label htmlFor="e3dc-enabled" className="text-sm font-medium">
            E3DC-Integration
          </Label>
          <p className="text-xs text-muted-foreground">
            Steuerung über Kommandozeilen-Tool e3dcset
          </p>
        </div>
        <Switch
          id="e3dc-enabled"
          checked={form.watch("e3dc.enabled")}
          onCheckedChange={(checked) =>
            form.setValue("e3dc.enabled", checked)
          }
          data-testid="switch-e3dc-enabled"
        />
      </div>

      {form.watch("e3dc.enabled") && (
        <>
          <Separator />

          <div className="space-y-2">
            <Label
              htmlFor="e3dc-polling-interval"
              className="text-sm font-medium"
            >
              E3DC Polling-Intervall
            </Label>
            <Input
              id="e3dc-polling-interval"
              type="number"
              min="5"
              max="60"
              step="1"
              placeholder="10"
              {...form.register("e3dc.pollingIntervalSeconds", {
                valueAsNumber: true,
              })}
              className="h-12"
              data-testid="input-e3dc-polling-interval"
            />
            <p className="text-xs text-muted-foreground">
              Aktualisierungsintervall für E3DC-Daten in Sekunden.
              Bestimmt, wie oft die Modbus-Register ausgelesen werden
              (5-60 Sekunden, Standard: 10).
            </p>
          </div>

          <Separator />

          <div className="space-y-3">
            <div className="flex items-center justify-between">
              <div className="space-y-0.5">
                <Label htmlFor="grid-freq-enabled" className="text-sm font-medium">
                  Netzfrequenz-Überwachung
                </Label>
                <p className="text-xs text-muted-foreground">
                  Überwache Netzfrequenz und reagiere auf Abweichungen
                </p>
              </div>
              <Switch
                id="grid-freq-enabled"
                checked={form.watch("gridFrequencyMonitor.enabled")}
                onCheckedChange={(checked) =>
                  form.setValue("gridFrequencyMonitor.enabled", checked)
                }
                data-testid="switch-grid-freq-enabled"
              />
            </div>

            {form.watch("gridFrequencyMonitor.enabled") && (
              <div className="space-y-4 pl-4 border-l-2 border-muted">
                <div className="space-y-2">
                  <Label
                    htmlFor="tier2-threshold"
                    className="text-sm font-medium"
                  >
                    Tier 2 Schwelle (Hz)
                  </Label>
                  <Input
                    id="tier2-threshold"
                    type="number"
                    min="0.01"
                    max="0.5"
                    step="0.01"
                    {...form.register("gridFrequencyMonitor.tier2Threshold", { valueAsNumber: true })}
                    className="h-12"
                    data-testid="input-tier2-threshold"
                  />
                  <p className="text-xs text-muted-foreground">
                    Abweichung von 50 Hz für Warnung (Standard: 0,1 Hz)
                  </p>
                </div>

                <div className="space-y-2">
                  <Label
                    htmlFor="tier3-threshold"
                    className="text-sm font-medium"
                  >
                    Tier 3 Schwelle (Hz)
                  </Label>
                  <Input
                    id="tier3-threshold"
                    type="number"
                    min="0.1"
                    max="1.0"
                    step="0.01"
                    {...form.register("gridFrequencyMonitor.tier3Threshold", { valueAsNumber: true })}
                    className="h-12"
                    data-testid="input-tier3-threshold"
                  />
                  <p className="text-xs text-muted-foreground">
                    Abweichung von 50 Hz für kritischen Modus (Standard: 0,2 Hz)
                  </p>
                </div>

                <div className="flex items-center justify-between">
                  <div className="space-y-0.5">
                    <Label htmlFor="emergency-charging" className="text-xs font-normal">
                      Notladung aktivieren
                    </Label>
                    <p className="text-xs text-muted-foreground">
                      Batterie zu 90% laden bei kritischer Frequenz
                    </p>
                  </div>
                  <Switch
                    id="emergency-charging"
                    checked={form.watch("gridFrequencyMonitor.enableEmergencyCharging")}
                    onCheckedChange={(checked) =>
                      form.setValue("gridFrequencyMonitor.enableEmergencyCharging", checked)
                    }
                    data-testid="switch-emergency-charging"
                  />
                </div>
              </div>
            )}
          </div>

          <Separator />

          <Accordion type="single" collapsible className="w-full">
            <AccordionItem value="e3dc-config" className="border-none">
              <div className="flex items-center justify-between">
                <Label className="text-sm font-medium">
                  Konfiguration e3dcset
                </Label>
                <AccordionTrigger className="hover:no-underline p-0 h-auto" />
              </div>

              <AccordionContent>
                <div className="space-y-4 pt-2">
                  <div className="p-3 rounded-md bg-muted">
                    <p className="text-xs text-muted-foreground">
                      <strong>Hinweis:</strong> Der Prefix wird
                      automatisch vor jeden Parameter gesetzt. Geben Sie
                      in den folgenden Feldern nur die spezifischen
                      Parameter ein (z.B. "-d 1").
                    </p>
                  </div>

                  <div className="space-y-2">
                    <Label
                      htmlFor="e3dc-prefix"
                      className="text-sm font-medium"
                    >
                      CLI-Tool & Konfiguration (Prefix)
                    </Label>
                    <Input
                      id="e3dc-prefix"
                      type="text"
                      placeholder="/opt/keba-wallbox/e3dcset -p /opt/keba-wallbox/e3dcset.config"
                      {...form.register("e3dc.prefix")}
                      className="h-12 font-mono text-sm"
                      data-testid="input-e3dc-prefix"
                    />
                    <p className="text-xs text-muted-foreground">
                      Gemeinsamer Teil aller Befehle (Pfad zum Tool +
                      Konfigurationsdatei)
                    </p>
                  </div>

                  <div className="space-y-2">
                    <Label
                      htmlFor="e3dc-discharge-lock-enable"
                      className="text-sm font-medium"
                    >
                      Entladesperre aktivieren (Parameter)
                    </Label>
                    <Input
                      id="e3dc-discharge-lock-enable"
                      type="text"
                      placeholder="-d 1"
                      {...form.register(
                        "e3dc.dischargeLockEnableCommand",
                      )}
                      className="h-12 font-mono text-sm"
                      data-testid="input-e3dc-discharge-lock-enable"
                    />
                    <p className="text-xs text-muted-foreground">
                      Parameter zum Aktivieren der Entladesperre
                    </p>
                  </div>

                  <div className="space-y-2">
                    <Label
                      htmlFor="e3dc-discharge-lock-disable"
                      className="text-sm font-medium"
                    >
                      Entladesperre deaktivieren (Parameter)
                    </Label>
                    <Input
                      id="e3dc-discharge-lock-disable"
                      type="text"
                      placeholder="-a"
                      {...form.register(
                        "e3dc.dischargeLockDisableCommand",
                      )}
                      className="h-12 font-mono text-sm"
                      data-testid="input-e3dc-discharge-lock-disable"
                    />
                    <p className="text-xs text-muted-foreground">
                      Parameter zum Deaktivieren der Entladesperre
                    </p>
                  </div>

                  <Separator />

                  <div className="space-y-4">
                    <div className="space-y-2">
                      <Label
                        htmlFor="e3dc-grid-charge-enable"
                        className="text-sm font-medium"
                      >
                        Netzstrom-Laden aktivieren (Parameter)
                      </Label>
                      <Input
                        id="e3dc-grid-charge-enable"
                        type="text"
                        placeholder="-c 2500 -e 6000"
                        {...form.register(
                          "e3dc.gridChargeEnableCommand",
                        )}
                        className="h-12 font-mono text-sm"
                        data-testid="input-e3dc-grid-charge-enable"
                      />
                      <p className="text-xs text-muted-foreground">
                        Parameter zum Aktivieren des Netzstrom-Ladens
                      </p>
                    </div>

                    <div className="space-y-2">
                      <Label
                        htmlFor="e3dc-grid-charge-disable"
                        className="text-sm font-medium"
                      >
                        Netzstrom-Laden deaktivieren (Parameter)
                      </Label>
                      <Input
                        id="e3dc-grid-charge-disable"
                        type="text"
                        placeholder="-e 0"
                        {...form.register(
                          "e3dc.gridChargeDisableCommand",
                        )}
                        className="h-12 font-mono text-sm"
                        data-testid="input-e3dc-grid-charge-disable"
                      />
                      <p className="text-xs text-muted-foreground">
                        Parameter zum Deaktivieren des Netzstrom-Ladens
                      </p>
                    </div>
                  </div>

                  <Separator />

                  <div className="space-y-2">
                    <Label
                      htmlFor="e3dc-modbus-pause"
                      className="text-sm font-medium"
                    >
                      Modbus-Pause vor/nach e3dcset
                    </Label>
                    <Input
                      id="e3dc-modbus-pause"
                      type="number"
                      min="0"
                      max="30"
                      step="1"
                      placeholder="3"
                      {...form.register("e3dc.modbusPauseSeconds", {
                        valueAsNumber: true,
                      })}
                      className="h-12"
                      data-testid="input-e3dc-modbus-pause"
                    />
                    <p className="text-xs text-muted-foreground">
                      Wartezeit in Sekunden vor und nach jedem e3dcset-Befehl.
                      Die Modbus-Verbindung wird währenddessen getrennt, um
                      Konflikte zu vermeiden (0-30 Sekunden, Standard: 3).
                    </p>
                  </div>

                  <div className="p-3 rounded-md bg-muted">
                    <p className="text-xs text-muted-foreground">
                      <strong>Hinweis:</strong> Die E3DC-Integration
                      steuert die Batterie-Entladesperre und das
                      Netzstrom-Laden direkt über das e3dcset CLI-Tool.
                      Stellen Sie sicher, dass die entsprechenden
                      Befehle korrekt konfiguriert sind.
                    </p>
                  </div>
                </div>
              </AccordionContent>
            </AccordionItem>
          </Accordion>
        </>
      )}
    </div>
  );
}

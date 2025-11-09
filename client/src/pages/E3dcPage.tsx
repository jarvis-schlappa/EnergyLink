import { useQuery } from "@tanstack/react-query";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Battery, Zap, TrendingUp, TrendingDown, Lock, Unlock } from "lucide-react";
import type { E3dcBatteryStatus } from "@shared/schema";

export default function E3dcPage() {
  const { data: batteryStatus, isLoading, error } = useQuery<E3dcBatteryStatus>({
    queryKey: ["/api/e3dc/battery"],
    refetchInterval: 5000,
    retry: false,
  });

  if (error) {
    return (
      <div className="flex-1 overflow-y-auto pb-20 px-4 pt-6">
        <Card className="border-destructive">
          <CardHeader>
            <CardTitle className="text-destructive">E3DC nicht verbunden</CardTitle>
            <CardDescription>
              Die Verbindung zum E3DC-System konnte nicht hergestellt werden. 
              Bitte prüfen Sie die E3DC-Einstellungen.
            </CardDescription>
          </CardHeader>
        </Card>
      </div>
    );
  }

  if (isLoading || !batteryStatus) {
    return (
      <div className="flex-1 overflow-y-auto pb-20 px-4 pt-6">
        <Card>
          <CardHeader>
            <CardTitle>E3DC Batterie</CardTitle>
            <CardDescription>Lade Batteriestatus...</CardDescription>
          </CardHeader>
        </Card>
      </div>
    );
  }

  const isPowerPositive = batteryStatus.power > 0;
  const powerAbs = Math.abs(batteryStatus.power);

  return (
    <div className="flex-1 overflow-y-auto pb-20 px-4 pt-6">
      <div className="max-w-2xl mx-auto space-y-4">
        <div>
          <h1 className="text-2xl font-bold mb-1" data-testid="text-page-title">
            E3DC Batterie
          </h1>
          <p className="text-sm text-muted-foreground">
            Batteriestatus und Ladeleistung
          </p>
        </div>

        <Card data-testid="card-battery-soc">
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Batterieladezustand</CardTitle>
            <Battery className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold" data-testid="text-battery-soc">
              {batteryStatus.soc.toFixed(1)}%
            </div>
            <div className="mt-2 h-2 bg-muted rounded-full overflow-hidden">
              <div
                className="h-full bg-primary transition-all duration-500"
                style={{ width: `${batteryStatus.soc}%` }}
              />
            </div>
          </CardContent>
        </Card>

        <Card data-testid="card-battery-power">
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Aktuelle Leistung</CardTitle>
            {isPowerPositive ? (
              <TrendingUp className="h-4 w-4 text-green-500" />
            ) : (
              <TrendingDown className="h-4 w-4 text-blue-500" />
            )}
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold" data-testid="text-battery-power">
              {powerAbs.toFixed(0)} W
            </div>
            <p className="text-xs text-muted-foreground mt-1">
              {isPowerPositive ? "Entladung" : "Ladung"}
            </p>
          </CardContent>
        </Card>

        <div className="grid grid-cols-2 gap-4">
          <Card data-testid="card-max-charge">
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
              <CardTitle className="text-sm font-medium">Max. Ladeleistung</CardTitle>
              <Zap className="h-4 w-4 text-muted-foreground" />
            </CardHeader>
            <CardContent>
              <div className="text-xl font-bold" data-testid="text-max-charge-power">
                {batteryStatus.maxChargePower.toFixed(0)} W
              </div>
            </CardContent>
          </Card>

          <Card data-testid="card-max-discharge">
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
              <CardTitle className="text-sm font-medium">Max. Entladeleistung</CardTitle>
              <Zap className="h-4 w-4 text-muted-foreground" />
            </CardHeader>
            <CardContent>
              <div className="text-xl font-bold" data-testid="text-max-discharge-power">
                {batteryStatus.maxDischargePower.toFixed(0)} W
              </div>
            </CardContent>
          </Card>
        </div>

        <Card data-testid="card-discharge-lock">
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Entladesperre</CardTitle>
            {batteryStatus.dischargeLocked ? (
              <Lock className="h-4 w-4 text-destructive" />
            ) : (
              <Unlock className="h-4 w-4 text-green-500" />
            )}
          </CardHeader>
          <CardContent>
            <div
              className={`text-lg font-medium ${
                batteryStatus.dischargeLocked ? "text-destructive" : "text-green-500"
              }`}
              data-testid="text-discharge-lock-status"
            >
              {batteryStatus.dischargeLocked ? "Gesperrt" : "Freigegeben"}
            </div>
            <p className="text-xs text-muted-foreground mt-1">
              {batteryStatus.dischargeLocked
                ? "Batterie wird nicht entladen"
                : "Batterie kann normal entladen werden"}
            </p>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

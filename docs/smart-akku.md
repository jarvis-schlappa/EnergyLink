# Smart-Akku (Smart Buffer)

Smart-Akku ist eine intelligente E3DC-Akku-Steuerung in EnergyLink.  
Ziel: PV-Abregelverluste vermeiden und den Hausakku bis zum Abend gezielt füllen, ohne ihn den ganzen Tag auf 100% zu halten.

## Was ist Smart-Akku?

Der Modus kombiniert zwei Aufgaben:

- **Abregelschutz:** Bei hoher Einspeisung wird die Akku-Ladeleistung erhöht, damit PV-Leistung nicht verloren geht.
- **Abendziel-SOC:** Über den Tag wird die Ladeleistung so gesteuert, dass der gewünschte SOC zum Regelzeit-Ende erreicht wird.

Wichtig: Smart-Akku lädt **nicht aus dem Netz**. Bei Netzbezug wird die Soll-Ladeleistung auf `0 W` gesetzt.

## Die 4 Phasen

Smart-Akku läuft als Zustandsmaschine mit vier Phasen:

1. **Puffer halten (`MORNING_HOLD`)**  
   Morgens wird der Akku bewusst nicht auf 100% gezogen. Das hält Reserve für späteren PV-Überschuss.
2. **Abregelschutz aktiv (`CLIPPING_GUARD`)**  
   Bei hoher Einspeisung (über `clippingGuardEntryWatt`) lädt der Akku aktiv gegen Abregelung.
3. **Akku auffüllen (`FILL_UP`)**  
   Wenn der SOC für das Abendziel nicht ausreicht, berechnet EnergyLink eine dynamische Ziel-Ladeleistung.
4. **Akku voll (`FULL`)**  
   Bei erreichtem Ziel-SOC geht der Akku zurück in Automatik; bei Bedarf kann erneut in andere Phasen gewechselt werden.

## Automatische Anpassung

- **Dynamische Berechnung:** Die Ziel-Ladeleistung wird laufend aus aktuellem SOC, Batteriekapazität und Restzeit berechnet.
- **Selbstkorrigierend:** Bei Wolken/Leistungseinbruch steigt die Soll-Leistung automatisch, solange noch Restzeit vorhanden ist.
- **Open-Meteo Prognose:** Forecast-Daten werden für konkrete Dachflächen geladen und mit Ist-Werten verglichen.
- **Keine Netzladung:** Bei `gridPower > 0` wird Smart-Akku-Ladung unterdrückt.

## Auto-Modus vs. Kein-Auto-Modus

Smart-Akku berücksichtigt, ob das Fahrzeug gerade lädt:

- **Auto-Modus (Fahrzeug lädt):** Der verfügbare PV-Anteil für den Hausakku wird begrenzt, damit Fahrzeugladung und Akku gemeinsam arbeiten.
- **Kein-Auto-Modus (kein Fahrzeugladen):** Das berechnete Fill-Up-Ziel kann vollständig für den Akku genutzt werden (bis `maxBatteryChargePower`).

## PV-Anlage mit 3 Dachflächen

Standardmäßig sind drei Dachflächen hinterlegt:

1. `Wohnhaus SO` (`azimuthDeg: 140`, `tiltDeg: 43`, `kwp: 6.08`)
2. `Wohnhaus NW` (`azimuthDeg: 320`, `tiltDeg: 43`, `kwp: 2.56`)
3. `Gauben SW` (`azimuthDeg: 229`, `tiltDeg: 43`, `kwp: 1.28`)

Diese Flächen werden einzeln prognostiziert und zu einer Gesamtprognose zusammengeführt.

## Sicherheit und Robustheit

- **Crash-Recovery beim Start:** Beim App-Start wird E3DC auf Automatik gesetzt, damit kein altes Lade-Limit hängen bleibt.
- **Strategiewechsel:** Beim Wechsel weg von `smart_buffer` wird Smart-Akku sauber deaktiviert und Automatik wiederhergestellt.
- **Night-Charging-Koexistenz:** Wenn zeitgesteuerte Ladung aktiv ist (`nightCharging=true`), pausiert Smart-Akku automatisch.
- **Fallback bei Event-Ausfall:** Zusätzlich zum Event-Listener existiert ein Fallback-Check bei stale Daten.

## UI: Wo sehe ich Smart-Akku?

- **StatusCard (Wallbox-Seite):** Zeigt Phase, Soll-Ladeleistung und SOC-Ziel.
- **Detail-Drawer:** Zeigt Prognose vs. Ist, Einspeisung und letzte Phasenwechsel.
- **Strategie-Auswahl:** Smart-Akku ist als Strategie `Smart Buffer` im Lade-Drawer auswählbar.

## Wichtige Konfigurationswerte

`settings.smartBuffer` enthält die zentralen Parameter, u.a.:

- `targetSocEvening`
- `maxBatteryChargePower`
- `feedInLimitWatt`
- `clippingGuardEntryWatt`
- `clippingGuardExitWatt`
- `clippingGuardTargetWatt`
- `batteryCapacityKwh`
- `forecastRefreshIntervalMin`

## Weiterführend

- [Ladestrategien](charging-strategies.md) – Überblick über alle Lade-Modi
- [Konfiguration](configuration.md) – Parameter und Settings
- [Architektur](architecture.md) – Technische Struktur

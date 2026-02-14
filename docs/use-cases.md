# Use Cases

Konkrete Anwendungsszenarien von EnergyLink mit Event-Flows.

---

## 1. PV-Überschussladung mit automatischer Stromanpassung

**Szenario:** PV-Überschussladung ist aktiv, die Sonne scheint.

```
E3DC Modbus (1s Polling)
  → PV=5000W, Batterie=90%, Netz=-2000W (Einspeisung)

Charging Strategy Controller (~1ms)
  → Überschuss = 2000W → Zielstrom = 2000W / 230V ≈ 9A
  → Prüft: min. Änderung (1A), min. Intervall (60s)
  → Sendet UDP: "curr 9000"

KEBA Wallbox
  → Passt Ladestrom auf 9A an
  → Sendet Broadcast zurück

Prowl (Fire-and-Forget)
  → Push: "Ladestrom angepasst: 9A (2070W, 1-phasig)"
```

## 2. Nachtladung mit Grid Charging

**Szenario:** Zeitfenster 23:00–06:00, Hausbatterie soll parallel mit Nachtstrom geladen werden.

### Start (23:00)

```
Scheduler (1s Check)
  → Zeitfenster aktiv → Nachtladung starten

E3DC Client
  → Grid Charging aktivieren (e3dcset)
  → Battery Lock aktivieren (verhindert Entladung)

Wallbox
  → Startet mit Maximalstrom (32A 1P oder 16A 3P)
```

### Ende (06:00)

```
Scheduler
  → Zeitfenster beendet → Wallbox stoppen
  → Grid Charging deaktivieren
  → Battery Lock aufheben
```

## 3. Strategie-Wechsel via X1-Kontakt

**Szenario:** Externer Sensor (z.B. Heizstab) an X1. Bei X1=1 → Maximum ohne Batterie.

```
KEBA Wallbox → UDP-Broadcast: {"Input": 1}

Broadcast Listener (<10ms)
  → Input geändert: 0 → 1
  → Settings: inputX1Strategy = "max_without_battery"

Strategy Controller
  → Wechselt Strategie
  → Battery Lock aktivieren
  → Wallbox lädt mit Max. Leistung

--- Bei X1=0: ---
  → Strategie → "off"
  → Battery Lock deaktivieren
  → Wallbox stoppen
```

## 4. Kabel einstecken / ausstecken

```
KEBA Wallbox → Broadcast: {"Plug": 7}  (Auto angeschlossen, verriegelt)

Broadcast Listener (<10ms)
  → Plug-Änderung: 1 → 7

Storage
  → Persistiert Plug-Status mit Zeitstempel

Prowl
  → Push: "Kabel eingesteckt"
```

## 5. Fehlerbehandlung

### Modbus-Verbindung unterbrochen

```
E3DC Modbus Hub → ECONNREFUSED
  → lastE3dcData = null
  → Strategy Controller: Keine Stromanpassung (Schutz)
  → Retry nach 1s → Verbindung wiederhergestellt
```

### CLI-Befehl fehlgeschlagen

```
E3DC Client → Battery Lock → Exit Code 1
  → Rollback: controlState.batteryLock = false
  → Prowl: "Fehler: E3DC-Verbindung fehlgeschlagen"
  → Wallbox lädt trotzdem weiter (Graceful Degradation)
```

---

## Timing-Übersicht

| Operation | Latenz/Intervall |
|-----------|-----------------|
| UDP-Broadcast Empfang | <10ms |
| Strategy Controller Reaktion | ~1ms |
| E3DC Modbus Polling | 1s |
| Min. Stromanpassung | 60s |
| E3DC CLI Rate-Limit | 5s |
| Scheduler Check | 1s |
| FHEM Sync | 10s |

---

## Weiterführend

- [Architektur](architecture.md) – Technischer Aufbau
- [Ladestrategien](charging-strategies.md) – Strategien im Detail
- [Konfiguration](configuration.md) – Parameter anpassen

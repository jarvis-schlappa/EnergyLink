# Garagentor-Integration

EnergyLink kann das Garagentor über FHEM steuern – direkt aus der Wallbox-Oberfläche. Da die Wallbox in der Garage steht, gehört das Öffnen und Schließen zum Lade-Workflow.

## Voraussetzungen

- FHEM-Server mit konfiguriertem `fhemSync.host`
- FHEM-Devices: `garagentor` (Sensor) und `aktor_garagentor` (Taster)
- HTTP-API auf Port 8083 erreichbar

## Funktionen

### Status-Abfrage

```
GET /api/garage/status
```

Liefert den aktuellen Zustand (`open`, `closed`, `unknown`) und den letzten Statuswechsel. Liest `garagentor` über die FHEM HTTP-API (`jsonlist2`).

### Manueller Toggle

```
POST /api/garage/toggle
```

Löst den Garagentor-Taster aus (`set aktor_garagentor on-for-timer 1`). Der Taster ist ein reiner Toggle – er öffnet oder schließt, je nach aktuellem Zustand.

**Cooldown:** 20 Sekunden zwischen manuellen Toggles, verhindert versehentliches Doppelauslösen.

### Auto-Close bei Kabel einstecken

Wenn das Ladekabel eingesteckt wird (Plug wechselt von <5 auf ≥5) und die Garage offen ist, wird das Tor automatisch geschlossen.

**Voraussetzungen:**
- `autoCloseGarageOnPlug` ist in den Einstellungen aktiviert (Standard: aus)
- Garage ist laut FHEM-Sensor tatsächlich `open`
- Kein AutoClose-Cooldown aktiv (60s zwischen Auto-Close-Events)

**Wichtig:** Auto-Close hat einen eigenen Cooldown, getrennt vom manuellen Toggle. Der typische Workflow – Garage manuell öffnen, innerhalb von 60 Sekunden Kabel einstecken – funktioniert korrekt.

## Konfiguration

| Parameter | Beschreibung | Standard |
|-----------|-------------|---------|
| `fhemSync.host` | FHEM-Server IP | — |
| `fhemSync.autoCloseGarageOnPlug` | Auto-Close aktivieren | `false` |

Die Garage-Karte erscheint auf der Wallbox-Seite nur wenn `fhemSync.host` konfiguriert ist.

## FHEM-Devices

| Device | Funktion | Steuerung |
|--------|----------|-----------|
| `aktor_garagentor` | Taster (Toggle) | `set aktor_garagentor on-for-timer 1` |
| `garagentor` | Öffnungssensor | Reading `state` → `open` / `closed` |

**Timing:** Öffnen dauert ~3s, Schließen ~15s bis der Sensor den neuen Zustand meldet.

## API-Endpunkte

| Endpoint | Methode | Beschreibung |
|----------|---------|-------------|
| `/api/garage/status` | GET | Aktuellen Zustand abfragen |
| `/api/garage/toggle` | POST | Taster betätigen (mit Cooldown) |

## Frontend

Die Garage wird als kompakte Karte neben der Kabelverbindung im Side-by-Side-Grid angezeigt:

| Zustand | Farbe | Text |
|---------|-------|------|
| Geschlossen | Grün | "Geschlossen" |
| Offen | Orange | "Offen" |
| Fährt... | Blau (animiert) | "Fährt..." |
| Unbekannt | Grau | "Unbekannt" |

Tap auf die Karte öffnet einen Drawer mit Details und einem Long-Press-Button (2s) zum Auslösen des Tasters.

## Demo-Modus

Im Demo-Modus simuliert der FHEM-Mock das Garagentor:
- Toggle wechselt den Status mit realistischem Delay (3s öffnen, 15s schließen)
- `jsonlist2 garagentor` liefert den simulierten Status
- Auto-Close funktioniert mit dem Mock identisch

## Typischer Workflow

**Mit Auto-Close:**
1. App öffnen → Garage öffnen (Long-Press)
2. Zum Auto gehen, Kabel einstecken → Garage schließt automatisch
3. Laden starten

**Ohne Auto-Close:**
1. App öffnen → Garage öffnen
2. Kabel einstecken → Garage manuell schließen
3. Laden starten

---

## Weiterführend

- [Konfiguration](configuration.md) – Alle Einstellungen
- [Use Cases](use-cases.md) – Weitere Anwendungsszenarien
- [Architektur](architecture.md) – Technischer Aufbau

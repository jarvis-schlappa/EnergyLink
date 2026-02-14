# Konfiguration

Alle Einstellungen werden über die Settings-Seite der App vorgenommen und automatisch in `data/settings.json` gespeichert.

## Wallbox-Einstellungen

| Parameter | Beschreibung | Beispiel |
|-----------|-------------|---------|
| `wallboxIp` | IP-Adresse der KEBA Wallbox | `192.168.40.16` |

Die Wallbox wird über UDP (Port 7090) angesprochen. Sie muss im gleichen Netzwerk wie der EnergyLink-Server erreichbar sein.

## E3DC S10 Integration

| Parameter | Beschreibung | Beispiel |
|-----------|-------------|---------|
| `e3dcEnabled` | E3DC-Integration aktivieren | `true` |
| `e3dcIp` | IP:Port des E3DC (Modbus TCP) | `192.168.40.50:502` |
| `e3dcCliPath` | Pfad zum e3dcset CLI-Tool | `/opt/e3dcset` |

### Modbus TCP

Muss am E3DC S10 aktiviert sein (Standard-Port 502). Ermöglicht Live-Monitoring von:
- PV-Produktion, Batterie-SOC, Hausverbrauch, Netzfluss

### CLI-Tool (e3dcset)

Optionales Tool für erweiterte Steuerung (Batteriesperrung, Netzladung):
- Download: [mschlappa/e3dcset](https://github.com/mschlappa/e3dcset)
- Erfordert eigene Konfiguration (`/etc/e3dcset.config`)

## FHEM-Integration

| Parameter | Beschreibung | Beispiel |
|-----------|-------------|---------|
| `fhemIp` | FHEM-Server IP | `192.168.40.11` |
| `fhemPort` | FHEM Telnet-Port | `7072` |

EnergyLink sendet alle 10 Sekunden E3DC-Livedaten (PV, Haus, SOC, Netz, Speicher) per TCP an FHEM.

## Strategie-Parameter

Feinjustierung für die Überschuss-Strategien (siehe [Ladestrategien](charging-strategies.md)):

| Parameter | Bereich | Standard | Beschreibung |
|-----------|---------|----------|-------------|
| Mindest-Startleistung | 500–5000 W | 1380 W | PV-Überschuss zum Starten der Ladung |
| Stopp-Schwellwert | 300–3000 W | 500 W | Unterschreitung stoppt die Ladung |
| Start-Verzögerung | 30–600 s | 30 s | Wartezeit vor Ladestart |
| Stopp-Verzögerung | 60–900 s | 120 s | Wartezeit vor Ladestopp |
| Mindest-Stromänderung | 0–5 A | 1 A | Minimale Differenz für Anpassung |
| Mindest-Änderungsintervall | 10–180 s | 60 s | Abstand zwischen Stromanpassungen |

## Zeitgesteuerte Ladung

| Parameter | Beschreibung | Beispiel |
|-----------|-------------|---------|
| `scheduledStart` | Startzeit | `00:00` |
| `scheduledEnd` | Endzeit | `05:00` |
| `scheduledEnabled` | Aktiviert | `true` |

Lädt automatisch im Zeitfenster mit Maximalstrom. Ideal für günstige Nachtstromtarife.

## Potenzialfreier Kontakt (X1)

| Parameter | Beschreibung | Optionen |
|-----------|-------------|---------|
| `inputX1Strategy` | Strategie bei X1=1 | Alle 4 Strategien + „Aus" |

Ermöglicht externen SmartHome-Systemen, die Ladestrategie über den X1-Kontakt der Wallbox zu steuern.

## Demo-Modus

| Parameter | Beschreibung |
|-----------|-------------|
| `demoMode` | Aktiviert den Unified Mock Server |
| `DEMO_AUTOSTART` | Env-Variable: Auto-Start im Deployment |
| `mockWallboxPhases` | Simulierte Phasenzahl (1 oder 3) |

Der Demo-Modus simuliert KEBA Wallbox, E3DC S10 und FHEM mit realistischen, tageszeitabhängigen Daten.

## Prowl-Benachrichtigungen

| Parameter | Beschreibung |
|-----------|-------------|
| `prowlApiKey` | API-Key für Prowl Push-Service |
| `prowlEvents.*` | Einzelne Events aktivieren/deaktivieren |

Events: Ladestart/-stopp, Kabel ein-/ausstecken, Strategiewechsel, Fehler.

---

## Weiterführend

- [Getting Started](getting-started.md) – Installation
- [Ladestrategien](charging-strategies.md) – Strategien im Detail
- [Architektur](architecture.md) – Technischer Aufbau

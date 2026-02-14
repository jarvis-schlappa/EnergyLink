# Häufige Fragen (FAQ)

## Wallbox & Verbindung

**Warum wird kein Wallbox-Status angezeigt?**
- Prüfen Sie, ob Server und Wallbox im gleichen Netzwerk sind
- Überprüfen Sie die IP-Adresse in den Einstellungen
- Starten Sie die App neu

**Kann ich die App unterwegs nutzen?**
- Die lokale Installation ist für das Heimnetzwerk konzipiert
- Für Fernzugriff: VPN oder sichere Reverse-Proxy-Lösung verwenden
- Die Live-Demo ist von überall erreichbar

## E3DC-Integration

**Warum werden keine E3DC-Daten angezeigt?**
- E3DC-Integration in den Einstellungen aktivieren
- IP-Adresse im Format `IP:Port` prüfen (z.B. `192.168.40.50:502`)
- Modbus TCP muss am E3DC S10 aktiviert sein
- Die E3DC-Seite erscheint erst nach Aktivierung

## Ladestrategien

**Welche Strategie soll ich wählen?**
- **Überschuss (Batterie prio):** Maximale Eigenverbrauchsoptimierung
- **Überschuss (Fahrzeug prio):** Ausgewogenes Laden von Auto + Batterie
- **Maximum (mit Batterie):** Auto muss schnell voll sein, Batterie-Entladung OK
- **Maximum (ohne Batterie):** Schnell laden, Batterie schonen

**Kann ich die Strategie während des Ladens wechseln?**
Ja! On-the-fly-Wechsel wird unterstützt. Die Ladung wird nicht unterbrochen, der Ladestrom wird innerhalb von 15 Sekunden angepasst.

**Warum startet die Überschuss-Ladung nicht?**
- Genug PV-Überschuss vorhanden? (mindestens die konfigurierte Mindest-Startleistung)
- Start-Verzögerung beachten (Standard: 30s)
- Bei „Batterie prio": Hausbatterie muss erst gesättigt sein
- Schwellwerte in den Strategie-Parametern prüfen

## Demo-Modus

**Wie funktioniert die Demo?**
- Eingebauter Mock-Server simuliert KEBA Wallbox, E3DC S10 und FHEM
- Realistische Daten: tageszeitabhängige PV-Produktion, saisonale Variation
- Alle Strategien voll nutzbar, keine echte Hardware nötig
- Plug-Status kann manuell über die Einstellungen geändert werden

## Diagnose

**Wo finde ich Fehlerprotokolle?**
Auf der Logs-Seite (Listen-Symbol) – zeigt alle Kommunikationsdetails mit der Wallbox.

**Wie werden externe Änderungen erkannt?**
Wallbox- und E3DC-Daten werden alle 5 Sekunden automatisch aktualisiert.

---

## Weiterführend

- [Getting Started](getting-started.md) – Installation
- [Konfiguration](configuration.md) – Alle Einstellungen
- [Ladestrategien](charging-strategies.md) – Strategien im Detail

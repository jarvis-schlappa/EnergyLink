# Settings-Seite Redesign – Spezifikation

**Status:** Konzept abgeschlossen, noch nicht implementiert  
**Datum:** 2026-02-26  
**Mock:** [`docs/mock/settings-mock-v2.html`](mock/settings-mock-v2.html)  
**Offene Issues:** #16 (pvSurplusUrls Cleanup), #17 (modbusPauseSeconds entfernen), #18 (Demo-Toggle Bug)

---

## Zusammenfassung

Die bisherige Settings-Seite ist eine lange vertikale Scrollseite mit allen Einstellungen untereinander. Das Redesign teilt sie in **4 Tabs** auf mit **Tab-spezifischem Speichern** und verbesserter Informationsarchitektur.

---

## Design-Entscheidungen

### Tab-Struktur: 4 Tabs

| Tab | Icon (Lucide) | Inhalt |
|-----|---------------|--------|
| **⚡ Wallbox** | `PlugZap` | Verbindung, Ladestrategie, Feintuning |
| **🏠 E3DC** | `Home` | Integration, Verbindung, Netzfrequenz, e3dcset-Config |
| **>_ FHEM** | `Terminal` | Sync, Verbindung, Garage Auto-Close |
| **⚙️ System** | `Settings` | Demo-Modus, Prowl-Benachrichtigungen, Build-Info |

**Warum 4 statt 5:** "Meldungen" (Prowl) ist eine Querschnittsfunktion, kein eigenständiger Bereich. Als Section im System-Tab funktioniert es genauso gut. 4 Tabs passen auf allen Mobilgeräten ohne Scrolling.

### Save-Strategie: Hybrid

- **Toggles/Switches** → sofort speichern (wie bisher beim Demo-Toggle)
- **Textfelder/Zahlen** → Save-Button pro Tab, nur sichtbar bei Änderungen (Dirty-State)
- **Dirty-Indicator** → orangener Punkt am Tab-Label bei ungespeicherten Änderungen
- **Tab-Wechsel-Guard** → Dialog "Ungespeicherte Änderungen verwerfen?" bei Dirty-State

### Demo-Badge

- Badge "Demo" rechts oben neben dem Seitentitel (wie im Original PageHeader)
- Sichtbar wenn Demo-Modus aktiv

### Prowl-Event-Gruppen: 3 statt flache Liste

| Gruppe | Events |
|--------|--------|
| **⚡ Laden & Verbindung** | Ladung gestartet, gestoppt, Strom angepasst, Auto an-/abgesteckt |
| **🔋 Batterie & Netz** | Entladesperre an/aus, Batterie-Netzladung an/aus, Frequenz Warnung, Frequenz Kritisch |
| **⚙️ System & Fehler** | Strategie gewechselt, App gestartet, Fehler aufgetreten |

### Verbesserte Labels

| Alt | Neu |
|-----|-----|
| Tier 2 Schwelle | Warnschwelle |
| Tier 3 Schwelle | Alarmschwelle |
| Mindest-Stromänderung | Mindest-Regelschritt |
| Netzstrom-Laden | Batterie-Netzladung |
| Modbus-Pause | *(entfällt, siehe Issue #17)* |

### Netzfrequenz Default-Wert

- Warnschwelle: **0.15 Hz** (vorher 0.10 Hz – war zu empfindlich, triggert täglich)
- Alarmschwelle: **0.20 Hz** (unverändert)
- Hint: "Abweichungen bis 0,10 Hz sind im Normalbetrieb häufig."

### Cross-Tab-Hinweise

Blaue Info-Boxen die auf Abhängigkeiten zu anderen Tabs verweisen:
- FHEM-Tab: "🔋 Erfordert aktivierte E3DC-Integration → Tab E3DC"
- E3DC Netzfrequenz: "⚙️ Benachrichtigungen für Frequenz-Events → Tab System"

---

## Tab-Struktur im Detail

### Tab 1: ⚡ Wallbox

```
Card: Verbindung
  └── IP-Adresse Wallbox [text] — "KEBA P20 im lokalen Netzwerk"

Card: Standard-Ladestrategie
  └── Select: Aus / PV-Überschuss (Batterie-Prio) / PV-Überschuss (Fahrzeug-Prio) /
               Max Power (mit Batterie) / Max Power (ohne Batterie)
      Hint: "Wird aktiviert bei 'Laden starten' und bei geschlossenem X1-Kontakt"

Card: Feintuning [Collapsible, default: geschlossen]
  ├── Mindest-Startleistung (W) [number, 500-5000, default: 1400]
  ├── Stopp-Schwellwert (W) [number, 300-3000, default: 1000]
  ├── Start-Verzögerung (s) [number, 30-600, default: 120]
  ├── Stopp-Verzögerung (s) [number, 60-900, default: 300]
  ├── Mindest-Regelschritt (A) [number, 0.1-5, default: 1]
  └── Regelintervall (s) [number, 10-300, default: 60]

Button: "Wallbox-Einstellungen speichern" [nur bei Dirty-State]
```

### Tab 2: 🏠 E3DC

```
Card: E3DC-Integration
  └── Toggle: Aktiviert [switch, sofort speichern]

── Alles darunter nur sichtbar wenn E3DC aktiviert ──

Card: Verbindung
  ├── IP-Adresse Hauskraftwerk [text] — "E3DC S10 – Modbus TCP (Port 502)"
  └── Polling-Intervall (s) [number, 5-60, default: 10]

Card: Netzfrequenz-Überwachung
  ├── Toggle: Aktiviert [switch, sofort speichern]
  ├── ── nur sichtbar wenn aktiviert: ──
  ├── Warnschwelle (Hz) [number, 0.01-0.5, default: 0.15]
  ├── Alarmschwelle (Hz) [number, 0.1-1.0, default: 0.20]
  ├── Toggle: Notladung aktivieren [switch]
  └── Cross-Ref: "⚙️ Benachrichtigungen → Tab System"

Card: e3dcset Konfiguration [Collapsible, default: geschlossen]
  ├── CLI-Tool & Config (Prefix) [text, mono]
  ├── Entladesperre aktivieren [text, mono]
  ├── Entladesperre deaktivieren [text, mono]
  ├── Batterie-Netzladung aktivieren [text, mono]
  └── Batterie-Netzladung deaktivieren [text, mono]

Button: "E3DC-Einstellungen speichern" [nur bei Dirty-State]
```

### Tab 3: >_ FHEM

```
Card: FHEM E3DC Sync
  └── Toggle: Aktiviert [switch, sofort speichern]

── Alles darunter nur sichtbar wenn FHEM aktiviert ──

Cross-Ref: "🔋 Erfordert aktivierte E3DC-Integration → Tab E3DC"

Card: Verbindung
  ├── FHEM Server IP [text, placeholder statt default]
  └── Telnet Port [number, default: 7072]

Card: Garage Auto-Close
  └── Toggle: Aktiviert [switch, sofort speichern]
      Hint: "Garagentor schließen wenn Kabel eingesteckt wird (aktor_garagentor)"

Info-Box: Übertragene Werte (sonne, haus, soc, netz, speicher)

Button: "FHEM-Einstellungen speichern" [nur bei Dirty-State]
```

### Tab 4: ⚙️ System

```
Card: Demo-Modus [highlight background]
  ├── Toggle: Demo-Modus [switch, sofort speichern]
  ├── ── nur sichtbar wenn aktiviert: ──
  ├── Phasenanzahl [select: 1P / 3P]
  ├── Potenzialfreier Kontakt X1 [switch]
  ├── Kabel-Status [select: 0-7]
  └── Simulierte Tageszeit [switch + datetime]

── Separator ──

Card: Push-Benachrichtigungen (Prowl)
  ├── Toggle: Aktiviert [switch, sofort speichern]
  ├── API Key [password]
  ├── Ereignis-Benachrichtigungen (3 Gruppen, siehe oben)
  └── Button: "Test-Benachrichtigung senden"

Card: Build-Info
  └── Version, Build-Datum (statisch)

Button: "System-Einstellungen speichern" [nur bei Dirty-State]
```

---

## Was NICHT in Settings gehört

Diese Einstellungen werden bewusst über ihre jeweilige Seite gesteuert, nicht über die Settings:

| Setting | Wo stattdessen | Schema-Feld |
|---------|---------------|-------------|
| Nachtlade-Zeitfenster | Wallbox-Seite (Drawer) | `nightChargingSchedule` |
| Batterie-Netzladung bei Nachtladung | E3DC-Seite (BatteryControlDrawer) | `e3dc.gridChargeDuringNightCharging` |
| Phasenumschalter | Nur im Demo-Modus relevant | `mockWallboxPhases` |
| Aktive Ladestrategie | Wallbox-Seite (Statusbereich) | `chargingStrategy.activeStrategy` |

---

## Offene Issues (vor Implementierung klären)

| Issue | Thema | Auswirkung auf Settings |
|-------|-------|------------------------|
| [#16](https://github.com/mschlappa/EnergyLink/issues/16) | pvSurplusOnUrl/OffUrl – noch benötigt? | Falls entfernt: weniger Cleanup beim Demo-Toggle |
| [#17](https://github.com/mschlappa/EnergyLink/issues/17) | modbusPauseSeconds komplett entfernen | Feld entfällt aus Schema + UI |
| [#18](https://github.com/mschlappa/EnergyLink/issues/18) | Demo-Toggle zeigt weiterhin Realdaten | Muss gefixt werden damit Demo-Toggle im System-Tab funktioniert |

---

## Technische Hinweise für die Implementierung

### Bestehende Komponenten-Struktur beibehalten
Die Sections sind bereits als separate Komponenten in `client/src/components/settings/` angelegt. Diese können weitgehend wiederverwendet werden – sie müssen nur in Tab-Panels statt untereinander gerendert werden.

### Farben / Design-System
Light Mode verwenden (`:root`-Variablen aus `client/src/index.css`). Kein Dark Mode für den Mock.

### App-Logo
Original `apple-touch-icon.png` oben links neben "Einstellungen", Demo-Badge rechts daneben (wie im bestehenden `PageHeader`-Pattern).

### Tab-Komponente
Empfohlen: Radix UI Tabs (`@radix-ui/react-tabs`) – ist konsistent mit den anderen Radix-Komponenten im Projekt.

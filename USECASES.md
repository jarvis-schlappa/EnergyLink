# EnergyLink Use Cases

Diese Dokumentation beschreibt konkrete Anwendungsfälle von EnergyLink und zeigt, wie die technischen Komponenten in realen Szenarien zusammenspielen.

## Architektur-Übersicht

### Zentrale Komponenten

| Komponente | Beschreibung | Latenz |
|------------|--------------|--------|
| **Charging Strategy Controller** | Event-driven Controller für intelligente Ladesteuerung | ~1ms Event-Loop |
| **Wallbox Broadcast Listener** | Verarbeitet UDP-Broadcasts der KEBA Wallbox | <10ms |
| **E3DC Client** | CLI-Tools + Modbus TCP für E3DC S10 Integration | <5s Rate-Limit |
| **Prowl Notifier** | Fire-and-Forget Push-Benachrichtigungen | Async, non-blocking |
| **E3DC Modbus Hub** | Live-Daten (PV, Batterie, Netz) via Modbus TCP | 1s Polling |
| **Storage Layer** | JSON-basierte Persistenz für State und Settings | <1ms |
| **Unified Mock Server** | Simuliert KEBA, E3DC, FHEM im Demo-Modus | - |

---

## Use Case 1: PV-Überschussladung mit automatischer Stromanpassung

### Szenario
Ein Benutzer hat PV-Überschussladung aktiviert. Die Sonne scheint, und das Auto soll mit überschüssigem Solarstrom geladen werden. Der Controller passt den Ladestrom automatisch an die verfügbare PV-Leistung an.

### Beteiligte Komponenten
- **E3DC Modbus Hub** (Live-Daten Polling)
- **Charging Strategy Controller** (Ladelogik)
- **Wallbox UDP Channel** (Strombefehle senden)
- **Prowl Notifier** (Benachrichtigungen)
- **Storage Layer** (Context & Settings)

### Event-Flow

```
1. E3DC Modbus Hub (1s Polling)
   └─> Liest Live-Daten: PV=5000W, Batterie=90%, Netz=-2000W (Einspeisung)
   
2. E3DC Modbus Hub
   └─> Publish an Subscriber (Strategy Controller)
   
3. Charging Strategy Controller (Event-Handler, ~1ms)
   ├─> Empfängt E3DC Live-Daten
   ├─> Berechnet verfügbare Leistung: PV_surplus = -2000W (Einspeisung)
   ├─> Strategie: "pv_surplus" (1-phasig, 6-32A)
   ├─> Berechnet Ziel-Strom: 2000W / 230V = 8.7A → 9A
   ├─> Prüft min. Änderung (1A) und min. Intervall (60s)
   └─> Entscheidung: Strom anpassen (9A → Wallbox)
   
4. Charging Strategy Controller
   └─> Sendet UDP-Befehl: "curr 9000" (9A * 1000)
   
5. Wallbox UDP Channel
   └─> Sendet Befehl an KEBA Wallbox (192.168.40.16:7090)
   
6. KEBA Wallbox
   ├─> Empfängt Befehl
   ├─> Passt Ladestrom an: 9A
   └─> Sendet Broadcast zurück (State, E pres, etc.)
   
7. Prowl Notifier (Fire-and-Forget)
   └─> Sendet Push: "Ladestrom angepasst: 9A (2070W, 1-phasig)"
```

### Timing & Besonderheiten

- **1s Event-Loop**: Strategy Controller reagiert innerhalb von ~1ms auf neue E3DC-Daten
- **60s min. Intervall**: Verhindert zu häufige Stromanpassungen (Wallbox-Schutz)
- **1A min. Änderung**: Ignoriert kleine Schwankungen
- **Fire-and-Forget**: Prowl-Benachrichtigungen blockieren nie die Ladesteuerung
- **Graceful Shutdown**: Bei App-Neustart werden pending Events abgearbeitet

---

## Use Case 2: Nachtladung mit Grid Charging

### Szenario
Der Benutzer plant eine Fahrt am nächsten Morgen und aktiviert die zeitgesteuerte Nachtladung (23:00-06:00 Uhr). Die Hausbatterie soll während der Ladung mit günstigem Nachtstrom geladen werden.

### Beteiligte Komponenten
- **Night Charging Scheduler** (1s Intervall)
- **E3DC Client** (CLI-Tools für Grid Charging)
- **Charging Strategy Controller** (Wallbox-Steuerung)
- **Storage Layer** (Control State & Settings)
- **Prowl Notifier** (Benachrichtigungen)

### Event-Flow: Start (23:00 Uhr)

```
1. Night Charging Scheduler (1s Check)
   ├─> Aktuelle Zeit: 23:00:00 (Europe/Berlin)
   ├─> Schedule: 23:00-06:00, enabled=true
   └─> Entscheidung: Nachtladung starten
   
2. Night Charging Scheduler
   ├─> Prüft E3DC-Config: gridChargeDuringNightCharging=true
   └─> Entscheidung: Grid Charging aktivieren
   
3. E3DC Client (CLI Tool)
   ├─> Befehl: "e3dcset -m set -t gridcharge -v 1"
   ├─> Rate-Limit: 5s seit letztem Befehl
   ├─> Timeout: 30s
   └─> Erfolg: Hausbatterie lädt aus dem Netz
   
4. Prowl Notifier (Fire-and-Forget)
   └─> Sendet Push: "Netzstrom-Laden aktiviert"
   
5. Storage Layer
   ├─> Speichert: controlState.gridCharging = true
   └─> Speichert: controlState.nightCharging = true
   
6. Charging Strategy Controller
   ├─> Strategie: "max_without_battery"
   ├─> Battery Lock aktivieren (verhindert Batterie-Entladung)
   └─> Startet Wallbox mit Max. Leistung (1-phasig, 32A oder 3-phasig, 16A)
   
7. E3DC Client (Battery Lock)
   ├─> Befehl: "e3dcset -m set -t dischargelock -v 1"
   └─> Erfolg: Batterie ist gesperrt
   
8. Prowl Notifier (Fire-and-Forget)
   ├─> Sendet Push: "Batterie-Sperre aktiviert"
   └─> Sendet Push: "Ladung gestartet: 32A (7360W, 1-phasig, Max ohne Batterie)"
   
9. Charging Strategy Controller
   └─> Setzt Context: isActive=true, strategy="max_without_battery"
```

### Event-Flow: Ende (06:00 Uhr)

```
1. Night Charging Scheduler (1s Check)
   ├─> Aktuelle Zeit: 06:00:00 (Europe/Berlin)
   └─> Entscheidung: Nachtladung beenden
   
2. Charging Strategy Controller
   ├─> Sendet UDP-Befehl: "ena 0" (Wallbox stoppen)
   └─> Sendet Prowl: "Ladung gestoppt: Zeitfenster beendet"
   
3. E3DC Client (Grid Charging deaktivieren)
   ├─> Befehl: "e3dcset -m set -t gridcharge -v 0"
   └─> Erfolg: Hausbatterie lädt nicht mehr aus dem Netz
   
4. Prowl Notifier (Fire-and-Forget)
   └─> Sendet Push: "Netzstrom-Laden deaktiviert"
   
5. Storage Layer
   └─> Speichert: controlState.gridCharging = false, nightCharging = false
```

### Timing & Besonderheiten

- **1s Scheduler**: Prüft jede Sekunde ob Zeitfenster aktiv ist
- **5s Rate-Limit**: E3DC CLI-Befehle haben min. 5s Abstand
- **Race Condition Prevention**: `controlState.gridCharging` wird **vor** `await` gesetzt
- **Atomic Updates**: Nur geänderte Felder werden gespeichert
- **Idempotenz**: Scheduler startet/stoppt nur wenn nötig (verhindert redundante Logs)

---

## Use Case 3: Strategie-Wechsel via potenzialfreien Kontakt (X1)

### Szenario
Der Benutzer hat einen Stromsensor (z.B. für Heizstab-Nutzung) an den potenzialfreien Kontakt X1 der Wallbox angeschlossen. Wenn der Heizstab aktiv ist (Input=1), soll die Wallbox auf "Max Power without Battery" umschalten, um die Batterie zu schonen.

### Beteiligte Komponenten
- **Wallbox Broadcast Listener** (UDP-Broadcasts)
- **Charging Strategy Controller** (Strategie-Wechsel)
- **E3DC Client** (Battery Lock)
- **Prowl Notifier** (Benachrichtigungen)
- **Storage Layer** (Settings & Context)

### Event-Flow: Input X1 = 1 (Heizstab aktiviert)

```
1. KEBA Wallbox (Hardware)
   ├─> Heizstab aktiviert → Input X1 = 1
   └─> Sendet UDP-Broadcast: {"Input": 1, ...}
   
2. Wallbox Broadcast Listener (<10ms)
   ├─> Empfängt Broadcast von 192.168.40.16:7090
   ├─> Erkennt: Input-Status geändert (0 → 1)
   └─> Log: "Input X1 aktiviert (0 → 1)"
   
3. Wallbox Broadcast Listener
   ├─> Liest Settings: inputX1Strategy = "max_without_battery"
   └─> Entscheidung: Strategie wechseln
   
4. Charging Strategy Controller
   ├─> Alter Kontext: strategy = "pv_surplus"
   ├─> Neuer Kontext: strategy = "max_without_battery"
   └─> handleStrategyChange() aufrufen
   
5. Charging Strategy Controller (Battery Lock)
   ├─> Prüft E3DC-Config: enabled=true
   ├─> Entscheidung: Battery Lock aktivieren
   └─> E3DC Client: Battery Lock aktivieren
   
6. E3DC Client (CLI Tool)
   ├─> Befehl: "e3dcset -m set -t dischargelock -v 1"
   └─> Erfolg: Batterie ist gesperrt
   
7. Prowl Notifier (Fire-and-Forget)
   ├─> Sendet Push: "Strategie gewechselt: PV-Überschuss → Max ohne Batterie"
   └─> Sendet Push: "Batterie-Sperre aktiviert"
   
8. Charging Strategy Controller
   ├─> Stoppt Event-Loop (alte Strategie)
   ├─> Startet neue Event-Loop ("max_without_battery")
   └─> Wallbox lädt mit Max. Leistung (32A 1-phasig)
   
9. Storage Layer
   ├─> Speichert: context.strategy = "max_without_battery"
   └─> Speichert: settings.chargingStrategy.activeStrategy = "max_without_battery"
```

### Event-Flow: Input X1 = 0 (Heizstab deaktiviert)

```
1. KEBA Wallbox (Hardware)
   ├─> Heizstab deaktiviert → Input X1 = 0
   └─> Sendet UDP-Broadcast: {"Input": 0, ...}
   
2. Wallbox Broadcast Listener (<10ms)
   ├─> Empfängt Broadcast
   └─> Entscheidung: Input 0 = Ladung stoppen
   
3. Charging Strategy Controller
   ├─> stopChargingForStrategyOff() aufrufen
   ├─> Battery Lock deaktivieren (via handleStrategyChange("off"))
   └─> Wallbox stoppen (UDP: "ena 0")
   
4. Prowl Notifier (Fire-and-Forget)
   ├─> Sendet Push: "Strategie gewechselt: Max ohne Batterie → Aus"
   ├─> Sendet Push: "Batterie-Sperre deaktiviert"
   └─> Sendet Push: "Ladung gestoppt"
   
5. Storage Layer
   └─> Speichert: context.strategy = "off", isActive = false
```

### Timing & Besonderheiten

- **<10ms Latenz**: UDP-Broadcasts werden in Echtzeit verarbeitet
- **Idempotenz**: Strategie-Wechsel nur bei tatsächlicher Änderung
- **In-Memory Tracking**: `lastInputStatus` verhindert redundante Logs
- **Race Condition Safe**: Battery Lock wird **vor** async E3DC-Call gesetzt
- **Graceful Shutdown**: Pending Events werden vor Shutdown abgearbeitet

---

## Use Case 4: Kabel einstecken mit Prowl-Benachrichtigung

### Szenario
Der Benutzer steckt das Ladekabel an sein Auto an. Die App erkennt dies in Echtzeit und sendet eine Push-Benachrichtigung.

### Beteiligte Komponenten
- **Wallbox Broadcast Listener** (UDP-Broadcasts)
- **Storage Layer** (Plug Status Tracking)
- **Prowl Notifier** (Push-Benachrichtigungen)

### Event-Flow

```
1. KEBA Wallbox (Hardware)
   ├─> Benutzer steckt Kabel an
   ├─> Plug-Status: 1 (kein Kabel) → 7 (Auto bereit)
   └─> Sendet UDP-Broadcast: {"Plug": 7, ...}
   
2. Wallbox Broadcast Listener (<10ms)
   ├─> Empfängt Broadcast
   ├─> In-Memory Check: lastPlugStatus = 1
   ├─> Erkennt Änderung: 1 → 7
   └─> Log: "Plug-Status geändert: 1 → 7"
   
3. Storage Layer
   ├─> Speichert: plugStatusTracking.json
   ├─> { lastPlugStatus: 7, lastPlugChange: "2025-11-17T23:15:42.123Z" }
   └─> Persistiert auf Disk (<1ms)
   
4. Prowl Notifier (Fire-and-Forget)
   ├─> Prüft Settings: prowl.events.plugConnected = true
   ├─> API-Call: POST https://api.prowlapp.com/publicapi/add
   ├─> Body: event="Kabel eingesteckt", description="Wallbox bereit"
   └─> Response: Fire-and-Forget (blockiert nicht)
   
5. Benutzer (iOS/Android)
   └─> Erhält Push-Benachrichtigung: "Kabel eingesteckt"
```

### Event-Flow: Kabel ausstecken

```
1. KEBA Wallbox
   └─> Sendet Broadcast: {"Plug": 1, ...}
   
2. Wallbox Broadcast Listener
   └─> Erkennt Änderung: 7 → 1
   
3. Storage Layer
   └─> Speichert: { lastPlugStatus: 1, lastPlugChange: "..." }
   
4. Prowl Notifier
   └─> Sendet Push: "Kabel abgesteckt"
```

### Timing & Besonderheiten

- **Backend-Driven**: Kabel-Status wird vom Backend erkannt (nicht Frontend-Polling)
- **In-Memory Guard**: Verhindert false-positive bei Startup
- **Fire-and-Forget**: Prowl-API-Calls blockieren nie die Ladesteuerung
- **Error Resilience**: Prowl-Fehler werden geloggt aber nicht weiter propagiert

---

## Use Case 5: Fehlerbehandlung und Retry-Logik

### Szenario
Die E3DC-Verbindung ist kurzzeitig unterbrochen. Der Controller muss robust damit umgehen und den Betrieb aufrechterhalten.

### Beteiligte Komponenten
- **E3DC Modbus Hub** (Modbus TCP Verbindung)
- **Charging Strategy Controller** (Retry-Logik)
- **E3DC Client** (CLI-Tools)
- **Prowl Notifier** (Fehler-Benachrichtigungen)

### Event-Flow: Modbus-Verbindung unterbrochen

```
1. E3DC Modbus Hub (1s Polling)
   ├─> Modbus TCP Connect: 192.168.40.20:502
   └─> Error: ECONNREFUSED
   
2. E3DC Modbus Hub (Error Handler)
   ├─> Log: "E3DC Modbus Verbindungsfehler"
   ├─> Markiert: lastE3dcData = null (invalid)
   └─> Wartet 1s bis nächster Versuch
   
3. Charging Strategy Controller (Event-Handler)
   ├─> Empfängt: lastE3dcData = null
   ├─> Entscheidung: Letzten bekannten Wert verwenden
   └─> Keine Stromanpassung (verhindert Fehlsteuerung)
   
4. E3DC Modbus Hub (Retry nach 1s)
   ├─> Modbus TCP Connect: Erfolg
   ├─> Liest Live-Daten
   └─> Publish an Subscriber
   
5. Charging Strategy Controller
   └─> Normaler Betrieb wiederhergestellt
```

### Event-Flow: E3DC CLI-Befehl fehlgeschlagen

```
1. Charging Strategy Controller
   └─> Ruft E3DC Client: enableBatteryLock()
   
2. E3DC Client (CLI Tool)
   ├─> Befehl: "e3dcset -m set -t dischargelock -v 1"
   ├─> Timeout: 30s
   └─> Error: Command failed (Exit Code 1)
   
3. E3DC Client (Error Handler)
   ├─> Log: "E3DC-Fehler beim Aktivieren der Entladesperre"
   ├─> Sanitized Output: Passwörter werden entfernt
   └─> Wirft Exception
   
4. Charging Strategy Controller (Catch)
   ├─> Log: "Battery Lock konnte nicht aktiviert werden"
   └─> Setzt controlState.batteryLock = false (Roll-back)
   
5. Prowl Notifier (Fire-and-Forget)
   ├─> Prüft Settings: prowl.events.errors = true
   └─> Sendet Push: "Fehler: E3DC-Verbindung fehlgeschlagen"
   
6. Charging Strategy Controller
   └─> Fährt fort (Wallbox lädt trotzdem, Batterie-Lock fehlgeschlagen)
```

### Besonderheiten

- **Graceful Degradation**: Bei E3DC-Fehler läuft die Wallbox-Steuerung weiter
- **Rate-Limiting**: 5s zwischen CLI-Befehlen verhindert E3DC-Überlastung
- **Security-First Logging**: CLI-Output wird automatisch sanitized (Passwörter entfernt)
- **Rollback on Error**: Bei fehlgeschlagenen Befehlen wird State zurückgesetzt
- **15s Fallback Timer**: Health-Check wenn Event-Loop hängt (verhindert Deadlock)

---

## Use Case 6: Demo-Modus mit Unified Mock Server

### Szenario
Ein Entwickler oder Interessent möchte EnergyLink testen, ohne echte Hardware (KEBA, E3DC) zu besitzen.

### Beteiligte Komponenten
- **Unified Mock Server** (simuliert KEBA, E3DC, FHEM)
- **E3DC Mock** (Modbus TCP Server auf Port 502)
- **FHEM Mock** (TCP Server auf Port 7072)
- **Wallbox Mock** (UDP-Broadcasts)

### Event-Flow: App-Start im Demo-Modus

```
1. Server Start (server/index.ts)
   ├─> Liest Settings: demoMode = true
   └─> Startet Unified Mock Server
   
2. Unified Mock Server (server/unified-mock-server.ts)
   ├─> Startet E3DC Modbus Mock (Port 502)
   │   ├─> Simuliert PV-Leistung (Tag/Nacht-Zyklus)
   │   ├─> Simuliert Batterie SOC (90%)
   │   └─> Simuliert Hausverbrauch (2000-5000W)
   ├─> Startet FHEM TCP Mock (Port 7072)
   │   └─> Loggt eingehende FHEM-Befehle
   └─> Startet Wallbox UDP Mock
       ├─> Sendet Broadcasts alle 3s
       └─> Reagiert auf "curr", "ena", etc.
       
3. E3DC Modbus Hub
   ├─> Verbindet zu localhost:502
   └─> Empfängt simulierte Live-Daten
   
4. Charging Strategy Controller
   ├─> Verarbeitet Mock-Daten
   └─> Berechnet Ladestrom (wie im echten Betrieb)
   
5. Wallbox Mock
   ├─> Empfängt UDP-Befehl: "curr 9000"
   └─> Simuliert State-Änderung + Broadcast
   
6. E3DC Mock (CLI Intercept)
   ├─> E3DC Client ruft CLI-Befehl
   ├─> Mock erkennt: demoMode = true
   └─> Simuliert Erfolg (ohne echten CLI-Call)
```

### Besonderheiten

- **Realistische Simulation**: PV-Leistung folgt Tageszeit, Hausverbrauch variiert
- **Autoscale-Ready**: Mock läuft auf gleichen Ports wie echte Geräte
- **Bidirektional**: Mock reagiert auf Befehle (z.B. curr, ena)
- **Logging**: FHEM Mock loggt alle eingehenden Befehle
- **CLI Bypass**: E3DC CLI-Befehle werden simuliert (kein externer Prozess)

---

## Timing-Übersicht

| Operation | Latenz | Intervall |
|-----------|--------|-----------|
| UDP-Broadcast Empfang | <10ms | Echtzeit |
| Event-Loop Reaktion | ~1ms | Bei jedem Event |
| E3DC Modbus Polling | 1s | 1s |
| Stromanpassung (min.) | - | 60s |
| E3DC CLI Rate-Limit | - | 5s |
| Night Charging Check | 1s | 1s |
| Prowl API-Call | Async | Non-blocking |
| Storage Write | <1ms | Bei Änderung |

---

## Sicherheits-Features

### Race Condition Prevention
```typescript
// FALSCH: Race Condition möglich
await e3dcClient.enableBatteryLock();
storage.updateControlState({ batteryLock: true });

// RICHTIG: State vor async Call setzen
storage.updateControlState({ batteryLock: true });
await e3dcClient.enableBatteryLock();
```

### Security-First Logging
```typescript
// CLI-Output wird automatisch sanitized
e3dc_user=admin → e3dc_user=xxx
--password mysecret → [REDACTED]
```

### Fire-and-Forget Pattern (Prowl)
```typescript
// FALSCH: Blockiert Ladesteuerung
await prowl.sendChargingStarted();

// RICHTIG: Non-blocking
void prowl.sendChargingStarted();
```

### Idempotenz
```typescript
// Scheduler startet nur wenn nicht bereits aktiv
if (context.isActive && context.strategy === "max_without_battery") {
  return; // Bereits gestartet, überspringe
}
```

---

## Zusammenfassung

EnergyLink kombiniert **event-driven architecture** (1ms Latenz) mit **robust error handling** und **fire-and-forget notifications**. Die Komponenten sind lose gekoppelt und kommunizieren über:

- **UDP-Broadcasts** (KEBA Wallbox, <10ms)
- **Modbus TCP** (E3DC Live-Daten, 1s Polling)
- **CLI-Tools** (E3DC Steuerung, 5s Rate-Limit)
- **File-based Storage** (JSON Persistenz, <1ms)
- **HTTP REST API** (Frontend ↔ Backend)

Die Architektur ist **Autoscale-ready** (Demo-Modus mit Mock Server) und **production-ready** (Raspberry Pi, Docker, Replit).

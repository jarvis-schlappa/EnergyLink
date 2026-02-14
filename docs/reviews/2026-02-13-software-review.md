> **Historisches Dokument.** Viele der hier genannten Punkte wurden inzwischen umgesetzt.

# EnergyLink — Komplettes Software Review

**Projekt:** EnergyLink v1.0.2
**Datum:** 13. Februar 2026
**Umfang:** ~13.100 Zeilen TypeScript (Server + Client + Shared)
**Stack:** Node.js / Express / React / Tailwind CSS / Zod / Modbus TCP / UDP

## 1. Projektübersicht & Zweck

EnergyLink ist eine Progressive Web App (PWA) zur intelligenten Steuerung einer KEBA P20 Wallbox in Kombination mit einem E3DC S10 Hausbatteriespeicher. Die App ermöglicht PV-Überschussladen, Nachtladung mit Netzstrom, Echtzeit-Monitoring und FHEM-SmartHome-Integration.

Kernfunktionen:

- Echtzeit-Wallbox-Monitoring via UDP (KEBA-Protokoll)
- E3DC S10 Modbus TCP Auslesen (PV, Batterie, Netz, Haus)
- 4 Ladestrategien (Surplus Battery/Vehicle Prio, Max mit/ohne Batterie)
- Nachtlade-Scheduler mit Battery Lock + Grid Charging
- FHEM-Synchronisation via Telnet
- Prowl Push-Benachrichtigungen
- Netzfrequenz-Monitoring mit Notlade-Funktion
- Umfangreicher Demo-Modus mit Mock-Servern

Das Projekt ist offensichtlich als persönliches Smart-Home-Projekt entstanden und auf einem Replit-Server deployed. Es zeigt beeindruckende Domänenkenntnis in den Bereichen Energiemanagement, Modbus-Protokoll und KEBA UDP-Kommunikation.

## 2. Architektur

### 2.1 Stärken der Architektur

**Event-getriebene Architektur:** Der E3dcLiveDataHub implementiert ein sauberes Pub/Sub-Pattern. Der E3DC-Poller liest Daten und broadcastet sie, und die Charging Strategy sowie der FHEM-Sync reagieren darauf event-driven. Das ist ein gutes Design mit niedriger Latenz (~1ms laut Kommentar).

**Zentrale UDP-Architektur:** Der WallboxUdpChannel als Single-Socket-Lösung für Port 7090 mit Event-basiertem Routing an verschiedene Consumer (Broadcast-Listener, Command-Transport) ist eine saubere Lösung, die Port-Konflikte verhindert.

**Command Queue:** Der wallbox-transport.ts implementiert eine sequentielle Command-Queue mit Timeout-Handling für die UDP-Request/Response-Kommunikation — wichtig, da KEBA nur einen Befehl gleichzeitig verarbeitet.

**Graceful Shutdown:** Saubere Implementierung mit SIGTERM/SIGINT-Handling. Alle Scheduler, Listener und Connections werden ordentlich heruntergefahren, inklusive Warten auf laufende Operationen.

### 2.2 Architektur-Schwächen

**Monolithische routes.ts (1.968 Zeilen):** Diese Datei ist der kritischste Schwachpunkt des Projekts. Sie enthält API-Endpoints, Scheduler-Logik, Night-Charging-Steuerung, FHEM-Helper, State-Management und Business-Logik in einer einzigen Funktion registerRoutes(). Eine Aufspaltung in separate Module (z.B. wallbox-routes.ts, e3dc-routes.ts, scheduler.ts, night-charging.ts) würde die Wartbarkeit erheblich verbessern.

**Doppelte ChargingStrategyController-Instanzen:** Sowohl routes.ts als auch wallbox-broadcast-listener.ts erstellen jeweils eine eigene Instanz des Controllers (new ChargingStrategyController(sendUdpCommand)). Das kann zu inkonsistentem State führen, da jede Instanz ihren eigenen lastE3dcData, batteryDischargeSince, etc. hat. Hier wäre ein Singleton-Pattern oder Dependency Injection angebracht.

**Zirkuläre Abhängigkeiten:** storage.ts muss logStorage() intern reimplementieren, um zirkuläre Imports mit logger.ts zu vermeiden. routes.ts importiert dynamisch shutdownSchedulers aus sich selbst in index.ts.

**Keine klare Service-Layer-Trennung:** Business-Logik (Surplus-Berechnung, Strategie-Entscheidungen) ist direkt in Controller-Klassen und Route-Handlern verteilt, statt in dedizierten Services.

## 3. Code-Qualität

### 3.1 Positiv

**Sehr gutes Logging:** Das Logging-System ist durchdacht mit 5 Levels (trace → error), Kategorien, Timestamps und einer In-Memory-Ringbuffer-Implementierung (max 1.000 Einträge). Die Logs sind auf Deutsch und sehr aussagekräftig.

**Zod-Validierung:** Alle Schemas und API-Inputs werden mit Zod validiert. Die Shared-Schema-Datei sorgt für Typ-Konsistenz zwischen Client und Server.

**Defensive Programmierung:** Viele Guards gegen Race Conditions (z.B. isNightChargingOperationInProgress-Lock, processStrategyWithTracking mit Event-Queue, "State VOR async-Operation setzen"-Pattern).

**Credential-Sanitization:** e3dc-client.ts sanitized Log-Ausgaben gründlich gegen Passwörter und API-Keys mit mehreren Pattern-Ebenen.

### 3.2 Negativ

**Fehlende Tests:** "test": "echo 'No tests specified' && exit 0" — Es gibt keinerlei Unit-, Integrations- oder E2E-Tests. Bei einem System, das reale Hardware steuert und komplexe State-Maschinen enthält, ist das ein erhebliches Risiko. Besonders die Surplus-Berechnungen, Strategie-Entscheidungen und Time-Window-Logik schreien nach Tests.

**Leftover-Dateien:** storage.ts.broken und storage.ts.orig sind im Repository verblieben — Zeichen für manuelles Debugging ohne sauberes VCS-Workflow.

**Übermäßiger Any-Typ:** An mehreren Stellen werden any-Casts verwendet (z.B. settings: any in den Battery-Lock-Funktionen in routes.ts, parsed: any in wallbox-udp-channel.ts), obwohl typensichere Alternativen möglich wären.

**Inkonsistente Fehlerbehandlung:** Im Express Error-Handler in index.ts wird throw err nach res.status(status).json() aufgerufen — das wirft einen unhandled Error im Server-Prozess, was zum Crash führen kann.

**Hardcoded Default-Werte:** Die Default-Wallbox-IP 192.168.40.16 und FHEM-URL http://192.168.40.11:8083/fhem?... sind mehrfach hardcoded statt zentral definiert.

## 4. Sicherheit

### 4.1 Kritisch: Command Injection

Der Endpoint POST /api/e3dc/execute-command nimmt einen beliebigen String entgegen und führt ihn via execAsync(fullCommand) als Shell-Befehl aus. Es gibt keinerlei Input-Sanitization oder Whitelisting:

```typescript
// routes.ts Zeile 904
const { command } = req.body;
// → wird direkt an e3dcClient.executeConsoleCommand() durchgereicht
// → dort via execAsync(fullCommand) als Shell-Befehl ausgeführt
```

Ein Angreifer mit Netzwerkzugriff kann beliebige Systembefehle ausführen. Auch wenn die App primär im lokalen Netz läuft und kein Auth-System hat, ist das ein schwerwiegendes Sicherheitsrisiko, besonders bei der Replit-Deployment-Variante mit öffentlicher URL.

**Empfehlung:** Whitelist erlaubter Befehle oder Parametervalidierung. Mindestens sollte die Shell-Metazeichen-Escaping stattfinden oder besser auf eine parametrisierte API umgestellt werden.

### 4.2 Keine Authentifizierung

Die gesamte API ist unauthentifiziert. Jeder im Netzwerk kann Ladungen starten/stoppen, Battery Locks setzen, Konfiguration ändern und Shell-Befehle ausführen. Passport und express-session sind zwar als Dependency installiert, werden aber nirgends verwendet.

### 4.3 FHEM-Statusabfrage via HTML-Parsing

getFhemDeviceState() parsed FHEM-HTML mit Regex, was fragil und potenziell anfällig für HTML-Injection ist, wenn FHEM-Gerätenamen nicht sanitized werden.

### 4.4 SmartHome-URLs via SSRF

callSmartHomeUrl() ruft beliebige URLs auf, die in den Settings konfiguriert sind. Im Demo-Modus mit öffentlichem Zugang könnte das für Server-Side Request Forgery missbraucht werden.

## 5. Robustheit & Fehlerbehandlung

### 5.1 Stärken

**Modbus-Reconnect-Logik:** Die E3DC-Modbus-Verbindung markiert sich bei Lesefehlern als disconnected und verbindet sich beim nächsten Versuch automatisch neu. Der E3DC-Poller implementiert ein Backoff-Pattern bei wiederholten Fehlern.

**Race-Condition-Guards:** Die processStrategyWithTracking-Methode verhindert überlappende Strategieprüfungen mit einer Pending-Queue. Der Night-Charging-Scheduler nutzt ein isNightChargingOperationInProgress-Lock.

**State-Rollback:** Bei E3DC-Befehlsfehlern wird der Control-State zurückgerollt (z.B. Battery Lock zurücksetzen wenn lockDischarge fehlschlägt).

### 5.2 Schwächen

**Kein Health-Check-Endpoint:** Es gibt keinen dedizierten Health-Check für Monitoring oder Load-Balancer-Integration.

**Storage ist rein File-basiert:** Alle State-Daten werden synchron als JSON-Dateien geschrieben (writeFileSync). Bei einem Stromausfall während des Schreibens kann die Datei korrumpiert werden. Ein atomares Schreiben (write-to-temp + rename) wäre sicherer.

**In-Memory-Logs:** Die Log-Ringbuffer geht bei jedem Neustart verloren. Für ein System, das 24/7 Wallboxen steuert, wäre ein persistentes Logging-Backend sinnvoll.

**Keine Retry-Logik für UDP-Befehle:** Wenn ein UDP-Befehl an die Wallbox per Timeout fehlschlägt, gibt es keinen automatischen Retry. Das ist problematisch bei transienten Netzwerkproblemen.

## 6. Frontend

### 6.1 Stärken

**Gute UX-Entscheidungen:** SSE für Echtzeit-Updates kombiniert mit 5s-Polling als Fallback. Drawer-basierte mobile UI. Countdown-Anzeige für Start/Stop-Verzögerungen. Sofortige UI-Reaktion durch "respond first, process in background"-Pattern bei Start/Stop.

**Komponentenbibliothek:** Saubere Nutzung von shadcn/ui-Komponenten (Radix + Tailwind). Design-Guidelines-Datei vorhanden.

**PWA-Support:** Manifest, Icons, und mobile-optimiertes Layout sind vorhanden.

### 6.2 Schwächen

**Riesige Page-Komponenten:** SettingsPage.tsx hat 1.670 Zeilen, StatusPage.tsx hat 1.055 Zeilen. Diese sollten in Subcomponenten aufgeteilt werden (z.B. NightChargingSettings, E3dcSettings, StrategySelector).

**Polling auf mehreren Endpoints gleichzeitig:** StatusPage pollt parallel /api/wallbox/status, /api/controls, /api/settings, /api/wallbox/plug-tracking und /api/charging/context alle 5 Sekunden. Das sind 5 API-Calls alle 5 Sekunden pro Client. Ein konsolidierter Endpoint wäre effizienter.

**Keine Fehler-Boundary:** Es gibt kein React Error Boundary. Ein Rendering-Fehler in einer Unterkomponente bringt die gesamte App zum Stillstand.

## 7. DevOps & Deployment

### 7.1 Dockerfile-Problem

Die Production-Stage installiert npm ci (alle Dependencies inkl. devDependencies), obwohl nur node dist/index.js ausgeführt wird. Der Kommentar "including dev, as vite is needed at runtime" ist falsch — Vite wird in Production nicht benötigt, da der Build bereits in der Builder-Stage erfolgt. Das bläht das Image unnötig auf.

### 7.2 Keine Environment-Validierung

Es gibt kein Schema oder Check für erforderliche Environment-Variablen. Die App startet mit Defaults, auch wenn kritische Konfiguration fehlt.

### 7.3 Paketname

"name": "rest-express" im package.json — offensichtlich vom Starter-Template übernommen, sollte energylink heißen.

## 8. Empfehlungen nach Priorität

### Priorität 1 — Kritisch

- **Command Injection schließen:** /api/e3dc/execute-command muss entweder mit Whitelist-Validation geschützt oder entfernt werden. Absolut kein User-Input direkt an exec().
- **Authentifizierung einbauen:** Mindestens Basic Auth oder API-Key für die gesamte API, besonders bei öffentlichem Replit-Deployment.
- **Error-Handler fixen:** throw err in Zeile 111 von index.ts entfernen — das crasht den Server bei jedem Fehler.

### Priorität 2 — Wichtig

- **Tests schreiben:** Beginnen mit Unit-Tests für calculateSurplus(), calculateTargetCurrent(), isTimeInRange() und die Strategie-State-Machine. Dann Integrationstests für die UDP-Command-Queue.
- **routes.ts aufspalten:** In mindestens 4 Module: wallbox-routes, e3dc-routes, settings-routes, scheduler-management.
- **ChargingStrategyController-Singleton:** Eine einzige Instanz über die gesamte App, injiziert statt doppelt erstellt.
- **Atomares File-Writing:** writeFileSync → write to temp + renameSync für alle State-Dateien.

### Priorität 3 — Verbesserungen

- **Konsolidierter Status-Endpoint:** Ein /api/dashboard-state der alle Polling-Daten kombiniert zurückgibt.
- **Retry-Logik für UDP:** 1–2 automatische Retries bei Timeout mit exponentiellem Backoff.
- **Frontend-Refactoring:** Page-Komponenten in kleinere Subcomponenten aufteilen.
- **Cleanup:** storage.ts.broken, storage.ts.orig entfernen. Package auf energylink umbenennen. Unused Radix-Dependencies entfernen (Context Menu, Menubar, etc. scheinen nicht verwendet).
- **Dockerfile optimieren:** Production-Stage auf npm ci --omit=dev umstellen.

## 9. Gesamtbewertung

| Kriterium | Bewertung | Kommentar |
|-----------|-----------|-----------|
| Funktionalität | ★★★★★ | Sehr umfangreich, durchdachte Ladestrategien, beeindruckendes Feature-Set |
| Architektur | ★★★☆☆ | Gute Event-Architektur, aber monolithische Route-Datei und doppelte Controller |
| Code-Qualität | ★★★½☆ | Gutes Logging und Defensive Coding, aber keine Tests und zu große Dateien |
| Sicherheit | ★★☆☆☆ | Command Injection, keine Auth, SSRF-Potenzial |
| Robustheit | ★★★★☆ | Gute Reconnect- und Race-Condition-Logik, fragile File-Persistierung |
| Frontend | ★★★½☆ | Gute UX, aber übergroße Komponenten und zu viel Polling |
| Dokumentation | ★★★★☆ | Ausführliche README, ARCHITEKTUR.md, USECASES.md, Code-Kommentare auf Deutsch |
| DevOps | ★★½☆☆ | Docker vorhanden aber suboptimal, keine CI/CD, kein Health-Check |

**Fazit:** EnergyLink ist ein beeindruckendes Hobby-Projekt mit exzellenter Domänenkenntnis und durchdachter Funktionalität. Die Event-getriebene E3DC-Integration und die Ladestrategie-Engine sind architektonisch gut gelöst. Die Hauptrisiken liegen in der fehlenden Sicherheit (Command Injection + keine Auth) und der fehlenden Testabdeckung. Mit den vorgeschlagenen Verbesserungen — besonders der Sicherheitsfixes und der Modularisierung — hat das Projekt das Potenzial, ein robustes, produktionsreifes Energiemanagement-System zu werden.

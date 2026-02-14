# Architektur

Technischer Überblick über den Aufbau von EnergyLink (v1.0.2).

## Systemübersicht

```
┌─────────────────────────────────────────┐
│           Frontend (React/Vite)         │
│  StatusPage · E3dcPage · LogsPage       │
│  SettingsPage · BottomNav               │
│  TanStack Query · shadcn/ui · Tailwind  │
└──────────────────┬──────────────────────┘
                   │ REST API (Port 3000)
┌──────────────────▼──────────────────────┐
│           Backend (Express.js)          │
│                                         │
│  Routes:                                │
│  ├── wallbox-routes.ts  (Wallbox-API)   │
│  ├── e3dc-routes.ts     (E3DC-API)     │
│  ├── settings-routes.ts (Settings)      │
│  ├── status-routes.ts   (System-Status) │
│  ├── scheduler.ts       (Zeitsteuerung) │
│  ├── demo-routes.ts     (Demo-Modus)    │
│  ├── shared-state.ts    (Globaler State)│
│  └── helpers.ts         (Utilities)     │
│                                         │
│  Core:                                  │
│  ├── charging-strategy-controller.ts    │
│  ├── e3dc-gateway.ts    (Gateway IF)    │
│  ├── phase-provider.ts  (Phasen IF)     │
│  ├── e3dc-client.ts     (E3DC Zugriff)  │
│  ├── e3dc-poller.ts     (Modbus Poll)   │
│  ├── storage.ts         (JSON-Persistenz)│
│  ├── wallbox-transport.ts (UDP-Befehle) │
│  ├── wallbox-broadcast-listener.ts      │
│  └── unified-mock.ts    (Demo-Server)   │
└────┬──────────┬──────────┬──────────────┘
     │ UDP      │ Modbus   │ TCP
     │ :7090    │ :502     │ :7072
     ▼          ▼          ▼
  KEBA       E3DC S10    FHEM
  Wallbox                Server
```

## Design-Patterns

### E3DC Gateway Interface (Strategy Pattern)

Das `E3dcGateway`-Interface entkoppelt die Ladesteuerung vom konkreten E3DC-Zugriff:

```typescript
interface E3dcGateway {
  executeCommand(command: string, commandName: string): Promise<string>;
}
```

| Implementierung | Verwendung |
|----------------|-----------|
| `RealE3dcGateway` | Produktion – führt das `e3dcset` CLI-Tool aus |
| `MockE3dcGateway` | Demo – führt `e3dcset-mock.ts` aus |

Die Gateway-Instanz wird beim App-Start basierend auf `demoMode` gewählt und in den `e3dc-client` injiziert.

### PhaseProvider Interface

Das `PhaseProvider`-Interface bestimmt die Phasenzahl beim Ladestart:

```typescript
interface PhaseProvider {
  getStartPhases(isSurplusStrategy: boolean, config: ChargingStrategyConfig): number;
}
```

| Implementierung | Logik |
|----------------|-------|
| `RealPhaseProvider` | Surplus → 1P, sonst aus `physicalPhaseSwitch` |
| `MockPhaseProvider` | Aus `mockWallboxPhases` in Settings |

### Storage Layer

File-basierte JSON-Persistenz (`data/*.json`) mit atomaren Schreibvorgängen. Verwaltet:
- Settings, Control State, Plug-Status-Tracking
- Charging Context, Log-Einträge

## Kommunikationsprotokolle

| Ziel | Protokoll | Port | Intervall |
|------|-----------|------|-----------|
| KEBA Wallbox | UDP | 7090 | Echtzeit (Broadcasts) |
| E3DC Modbus | Modbus TCP | 502 | 1s Polling |
| E3DC Steuerung | CLI (`e3dcset`) | – | Bei Bedarf (5s Rate-Limit) |
| FHEM | TCP Socket | 7072 | 10s Sync |
| Frontend | REST/SSE | 3000 | 5s Auto-Refresh |

## Charging Strategy Controller

Kernstück der Ladesteuerung:

- **Polling:** Alle 15s E3DC-Daten auswerten
- **Phasen-Erkennung:** Automatisch aus Stromwerten (1P/3P)
- **Dwell-Time:** 30s Mindestabstand zwischen Stromanpassungen
- **On-the-fly Switching:** Strategiewechsel ohne Lade-Unterbrechung
- **Graceful Degradation:** Wallbox läuft weiter bei E3DC-Ausfall

## Demo-Modus

Der Unified Mock Server (`unified-mock.ts`) simuliert das gesamte System:

- **Wallbox Mock:** UDP-Broadcasts, reagiert auf Befehle
- **E3DC Mock:** Modbus TCP mit tageszeitabhängiger PV-Kurve
- **FHEM Mock:** TCP-Server loggt eingehende Daten
- **E3DC CLI Mock:** `e3dcset-mock.ts` simuliert CLI-Befehle

Realistische Simulation: Saisonale PV-Variation, Haushalts-Lastprofile, State-Synchronisation zwischen Wallbox und E3DC.

## Test-Architektur

**185 Tests** über 16 Testdateien mit [Vitest](https://vitest.dev/):

| Kategorie | Dateien | Fokus |
|-----------|---------|-------|
| Unit-Tests | `charging-strategy.test.ts`, `helpers.test.ts`, `time-range.test.ts`, `storage.test.ts` | Reine Logik, keine Mocks |
| Edge Cases | `charging-strategy-edge-cases.test.ts` | Grenzfälle der Strategien |
| Integration | `api-integration.test.ts`, `status-routes.test.ts` | HTTP-API via Supertest |
| Sicherheit | `auth.test.ts`, `e3dc-command-validation.test.ts`, `env-validation.test.ts` | Auth, Input-Validierung |
| Infrastruktur | `health.test.ts`, `error-handler.test.ts`, `udp-retry.test.ts` | Robustheit |

Tests laufen in der CI-Pipeline (GitHub Actions) bei jedem Push und PR.

## Sicherheit

- **Zod-Schemas:** Runtime-Validierung aller API-Eingaben
- **CLI Output Sanitization:** Passwörter werden aus Logs entfernt
- **Atomic File Writes:** Crash-sichere Persistenz
- **Modbus Auto-Recovery:** Automatische Wiederverbindung
- **API-Key Auth:** Optional für externe Zugriffe

---

## Weiterführend

- [Use Cases](use-cases.md) – Detaillierte Event-Flows
- [Konfiguration](configuration.md) – Alle Einstellungen
- [Design Guidelines](design-guidelines.md) – UI/UX-Richtlinien

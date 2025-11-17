# EnergyLink - Entwicklungsleitfaden

## Overview
EnergyLink is a Progressive Web App (PWA) for controlling KEBA Wallbox charging stations. It offers real-time status monitoring, charge control, and SmartHome integration, including automated charging based on PV surplus, night schedules, and battery lockout rules. A key feature is its integration with E3DC systems via CLI tools and Modbus TCP for battery discharge control and grid charging capabilities. The application adheres to Material Design 3 principles with a mobile-first approach, optimized for German users.

## User Preferences
Preferred communication style: Simple, everyday language.

Deployment Target: Local operation (home server/Raspberry Pi/Docker) in private network. Application communicates via HTTP in development; HTTPS not required for local-only deployment but recommended if accessible from internet.

## System Architecture
The application is a PWA with a mobile-first, responsive design using Material Design 3 principles and Roboto typography.

### Frontend
Built with React 18+, TypeScript, Wouter for routing, TanStack Query for state management, and shadcn/ui (Radix UI primitives) for UI components. Styling uses Tailwind CSS. Key UI elements include `StatusCard`, `ChargingVisualization`, and `BottomNav`. SmartHome controls (PV surplus, battery lock, grid charging) are on the Settings page, with E3DC-specific controls appearing conditionally. The E3DC page provides live energy monitoring with 5-second auto-refresh. The Settings page uses Accordions for organization and includes clear hint boxes. A demo mode supports testing all KEBA cable states.

### Backend
An Express.js and TypeScript backend provides a RESTful API. It uses a file-based storage abstraction layer for settings, wallbox status, control state, and plug tracking. E3DC integration is via CLI tools (`e3dcset`) for battery control and Modbus TCP (`modbus-serial`) for real-time energy monitoring. A unified mock server simulates KEBA Wallbox, E3DC S10, and FHEM for development and demo purposes, with graceful shutdown for production. The backend tracks cable status changes via a UDP broadcast listener for real-time updates and persistence.

### Data Storage
File-based persistence is used for `WallboxStatus`, `Settings`, `ControlState`, and `PlugStatusTracking` in JSON files. Drizzle ORM is configured for PostgreSQL but currently not active. Zod schemas ensure runtime validation and type safety.

### Key Architectural Decisions
- **Separation of Concerns**: Shared schema definitions for type safety.
- **File-based Persistency**: Settings, control state, plug tracking, and charging context stored in JSON files.
- **Storage Abstraction**: Flexible persistence strategy with backward compatibility.
- **Mobile-First PWA**: Optimized for touch devices.
- **Webhook Integration**: For external SmartHome systems (e.g., FHEM for PV surplus).
- **E3DC-Only Battery Control**: Battery discharge locking and grid charging managed exclusively via E3DC CLI, with UI controls appearing conditionally.
- **Type Safety**: Zod schemas for validation.
- **Security-First Logging**: CLI output sanitization.
- **Visual Status Feedback**: Icon-based status indicators for active SmartHome features.
- **Fixed Timezone**: Europe/Berlin for all time-based operations.
- **Optimistic UI**: With refetch-on-mount for data consistency.
- **Backend-Driven Status Tracking**: Cable status changes detected and persisted by the backend via UDP broadcast listener.
- **Broadcast-Handler Architecture**: Real-time processing of Wallbox UDP broadcasts for Input X1, Plug, State, and E pres.
- **Auto-Start Mock Server**: Unified mock server auto-starts for demo/showcase (`DEMO_AUTOSTART=true` or `demoMode=true`).
- **Demo/Production Split**: Mock server binds ports only in demo mode; production mode uses real hardware.
- **Season-Aware PV Simulation**: E3DC mock service uses Europe/Berlin timezone for accurate PV power generation.
- **Atomic Mock Data Snapshots**: Uses promise-based lock for consistent Modbus register reads in mock server.
- **Realistic Household Consumption**: Mock server simulates typical household power consumption with time-based peaks.
- **Autoscale-Ready**: Single-process architecture with auto-start mock server for Replit Autoscale.
- **Internal PV Surplus Charging**: Four configurable charging strategies with automatic phase switching and on-the-fly strategy changes.
- **Potenzialfreier Kontakt (X1) Integration**: Configurable strategy selection for closed X1 contact via UDP broadcast handler.
- **Single-Socket UDP Architecture**: Centralized `wallboxUdpChannel` provides shared UDP socket for KEBA communication with a persistent message-handler pattern and IP-based filtering.
- **FHEM TCP Mock Server**: Unified mock includes TCP server on port 7072 for demo mode, logging incoming setreading commands on DEBUG level with automatic localhost configuration.

## External Dependencies
- **UI Components**: shadcn/ui (New York style), Radix UI Primitives, Lucide React (icons).
- **Styling & Build Tools**: Tailwind CSS, PostCSS, Vite, esbuild.
- **State Management & Data Fetching**: TanStack Query v5, React Hook Form with Zod Resolvers.
- **Database & ORM**: Drizzle ORM, @neondatabase/serverless (PostgreSQL), drizzle-zod (currently using file-based persistence).
- **SmartHome Integration**:
    *   **E3DC**: CLI tool (e3dcset) and `modbus-serial` library for Modbus TCP.
    *   **FHEM**: Bidirectional integration via webhooks (inbound PV surplus) and TCP socket (outbound E3DC data sync).
    *   **KEBA Wallbox**: Direct UDP/HTTP API communication.
- **Development Tools**: Replit-specific plugins, TypeScript Strict Mode, path aliases.

---

### FHEM-E3DC-Integration (Live-Daten-Sync)

**Status:** ✅ PRODUCTION-READY (Nov 17, 2025) | **Version:** v1.3.0

**Implementiert:**
- 5 E3DC-Werte werden alle 10s an FHEM gesendet via TCP-Socket (Port 7072)
- Production-grade Socket-Lifecycle mit graceful shutdown
- Promise-Queue für concurrent stop-calls (verhindert Timer-Leaks)
- Funktioniert im Demo-Modus (mit Mock-Daten) und Production (E3DC Modbus)
- Ein/Aus-Schalter + konfigurierbare IP/Port in Settings
- Log-Kategorie: `fhem`

**Technische Umsetzung:**
- **Service:** `server/fhem-e3dc-sync.ts` mit Scheduler (10s Intervall)
- **Schema:** `fhemSync: { enabled, ip, port }` in `shared/schema.ts`
- **UI:** Settings-Page mit Switch-Control, IP- und Port-Input
- **Transport:** Native Node.js TCP-Socket (net.Socket) mit graceful close
- **Security:** Port-Validierung, keine Command-Injection möglich

**FHEM-Schnittstelle:**
```
IP: 192.168.40.11 (konfigurierbar)
Port: 7072 (konfigurierbar)
Device: S10 (fix)
Protokoll: Telnet (Netcat)
```

**Daten-Mapping:**

| FHEM Reading | E3DC Quelle | Beschreibung | Beispiel |
|--------------|-------------|--------------|----------|
| `sonne` | `pvPower` | PV-Leistung | 4500 W |
| `haus` | `housePower` | Hausverbrauch | 1200 W |
| `soc` | `batterySoc` | Batterie-Ladezustand | 85 % |
| `netz` | `gridPower` | Netzbezug/Einspeisung | -3300 W (negativ = Einspeisung) |
| `speicher` | `batteryPower` | Batterieleistung | -2000 W (negativ = Entladung) |

**Batch-Update-Flow (TCP-Socket):**
```typescript
// Lifecycle: connect -> write -> drain -> end -> finish (bytesWritten) -> close
const socket = net.createConnection(port, ip);
socket.write(payload, 'utf8');
await new Promise((resolve, reject) => {
  socket.once('drain', () => socket.end());
  socket.once('finish', () => {
    if (socket.bytesWritten === Buffer.byteLength(payload, 'utf8')) resolve();
    else reject(new Error('Partial write detected'));
  });
});
socket.destroy();
```

**Fehlerbehandlung:**
- FHEM nicht erreichbar: Logging (Kategorie `fhem`), Scheduler läuft weiter
- E3DC nicht verbunden: Scheduler läuft weiter, Fehler geloggt
- Socket-Fehler: Timeout (5s), partial-write detection, non-blocking
- **Graceful Shutdown:** Wartet auf laufenden Sync, clearInterval, clearTimeout

**Production-Ready-Features:**
1. **Socket-Lifecycle:** Graceful close mit drain + finish events + bytesWritten-Check
2. **Promise-Tracking:** `runningSyncPromise` verhindert overlapping syncs
3. **Promise-Queue:** `runningStopPromise` serialisiert concurrent stop-calls
4. **Shutdown-Hook:** `shutdownSchedulers()` in `index.ts` wartet auf laufenden Sync
5. **No Timer Leaks:** Module-scope handles + cleanup garantieren sauberen Shutdown
6. **Demo-Mode Mock Server:** FHEM TCP Mock auf Port 7072 loggt eingehende setreading-Befehle auf DEBUG-Level, FHEM-Sync IP wird automatisch auf 127.0.0.1 gesetzt

**Demo-Mode Features:**
- **FHEM TCP Mock Server:** Lauscht auf Port 7072 (0.0.0.0), empfängt setreading-Befehle
- **Automatic Config Override:** `storage.saveSettings()` setzt `fhemSync.host` auf `127.0.0.1` beim Mock-Start
- **DEBUG-Level Logging:** Jeder setreading-Befehl wird einzeln geparst und geloggt (Kategorie `fhem-mock`)
- **Socket Lifecycle:** Accept → Data → Parse → Log → Close mit vollständiger Error-Handling
- **Graceful Shutdown:** TCP-Server wird in `stopUnifiedMock()` sauber geschlossen

**Files Changed:**
- `shared/schema.ts` (fhemSync-Schema)
- `server/storage.ts` (Default-Werte)
- `server/fhem-e3dc-sync.ts` (Sync-Service + Scheduler + Promise-Queue)
- `server/routes.ts` (Scheduler-Integration + shutdownSchedulers export)
- `server/index.ts` (Shutdown-Hook)
- `server/unified-mock.ts` (FHEM TCP Mock Server + Auto-Config)
- `client/src/pages/SettingsPage.tsx` (UI-Controls)

---

### Charging-Strategy Event-Driven Architecture (E3DC-Integration)

**Status:** ✅ PRODUCTION-READY (Nov 17, 2025) | **Version:** v2.0.0

**Implementiert:**
- Event-driven Charging Strategy Controller reagiert sofort auf E3DC-Daten (~1ms statt 15s worst-case)
- Event-Queue verhindert Event-Loss bei schnellen Broadcasts (neueste Daten immer verarbeitet)
- Promise-Tracking verhindert overlapping strategy executions (ein Check zur Zeit)
- Graceful shutdown mit `isShuttingDown` flag (stoppt nach aktuellem Run)
- 15s Fallback-Timer als Health-Check (ergänzt Event-System)
- Log-Kategorie: `strategy`

**Technische Umsetzung:**
- **Event-Listener:** `ChargingStrategyController.startEventListener()` subscribed zu E3dcLiveDataHub
- **Event-Queue:** `pendingE3dcData` speichert neueste Daten während laufendem Strategy Check
- **Promise-Tracking:** `runningStrategyPromise` verhindert overlapping executions
- **Sequential Processing:** While-Loop verarbeitet gequeuete Events nach jedem Run
- **Shutdown-Flag:** `isShuttingDown` verhindert neue Strategy Checks nach `stopEventListener()`
- **Dual-System:** Event-driven (primär) + 15s Fallback-Timer (Health-Check)

**Event-Flow:**
```
E3DC Modbus Poller (5s) 
  → E3dcLiveDataHub.broadcast() 
  → 2 Listener (FHEM + Strategy) 
  → processStrategyWithTracking() 
  → Queue wenn aktiv, sonst sofort
  → While-Loop für gequeuete Events
```

**Promise-Tracking-Pattern:**
```typescript
async processStrategyWithTracking(data: E3dcLiveData, wallboxIp: string) {
  if (isShuttingDown) return;  // Bail on shutdown
  
  if (runningStrategyPromise) {
    pendingE3dcData = data;     // Queue latest data
    await runningStrategyPromise;
    return;
  }
  
  runningStrategyPromise = (async () => {
    await processStrategy(data, wallboxIp);
    
    while (pendingE3dcData && !isShuttingDown) {
      const nextData = pendingE3dcData;
      pendingE3dcData = null;   // Clear before processing
      await processStrategy(nextData, wallboxIp);
    }
  })().finally(() => runningStrategyPromise = null);
  
  await runningStrategyPromise;
}
```

**Graceful Shutdown Sequence:**
1. Set `isShuttingDown` flag (prevents new strategy checks)
2. Unsubscribe immediately (prevents new events)
3. Wait for running promise (prevents abort during UDP communication)

**Hot-Reload Safety:**
- `startEventListener()` is async and awaits `stopEventListener()` in guard
- Prevents race condition: Old Promise completes before new subscription starts
- Routes updated: `await strategyController.startEventListener(wallboxIp)`
- Graceful cleanup ensures unsubscribe + promise-await before re-subscribing

**Production-Ready-Features:**
1. **Event-Queue:** Single-slot queue für neueste E3DC-Daten (verhindert Event-Loss)
2. **Sequential Processing:** While-Loop verarbeitet gequeuete Events (keine Overlap)
3. **Shutdown-Flag:** `isShuttingDown` verhindert neue Strategy Checks nach Stop
4. **Promise-Tracking:** Verhindert concurrent strategy executions (Race-Condition-Free)
5. **Dual-Trigger:** Event-driven (primär) + 15s Timer (Fallback/Health-Check)
6. **Module-Scope Controller:** `strategyController` für Shutdown-Zugriff in `routes.ts`
7. **Hot-Reload Safe:** Guard awaits stopEventListener() to prevent overlapping subscriptions

**Performance:**
- **Event-Latenz:** ~1ms (von E3DC-Broadcast bis Strategy Check)
- **Worst-Case ohne Events:** 15s (Fallback-Timer)
- **Broadcasting:** 2 Listener (FHEM + Strategy) parallel
- **No Overhead:** Event-Queue nur bei Overlap (selten)

**Fehlerbehandlung:**
- Event während laufendem Check: Queue neueste Daten, verarbeite nach Completion
- Shutdown während Event: `isShuttingDown` flag verhindert neue Runs
- Overlapping executions: Promise-Tracking verhindert concurrent Runs
- Event-Loop-Blockierung: `setImmediate()` für non-blocking Event-Handler

**Files Changed:**
- `server/charging-strategy-controller.ts` (Event-Listener, Event-Queue, Promise-Tracking, Graceful Shutdown)
- `server/routes.ts` (Module-scope controller, Event-Listener startup, Shutdown-Hook)
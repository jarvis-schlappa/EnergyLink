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

## External Dependencies
- **UI Components**: shadcn/ui (New York style), Radix UI Primitives, Lucide React (icons).
- **Styling & Build Tools**: Tailwind CSS, PostCSS, Vite, esbuild.
- **State Management & Data Fetching**: TanStack Query v5, React Hook Form with Zod Resolvers.
- **Database & ORM**: Drizzle ORM, @neondatabase/serverless (PostgreSQL), drizzle-zod (currently using file-based persistence).
- **SmartHome Integration**:
    *   **E3DC**: CLI tool (e3dcset) and `modbus-serial` library for Modbus TCP.
    *   **FHEM**: Webhook-based integration.
    *   **KEBA Wallbox**: Direct UDP/HTTP API communication.
- **Development Tools**: Replit-specific plugins, TypeScript Strict Mode, path aliases.

---

## Geplante Features (Backlog)

### Echtzeit UI-Updates & Reaktionszeit-Optimierung

**Status:** Backlog (Nov 2024) | **Priorität:** MEDIUM (UX-Verbesserung)

**Hintergrund:**
Aktuelle Polling-Intervalle (5s für Status, 2s für Settings) führen zu spürbaren Verzögerungen bei Status-Änderungen. Hardware-Events (State-Transitions, Input-Broadcasts) werden vom Backend sofort erkannt, aber UI aktualisiert erst beim nächsten Poll-Intervall.

**Aktuelle Latenz-Analyse:**
- **Hardware → Backend:** < 10ms (Broadcast-Listener)
- **Backend → Frontend:** 0-5s (Polling-Intervall)
- **E3DC Battery Lock:** ~2,1s (CLI-Tool)
- **Wallbox ena/curr:** ~1-2s (UDP-Befehle)

**Gemessene Gesamt-Reaktionszeiten (Input-basiert):**
| Aktion | Hardware | UI-Update | Gesamt |
|--------|----------|-----------|--------|
| Input=1 (Starten) | 9,6s | +0-5s | **9,6-14,6s** |
| Input=0 (Stoppen) | 2,8s | +0-5s | **2,8-7,8s** |

**Implementierungsplan:**

**Phase 1: Kurzfristige Optimierung (1-2h)**
- [ ] **Polling-Intervall reduzieren**
  - StatusPage: 5s → 2s (refetchInterval)
  - Alle anderen Pages entsprechend anpassen
  - Server-Load erhöht sich um Faktor 2,5x (akzeptabel)
  
- [ ] **Optimistic UI-Updates für User-Aktionen**
  - `startCharging()`: UI zeigt "Starte Ladung..." sofort
  - `stopCharging()`: UI zeigt "Stoppe Ladung..." sofort
  - `setStrategy()`: UI aktualisiert Strategie-Anzeige sofort
  - Bei Fehler: Automatischer Rollback mit Toast-Notification
  - Paralleles `queryClient.invalidateQueries()` statt auf nächsten Poll zu warten

- [ ] **Visuelles Feedback während Operationen**
  - Loading-Spinner für E3DC-Operationen (~2,1s)
  - Toast-Notifications für State-Transitions
  - Progress-Indicator für Wallbox-Ramping (0 → 10kW)

**Phase 2: Mittelfristige Optimierung (4-6h)**
- [ ] **WebSocket-Integration für Push-Updates**
  - Backend-Events: `wallbox:state-changed`, `wallbox:input-changed`, `e3dc:battery-lock-changed`
  - Socket.IO oder native WebSocket implementation
  - Automatische Reconnection-Logik mit exponential backoff
  - Fallback zu Polling wenn WebSocket nicht verfügbar
  
- [ ] **Event-basierte Cache-Invalidierung**
  - Broadcast-Listener sendet Events an WebSocket-Clients
  - Frontend invalidiert nur relevante Queries (granular statt global)
  - Batch-Updates für schnelle Event-Sequenzen (z.B. State 5→2→3)

**Phase 3: Backend-Optimierung (2-3h)**
- [ ] **Parallele E3DC + Wallbox Operationen (Input=0)**
  - Beim Stoppen: Wallbox sofort `ena 0` (nicht auf E3DC warten)
  - E3DC Battery Unlock parallel (non-blocking)
  - Falls E3DC fehlschlägt: Battery Lock bleibt aktiv (Safe-by-default)
  - Reduziert Stopp-Latenz von 2,8s → ~1,0s (-64%)

- [ ] **Verbesserte Error-Recovery**
  - Retry-Logic für E3DC CLI-Befehle (max 2 Retries, 500ms delay)
  - Timeout-Handling für UDP-Befehle (aktuell fix)
  - Detailliertes Error-Logging für Debugging

**Phase 4: Frontend-Polish (1-2h)**
- [ ] **Status-Animations**
  - Smooth Transitions bei State-Wechsel (fade/slide)
  - Pulsing-Indicator während aktiver Ladung
  - Color-Transitions für Status-Badges (grün/gelb/rot)

- [ ] **Erweiterte Benutzer-Kommunikation**
  - Context-aware Toast-Messages:
    - "Batterie wird geschützt..." (während E3DC Lock)
    - "Ladung wird vorbereitet..." (während Wallbox ena 1)
    - "Auto lädt..." (State 2→3 Transition)
  - Status-Timeline im Drawer (letzte 10 Events mit Timestamps)

**Geschätzte Entwicklungszeit:** 8-13 Stunden

**Erwartete Verbesserungen:**
- **User-Aktionen (Start/Stop):** 0-5s → **< 50ms** (100x schneller)
- **Input-Broadcasts (X1):** 0-5s → **< 100ms** mit WebSocket (50x schneller)
- **E3DC Stop-Latenz:** 2,8s → **1,0s** (-64%)
- **Server-Load:** +150% bei Polling, -90% bei WebSocket

**Risiken & Mitigation:**
- **Risiko:** WebSocket-Verbindungsabbrüche → **Mitigation:** Automatische Reconnection + Polling-Fallback
- **Risiko:** Race Conditions bei Optimistic Updates → **Mitigation:** Version-basiertes Caching mit Conflict-Resolution
- **Risiko:** Erhöhter Server-Load → **Mitigation:** Rate-Limiting + Connection-Pooling

**Performance-Impact:** 
- Phase 1: +150% Polling-Load (akzeptabel für wenige Clients)
- Phase 2: -90% Traffic durch WebSocket (Push statt Poll)
- Phase 3: -64% E3DC-Wartezeit beim Stoppen

**Dependencies:**
- Socket.IO (optional, kann auch native WebSocket verwenden)
- Keine Breaking Changes für bestehende API-Clients
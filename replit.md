# EnergyLink - Entwicklungsleitfaden

## Overview
EnergyLink is a Progressive Web App (PWA) designed to control KEBA Wallbox charging stations for electric vehicles. It provides real-time status monitoring, charge control, and SmartHome integration, including automated charging based on PV surplus, night schedules, and battery lockout rules. A key feature is its integration with E3DC systems via CLI tools and Modbus TCP for battery discharge control and grid charging capabilities. The application adheres to Material Design 3 principles with a mobile-first approach, optimized for German users.

## User Preferences
Preferred communication style: Simple, everyday language.

Deployment Target: Local operation (home server/Raspberry Pi/Docker) in private network. Application communicates via HTTP in development; HTTPS not required for local-only deployment but recommended if accessible from internet.

## System Architecture

### Frontend
The frontend is built with React 18+, TypeScript, Wouter for routing, TanStack Query for state management, and shadcn/ui (Radix UI primitives) for UI components. Styling uses Tailwind CSS, customized to Material Design 3 principles with a mobile-first, responsive approach using Roboto typography. Key components include `StatusCard`, `ChargingVisualization`, and `BottomNav`. SmartHome control toggles (PV surplus, battery lock, grid charging) are integrated into the Settings page, with battery lock and grid charging controls appearing only when E3DC integration is enabled. Night charging is exclusively managed via automatic scheduler configuration. The main StatusCard displays contextual icons for active SmartHome features, and the E3DC page provides live energy monitoring data in a card-based layout similar to the Wallbox page, with 5-second auto-refresh.

### Backend
The backend, built with Express.js and TypeScript, offers a RESTful API. It utilizes a file-based storage abstraction layer for settings, wallbox status, control state, and plug tracking. E3DC integration is handled via:
1.  **CLI Tool (e3dcset):** For battery discharge lock and grid charging.
2.  **Modbus TCP (modbus-serial):** For real-time energy monitoring (PV power, battery power/SOC, house consumption, grid power, autarky, self-consumption) from E3DC S10. Includes automatic connection recovery.
3.  **Unified Mock Server:** Auto-starts in demo mode (DEMO_AUTOSTART=true or demoMode=true) simulating KEBA Wallbox (UDP 7090), E3DC S10 (Modbus TCP 5502), and FHEM (HTTP 8083) in a single process. Provides realistic simulated data for development/showcase. Cleanly shuts down when not needed in production mode.
The backend also tracks cable status changes during wallbox polling.

### Data Storage
The system uses file-based persistence, storing `WallboxStatus`, `Settings`, `ControlState`, and `PlugStatusTracking` in JSON files for state persistence. Drizzle ORM is configured for PostgreSQL with Neon Serverless, but file-based storage is currently active. The `ControlState` schema includes flags for `pvSurplus`, `nightCharging` (read-only), `batteryLock`, and `gridCharging`. Schemas are defined with Zod for runtime validation and type safety.

### Key Architectural Decisions
- **Separation of Concerns**: Shared schema definitions for type safety.
- **File-based Persistency**: Settings, control state, and plug tracking are stored in JSON files.
- **Storage Abstraction**: Flexible persistence strategy with backward compatibility.
- **Mobile-First PWA**: Optimized for touch devices.
- **Webhook Integration**: For external SmartHome systems (e.g., FHEM for PV surplus).
- **E3DC-Only Battery Control**: Battery discharge locking and grid charging are managed exclusively via E3DC CLI, with UI controls appearing conditionally.
- **Type Safety**: Zod schemas for validation.
- **Security-First Logging**: CLI output sanitization.
- **Visual Status Feedback**: Icon-based status indicators for active SmartHome features.
- **Fixed Timezone**: Europe/Berlin for all time-based operations.
- **Optimistic UI**: With refetch-on-mount for data consistency.
- **Backend-Driven Status Tracking**: Cable status changes detected and persisted by the backend.
- **Settings Page Organization**: Logical grouping and positioning of critical settings.
- **Auto-Start Mock Server**: Unified mock server (`server/unified-mock.ts`) auto-starts when `DEMO_AUTOSTART=true` environment variable is set OR `demoMode=true` in settings. Exports `startUnifiedMock()` / `stopUnifiedMock()` functions for programmatic control. Graceful shutdown ensures clean Autoscale deployments.
- **Demo/Production Split**: Mock server only binds ports (7090, 5502, 8083) in demo mode. Production mode keeps ports free for real hardware. UDP client uses ephemeral port in demo mode to avoid conflicts.
- **Season-Aware PV Simulation**: The E3DC mock service (`server/e3dc-mock.ts`) uses Europe/Berlin timezone for all time-based calculations, ensuring accurate PV power generation curves that match local sun hours and seasonal variations (e.g., November: 7:30-16:30, 3.5kW peak).
- **Atomic Mock Data Snapshots**: The unified mock server uses a promise-based lock mechanism to ensure all Modbus register reads within a single request use the same cached energy data snapshot, preventing race conditions from random variations in calculateHousePower() and ensuring consistent energy balance (housePower = gridPower when battery/PV are zero).
- **Realistic Household Consumption**: The mock server simulates typical household power consumption with 400-600W baseline and time-based peaks: mornings 7-9h (800-1200W for hair dryer, breakfast), midday 12-14h (800-1200W for cooking), evenings 18-20h (700-1000W for cooking, TV), and nights 22-6h (300-500W minimal load). Battery discharges at 100% of PV deficit (up to 3kW limit) when battery lock is disabled.
- **Autoscale-Ready**: Single-process architecture with auto-start mock server enables Replit Autoscale deployment (~$3-6/month) for demo/showcase purposes. Production deployments run locally without mock services.

## External Dependencies
-   **UI Components**: shadcn/ui (New York style), Radix UI Primitives, Lucide React (icons).
-   **Styling & Build Tools**: Tailwind CSS, PostCSS, Vite, esbuild.
-   **State Management & Data Fetching**: TanStack Query v5, React Hook Form with Zod Resolvers.
-   **Database & ORM**: Drizzle ORM, @neondatabase/serverless (PostgreSQL), drizzle-zod (currently using file-based persistence).
-   **SmartHome Integration**:
    *   **E3DC**: CLI tool (e3dcset) and `modbus-serial` library for Modbus TCP.
    *   **FHEM**: Webhook-based integration.
    *   **KEBA Wallbox**: Direct UDP/HTTP API communication.
-   **Development Tools**: Replit-specific plugins, TypeScript Strict Mode, path aliases.
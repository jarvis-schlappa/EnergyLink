# EnergyLink - Compressed Guide

## Overview
EnergyLink is a PWA designed to control KEBA Wallbox charging stations, offering real-time monitoring, charge control, and SmartHome integration. Key features include automated charging based on PV surplus, night schedules, and battery lockout rules, with specific integration for E3DC systems via CLI tools and Modbus TCP for battery and grid control. The application prioritizes a mobile-first, Material Design 3 approach for German users.

## User Preferences
Preferred communication style: Simple, everyday language.

Deployment Target: Local operation (home server/Raspberry Pi/Docker) in private network. Application communicates via HTTP in development; HTTPS not required for local-only deployment but recommended if accessible from internet.

## System Architecture
EnergyLink is a PWA with a mobile-first, responsive design adhering to Material Design 3 principles and Roboto typography.

### Frontend
The frontend is built with React 18+, TypeScript, Wouter for routing, TanStack Query for state management, and shadcn/ui (Radix UI primitives) for components, styled with Tailwind CSS. It features `StatusCard`, `ChargingVisualization`, `BottomNav`, and a Settings page with SmartHome controls (PV surplus, battery lock, grid charging) that conditionally display E3DC-specific options. A dedicated E3DC page provides live energy monitoring with auto-refresh, and a demo mode is available for testing.

### Backend
The backend utilizes Express.js and TypeScript, providing a RESTful API. It employs a file-based storage layer for settings, wallbox status, control state, and plug tracking. E3DC integration is managed via `e3dcset` CLI tools for battery control and `modbus-serial` for Modbus TCP real-time monitoring. A unified mock server simulates KEBA Wallbox, E3DC S10, and FHEM for development. The backend also tracks and persists cable status changes via a UDP broadcast listener.

### Data Storage
Persistence for `WallboxStatus`, `Settings`, `ControlState`, and `PlugStatusTracking` is handled through JSON files. Drizzle ORM is configured for PostgreSQL but not actively used. Zod schemas ensure runtime validation and type safety.

### Key Architectural Decisions
-   **Separation of Concerns**: Achieved through shared schema definitions.
-   **File-based Persistency**: Settings, control state, plug tracking, and charging context are stored in JSON files.
-   **Storage Abstraction**: Provides flexibility and backward compatibility for persistence.
-   **Mobile-First PWA**: Optimized for touch devices.
-   **Webhook Integration**: Supports external SmartHome systems like FHEM for PV surplus.
-   **E3DC-Only Battery Control**: Battery discharge locking and grid charging are exclusively managed via E3DC CLI.
-   **Type Safety**: Ensured by Zod schemas for validation.
-   **Security-First Logging**: CLI output is sanitized.
-   **Visual Status Feedback**: Icon-based indicators for active SmartHome features.
-   **Fixed Timezone**: All time-based operations use Europe/Berlin.
-   **Optimistic UI**: Implemented with refetch-on-mount for data consistency.
-   **Backend-Driven Status Tracking**: Cable status changes are detected and persisted by the backend via a UDP broadcast listener.
-   **Broadcast-Handler Architecture**: Real-time processing of Wallbox UDP broadcasts for various inputs.
-   **Unified Mock Server**: Auto-starts in demo mode, providing realistic simulations for E3DC and household consumption, ready for Replit Autoscale.
-   **Internal PV Surplus Charging**: Features four configurable charging strategies with automatic phase switching.
-   **Potenzialfreier Kontakt (X1) Integration**: Configurable strategy selection via UDP broadcast handler.
-   **Single-Socket UDP Architecture**: Centralized `wallboxUdpChannel` for KEBA communication.
-   **FHEM TCP Mock Server**: Included in the unified mock for logging incoming commands.
-   **Prowl Push Notifications**: Fire-and-forget notification system with 7 configurable events and API key storage in settings.json.
-   **Event-Driven Charging Strategy**: Uses an event-driven controller with an event queue and promise tracking for immediate reaction to E3DC data and graceful shutdowns. A 15-second fallback timer acts as a health check.

## External Dependencies
-   **UI Components**: shadcn/ui (New York style), Radix UI Primitives, Lucide React (icons).
-   **Styling & Build Tools**: Tailwind CSS, PostCSS, Vite, esbuild.
-   **State Management & Data Fetching**: TanStack Query v5, React Hook Form with Zod Resolvers.
-   **Database & ORM**: Drizzle ORM, @neondatabase/serverless (PostgreSQL) - currently using file-based persistence.
-   **SmartHome Integration**:
    *   **E3DC**: CLI tool (`e3dcset`) and `modbus-serial` library for Modbus TCP.
    *   **FHEM**: Bidirectional integration via webhooks and TCP socket.
    *   **KEBA Wallbox**: Direct UDP/HTTP API communication.
    *   **Prowl**: Push notification service via prowlapp.com API.
-   **Development Tools**: Replit-specific plugins, TypeScript Strict Mode, path aliases.
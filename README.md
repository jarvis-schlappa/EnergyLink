# EnergyLink

[![CI](https://github.com/mschlappa/EnergyLink/actions/workflows/ci.yml/badge.svg)](https://github.com/mschlappa/EnergyLink/actions)
![Version](https://img.shields.io/badge/version-2.0.2-blue)
![Lizenz](https://img.shields.io/badge/license-MIT-green)

Intelligente Wallbox-Steuerung für KEBA Ladestationen mit E3DC S10 Integration. Optimiert das Laden Ihres Elektrofahrzeugs mit PV-Überschuss, zeitgesteuerten Ladefenstern und SmartHome-Anbindung – als Progressive Web App direkt vom Smartphone.

## Screenshots

| Wallbox Status | E3DC Monitoring | Ladestrategien | Einstellungen |
|:-:|:-:|:-:|:-:|
| ![Status](docs/screenshots/status-seite.png) | ![E3DC](docs/screenshots/e3dc-seite.png) | ![Strategie](docs/screenshots/charging-strategy-surplus.jpeg) | ![Settings](docs/screenshots/settings-demo.jpeg) |

## Features

- ⚡ **4 Ladestrategien** – PV-Überschuss (Batterie/Fahrzeug priorisiert), Maximum (mit/ohne Batterie)
- 🔋 **E3DC S10 Integration** – Live-Monitoring via Modbus TCP, Batteriesteuerung via CLI
- ⏰ **Zeitgesteuerte Ladung** – Nachtstrom-Tarife automatisch nutzen
- 📊 **Echtzeit-Dashboard** – Ladeleistung, PV, Batterie-SOC, Netzfluss
- 🏡 **SmartHome** – FHEM-Sync, potenzialfreier Kontakt (X1), Prowl-Benachrichtigungen
- 🔔 **Push-Benachrichtigungen** – Native Browser-Push (PWA) + Prowl, konfigurierbare Events
- 🔒 **HTTPS/TLS** – Optionales TLS für sicheren LAN-Zugriff (Tailscale / mkcert)
- 🚗 **Garagentor** – FHEM-Integration mit Auto-Close bei Kabel-Einstecken
- 📱 **PWA** – Installierbar, Touch-optimiert, Push-Benachrichtigungen

## Quick Start

```bash
git clone https://github.com/mschlappa/EnergyLink.git && cd EnergyLink
```

### Docker

```bash
docker-compose up -d
# App öffnen: http://localhost:3000
```

### Bare Metal

```bash
npm install && npm run build
NODE_ENV=production node dist/index.js
# App öffnen: http://localhost:3000
```

## Dokumentation

| Dokument | Inhalt |
|----------|--------|
| [Getting Started](docs/getting-started.md) | Installation, Deployment, PWA-Setup |
| [Konfiguration](docs/configuration.md) | Settings, E3DC, FHEM, Strategieparameter |
| [Ladestrategien](docs/charging-strategies.md) | Die 4 Strategien im Detail |
| [Architektur](docs/architecture.md) | Systemaufbau, Interfaces, Tests |
| [Use Cases](docs/use-cases.md) | Praxisszenarien mit Event-Flows |
| [Design Guidelines](docs/design-guidelines.md) | UI/UX-Richtlinien |
| [Garagentor](docs/garage-integration.md) | FHEM-basierte Garagentor-Steuerung |
| [FAQ](docs/faq.md) | Häufige Fragen |

## Technologie

**Frontend:** React 18, TypeScript, Vite, TanStack Query, shadcn/ui, Tailwind CSS  
**Backend:** Node.js, Express, Modbus TCP, UDP (KEBA), Zod-Validierung  
**Tests:** 690+ Tests (Vitest + Supertest), CI via GitHub Actions

## Lizenz

MIT – Nutzung auf eigene Verantwortung. Siehe [LICENSE](LICENSE).

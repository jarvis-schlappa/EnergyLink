# EnergyLink

[![CI](https://github.com/jarvis-schlappa/EnergyLink/actions/workflows/ci.yml/badge.svg)](https://github.com/jarvis-schlappa/EnergyLink/actions)
![Version](https://img.shields.io/badge/version-1.0.2-blue)
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
- 📱 **PWA** – Installierbar, Touch-optimiert, offline-fähig

## Quick Start

### Docker

```bash
docker-compose up -d
# App öffnen: http://localhost:5000
```

### Bare Metal

```bash
git clone https://github.com/jarvis-schlappa/EnergyLink.git && cd EnergyLink
npm install && npm run build
NODE_ENV=production node dist/index.js
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
| [FAQ](docs/faq.md) | Häufige Fragen |
| [Contributing](CONTRIBUTING.md) | Mitarbeit am Projekt |

## Technologie

**Frontend:** React 18, TypeScript, Vite, TanStack Query, shadcn/ui, Tailwind CSS  
**Backend:** Node.js, Express, Modbus TCP, UDP (KEBA), Zod-Validierung  
**Tests:** 185 Tests (Vitest + Supertest), CI via GitHub Actions

## Lizenz

MIT – Nutzung auf eigene Verantwortung. Siehe [LICENSE](LICENSE).

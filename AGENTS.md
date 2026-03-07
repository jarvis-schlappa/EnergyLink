# AGENTS.md – EnergyLink

## Projekt

EnergyLink – Intelligente Wallbox-Steuerung (KEBA) mit E3DC S10 Integration.
**Stack:** React 18 + TypeScript + Vite (Frontend), Node.js + Express (Backend), Zod, Tailwind, shadcn/ui.

## Repo-Struktur

```
client/src/         → React Frontend (Pages, Components, Hooks)
server/             → Express Backend (Routes, Core, Strategy, E3DC, Wallbox, FHEM)
shared/schema.ts    → Zod-Schemas (shared zwischen Client & Server)
data/               → Runtime-Daten (settings.json, etc.)
docs/               → Dokumentation
```

## Git-Workflow

- **Upstream:** `origin` → `mschlappa/EnergyLink` (kein Push-Zugang)
- **Fork:** `fork` → `jarvis-schlappa/EnergyLink` (Push hierüber)
- **Branching:** Feature-Branch pro Issue: `feature/issue-<NR>-kurzbeschreibung`
- **Commit-Messages:** `fixes #<NR>: kurze beschreibung` (englisch oder deutsch ok)
- **PRs:** Gegen `mschlappa/EnergyLink` main, von `jarvis-schlappa/EnergyLink` Feature-Branch
- **Push:** `git push fork <branch-name>`
- ⚠️ **NIE direkt auf main pushen!**

## PR erstellen

```bash
GH_TOKEN=$(cat ~/.openclaw/.github-token) gh pr create \
  --repo mschlappa/EnergyLink \
  --head jarvis-schlappa:<branch> \
  --base main \
  --title "..." \
  --body "..."
```

## Code-Konventionen

- TypeScript strict, Zod für Validierung
- Tests mit Vitest (`npm run test`)
- Type-Check mit `npm run check`
- Bestehenden Code-Style respektieren – nicht "verbessern" was nicht zum Issue gehört
- Minimale Änderungen: nur was das Issue verlangt
- Tests schreiben/anpassen wenn Logik geändert wird

## CI

GitHub Actions: TypeScript Check → Tests → Build (Node 20, ubuntu-latest)
Vor dem PR sicherstellen: `npm run check && npm run test && npm run build`

## Wichtige Dateien

- `shared/schema.ts` – Alle Zod-Schemas und Types
- `server/strategy/smart-buffer-controller.ts` – Smart-Akku Logik
- `server/strategy/charging-strategy-controller.ts` – Lade-Strategien
- `server/core/storage.ts` – JSON-Persistenz (settings.json)
- `client/src/pages/StatusPage.tsx` – Haupt-Dashboard
- `data/settings.json` – Runtime-Konfiguration (NICHT committen mit echten Werten!)

## Sicherheit

- **Keine echten Koordinaten, IPs, Tokens oder Passwörter committen!**
- `data/settings.json` enthält Platzhalter/Defaults im Repo
- Echte Werte werden auf dem Deployment-Target manuell gesetzt

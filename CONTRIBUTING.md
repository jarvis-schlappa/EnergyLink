# Contributing

Vielen Dank für Ihr Interesse an EnergyLink! Hier erfahren Sie, wie Sie zum Projekt beitragen können.

## Development Setup

```bash
git clone https://github.com/mschlappa/EnergyLink.git
cd EnergyLink
npm install
npm run dev          # Startet Dev-Server (Frontend + Backend)
```

Die App läuft dann unter `http://localhost:5000`. Im Demo-Modus werden Wallbox, E3DC und FHEM simuliert.

## Code Style

- **Sprache:** TypeScript (strict mode)
- **Frontend:** React 18, TanStack Query, shadcn/ui, Tailwind CSS
- **Backend:** Express.js, Zod für Validierung
- **Linting:** ESLint-Konfiguration im Projekt
- **Formatierung:** Bestehenden Stil beibehalten

## Tests

```bash
npm test             # Alle 185 Tests ausführen (Vitest)
npm run test:watch   # Watch-Modus
```

- Tests liegen in `server/__tests__/`
- Neue Features brauchen Tests
- CI muss grün sein vor Merge

## PR-Workflow

1. **Fork** erstellen und klonen
2. **Feature-Branch** anlegen: `git checkout -b feature/beschreibung`
3. **Implementieren** – minimal, sauber, mit Tests
4. **Lokal testen:** `npm test`
5. **Push:** `git push -u origin feature/beschreibung`
6. **Pull Request** erstellen mit:
   - Aussagekräftigem Titel: `feat/fix/docs: Beschreibung`
   - Beschreibung: Was, warum, wie verifiziert
   - Referenz auf Issue (falls vorhanden)

## Commit-Konventionen

```
feat: Neue Funktion
fix: Bugfix
docs: Dokumentation
test: Tests
refactor: Refactoring ohne Funktionsänderung
```

## Projektstruktur

```
├── client/          # React Frontend
├── server/          # Express Backend
│   ├── __tests__/   # Testdateien
│   └── routes/      # API-Routen
├── shared/          # Geteilte Typen & Schemas
├── docs/            # Dokumentation
└── data/            # Persistierte Daten (JSON)
```

## Richtlinien

- **Deutsch** für UI-Texte und Dokumentation, Englisch für Code
- **Einfachheit:** Minimum Code, keine spekulativen Features
- **Chirurgische Änderungen:** Nur das ändern, was nötig ist
- Keine direkten Pushes auf `main`

## Weiterführend

- [Architektur](docs/architecture.md) – Technischer Überblick
- [Design Guidelines](docs/design-guidelines.md) – UI/UX-Richtlinien

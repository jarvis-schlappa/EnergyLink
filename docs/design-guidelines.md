# Design Guidelines

UI/UX-Richtlinien für EnergyLink, basierend auf Material Design 3.

## Design-Prinzipien

1. **Klarheit zuerst** – Status muss sofort erfassbar sein
2. **Touch-optimiert** – Alle interaktiven Elemente mindestens 48px Tippfläche
3. **Datenhierarchie** – Kritische Informationen (Ladestatus, Leistung) am prominentesten
4. **Konsistentes Feedback** – Klare visuelle Bestätigung für alle Aktionen
5. **Deutsche Sprache** – Alle Labels und Texte auf Deutsch

## Typografie

**Schriftart:** Roboto (Google Fonts CDN), Gewichte: 400, 500, 700

| Verwendung | Größe | Gewicht |
|-----------|-------|---------|
| Seitenüberschriften | 24px (text-2xl) | Bold |
| Abschnittsüberschriften | 20px (text-xl) | Medium |
| Statuswerte (kW, A) | 30px (text-3xl) | Bold |
| Fließtext | 16px (text-base) | Normal |
| Labels | 14px (text-sm) | Medium |
| Hilfstext | 12px (text-xs) | Normal |

## Layout

- **Container:** max-w-2xl (optimiert für Mobile/Tablet)
- **Spacing:** Tailwind-Einheiten 2, 4, 6, 8
- **Karten-Padding:** p-6, rounded-xl
- **Seitenpadding:** px-4

## Komponenten

### Navigation
- Bottom Tab Bar, fixiert (64px Höhe)
- Icons mit Textlabel darunter
- Aktiver Tab visuell hervorgehoben

### Status-Dashboard
- Große Status-Karte mit Icon + Statustext
- Prominente Kennzahlen (kW, A) in text-3xl
- Auto-Refresh-Anzeige unten

### Einstellungen
- Gruppierte Formulare mit Abschnittsüberschriften
- Eingabefelder: h-12, rounded-lg, volle Breite
- Akkordion-Pattern für erweiterte Parameter

### Feedback
- Erfolgs-Toasts (3s Auto-Dismiss)
- Inline-Fehlermeldungen unter Eingabefeldern
- Retry-Button bei Verbindungsfehlern

## Animationen

Minimal gehalten:
- Toggle-Übergänge: 200ms ease
- Seitenwechsel: Fade/Slide 150ms
- Lade-Indikator: Subtiler Pulse

## Mobile-First / PWA

- Single-Page-App mit Tab-Navigation
- Sticky Header, fixierte Bottom-Navigation
- Korrekte Keyboard-Typen (number, url)
- Touch-Feedback auf allen tippbaren Elementen
- App-Icons: 192px + 512px
- Offline-Banner bei fehlender Verbindung

---

## Weiterführend

- [Architektur](architecture.md) – Technischer Aufbau
- [FAQ](faq.md) – Häufige Fragen

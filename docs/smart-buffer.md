# Smart Buffer

Diese Seite beschreibt das Laufzeitverhalten der Strategie `smart_buffer`.
Die ausführliche Produktdoku liegt in [smart-akku.md](./smart-akku.md).

## Steuerungsprinzip

1. Smart Buffer berechnet pro Zyklus das gewünschte Batterie-Limit und setzt es über E3DC.
2. Danach läuft die normale Wallbox-Surplus-Logik des `ChargingStrategyController`.
3. Die Wallbox wird wie bei den anderen Surplus-Strategien über `ena 1`, `curr <mA>` und `ena 0` gesteuert.

## Phasen und Wallbox

- `MORNING_HOLD`: Überschussladen aktiv, wenn genug PV-Überschuss vorhanden ist.
- `CLIPPING_GUARD`: voller Überschuss für Fahrzeugladung, Abregelverluste werden priorisiert reduziert.
- `FILL_UP`: Überschussladen aktiv; Akku-Vorrang wird über das Smart-Buffer-Batterie-Limit abgebildet.
- `FULL` / `STANDBY`: normales Überschussverhalten der Wallbox.

# Grid Frequency Modbus Register Fix

**Datum:** 2026-02-24
**Status:** Offen – Fix noch nicht eingespielt

## Problem

Die Netzfrequenz wird nicht mehr korrekt aus dem E3DC S10 ausgelesen. Das Frontend zeigt 0 Hz oder unsinnige Werte (~3.85 Hz).

## Ursache

E3DC hat mit einem automatischen Firmware-Update (vermutlich im Lauf von 2025) das undokumentierte Modbus-Register für die Netzfrequenz verschoben:

| | Alt (kaputt) | Neu (korrekt) |
|---|---|---|
| **Holding Register** | 41026 | 41024 |
| **0-basierter Offset** | 1025 | 1023 |

Das Register ist nicht Teil der offiziellen E3DC Modbus-Dokumentation (zumindest nicht bis v1.70). Deshalb gab es keinen Changelog-Eintrag.

## Verifizierung

Direkte Modbus-Abfrage am 2026-02-24 gegen `192.168.40.200:502`:

```
Offset 1025 (HR 41026, aktuell im Code): Raw=385  → 3.85 Hz  ❌ FALSCH
Offset 1023 (HR 41024, korrekt):         Raw=4998 → 49.98 Hz ✅ RICHTIG
```

5 aufeinanderfolgende Messungen auf Offset 1023 lieferten stabile 49.98 Hz.

## Firmware

- **Aktuell:** S10_2025_404
- **Gerät:** S10-491834000891 (KW34 2018)
- Updates kommen automatisch, kein genaues Datum des Updates bekannt

## Fix

**Datei:** `server/e3dc/modbus.ts`, Zeile ~25

```diff
- GRID_FREQUENCY: 1025,      // Holding Register 41026
+ GRID_FREQUENCY: 1023,      // Holding Register 41024
```

Kommentar im Code ebenfalls anpassen:
```diff
- GRID_FREQUENCY: 1025,      // Holding Register 41026 (0-basiert: 41026 - 40001 = 1025), UINT16, Hz × 100
+ GRID_FREQUENCY: 1023,      // Holding Register 41024 (0-basiert: 41024 - 40001 = 1023), UINT16, Hz × 100
```

## Empfehlung

Da E3DC undokumentierte Register ohne Vorwarnung verschieben kann, wäre ein Plausibilitäts-Check sinnvoll: Wenn der gelesene Wert nicht zwischen 4500–5500 liegt (45–55 Hz), benachbarte Register scannen oder den Wert verwerfen.

# Status Layer – Architektur & Cache-Invalidierung

## Übersicht

EnergyLink hat keinen zentralen StatusStore. Stattdessen gibt es verteilte Zustandsquellen,
die über Events und Polling synchronisiert werden. Diese Entscheidung ist bewusst (siehe
[Issue #76](https://github.com/mschlappa/EnergyLink/issues/76) für die Abwägung).

## Dependency-Graph

```
┌─────────────────────┐
│   KEBA Wallbox      │ ◄── UDP Port 7090
│   (Hardware)        │
└────────┬────────────┘
         │ UDP Broadcasts (Plug, State, E pres, Input)
         │ UDP Reports (report 1/2/3)
         ▼
┌─────────────────────────────────────────────────────────┐
│                  broadcast-listener.ts                   │
│                                                         │
│  Empfängt:  UDP Broadcasts (Push, ~Echtzeit)            │
│  Schreibt:  lastPlugStatus, lastState, lastEpres        │
│  Exportiert: getAuthoritativePlugStatus()               │
│  Ruft auf:  invalidateWallboxCaches() bei Änderung      │
│             broadcastPartialUpdate() → SSE an Frontend  │
│             fetchAndBroadcastStatus() → voller Status   │
└──────────────────────┬──────────────────────────────────┘
                       │
                       ▼
┌─────────────────────────────────────────────────────────┐
│              cache-invalidation.ts                       │
│                                                         │
│  invalidateWallboxCaches() bündelt:                      │
│    ├── resetStatusPollThrottle()  (wallbox-routes.ts)    │
│    └── resetWallboxIdleThrottle() (poller.ts)            │
└─────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────┐
│               wallbox-routes.ts                          │
│                                                         │
│  Cache:     lastCachedStatus, lastStatusPollTime         │
│  Zweck:     /api/wallbox/status Throttle (30s im Idle)   │
│  Reset:     resetStatusPollThrottle() → Timestamp=0      │
│  Aufrufer:  invalidateWallboxCaches()                    │
│  Liest:     getAuthoritativePlugStatus() für Plug-Wert   │
└─────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────┐
│                    poller.ts                              │
│                                                         │
│  Cache:     lastWallboxPollTime, lastWallboxPower        │
│  Zweck:     Wallbox-Abfrage im E3DC-Poll überspringen    │
│             wenn idle (kein Laden, keine Änderung)        │
│  Reset:     resetWallboxIdleThrottle() → sofort pollen   │
│  Aufrufer:  invalidateWallboxCaches()                    │
└─────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────┐
│         charging-strategy-controller.ts                  │
│                                                         │
│  Liest:    getAuthoritativePlugStatus() für Plug-Status  │
│  Liest:    report 2/3 via reconcileChargingContext()     │
│  Schreibt: ChargingContext (via storage)                 │
│  Kein eigener Plug-Cache (nutzt broadcast-listener)      │
└─────────────────────────────────────────────────────────┘
```

## Wer schreibt State, wer liest ihn

| Zustand | Geschrieben von | Gelesen von |
|---|---|---|
| Plug-Status (autoritativ) | `broadcast-listener.ts` (In-Memory `lastPlugStatus`) | `getAuthoritativePlugStatus()` → Controller, Routes |
| Wallbox State/E pres | `broadcast-listener.ts` (In-Memory) | SSE → Frontend |
| ChargingContext | `charging-strategy-controller.ts` (via `storage`) | Routes, Frontend |
| Status-Poll-Cache | `wallbox-routes.ts` (`lastCachedStatus`) | `/api/wallbox/status` Endpoint |
| Idle-Throttle | `poller.ts` (`lastWallboxPollTime`) | E3DC-Poller (entscheidet ob Wallbox abgefragt wird) |

## Caches und ihre Invalidierung

| Cache | Modul | Invalidiert durch | Wann |
|---|---|---|---|
| `lastCachedStatus` | `wallbox-routes.ts` | `resetStatusPollThrottle()` | State-/Strategie-Änderung |
| `lastStatusPollTime` | `wallbox-routes.ts` | `resetStatusPollThrottle()` | State-/Strategie-Änderung |
| `lastWallboxPollTime` | `poller.ts` | `resetWallboxIdleThrottle()` | State-/Strategie-Änderung |
| `lastPlugStatus` | `broadcast-listener.ts` | Direkt via UDP-Broadcast | Echtzeit (kein manueller Reset nötig) |

**Zentrale Funktion:** `invalidateWallboxCaches()` (aus `cache-invalidation.ts`) bündelt
`resetStatusPollThrottle()` und `resetWallboxIdleThrottle()`. Wird aufgerufen bei:
- State-Änderung (Broadcast)
- Input/X1-Strategie-Wechsel (Broadcast)
- Manueller Start/Stopp (API-Routes)

## Warum kein zentraler StatusStore

Ein zentraler Store würde:
1. Zirkuläre Dependencies erzeugen (Poller → Store → Controller → Poller)
2. Timing-Probleme verschleiern (wann ist welcher Wert gültig?)
3. Die klare Ownership von State aufweichen

Stattdessen: Jedes Modul ownt seinen State, Invalidierung läuft über einen schlanken
Wrapper (`invalidateWallboxCaches`). Siehe [Issue #76](https://github.com/mschlappa/EnergyLink/issues/76).

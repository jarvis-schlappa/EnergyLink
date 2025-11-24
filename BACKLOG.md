# EnergyLink - Feature Backlog

Dieses Dokument sammelt geplante Features, Verbesserungen und Ideen für zukünftige Entwicklungen.

---

## 🔥 High Priority Features

### 1. 🌤️ PV-Prognose + Intelligenter Lade-Planer

**Status:** 📋 Planned  
**Coolness:** ⭐⭐⭐⭐⭐ (5/5)  
**Aufwand:** 🕐🕐🕐 (3-4 Tage MVP, 7-10 Tage Full Feature)

#### Beschreibung
Wetterbasierte PV-Vorhersage integriert sich in die App und schlägt automatisch optimale Ladezeiten vor. Nutzt kostenlose APIs wie Forecast.Solar oder Open-Meteo, um 48h-Prognosen zu erstellen und damit PV-Überschuss vorherzusagen.

#### Kernfunktionen

**MVP (Phase 1 - 3-4 Tage):**
- ✅ PV-Prognose für 48 Stunden
- ✅ Forecast.Solar API Integration (kostenlos, kein API Key)
- ✅ Visualisierung: Chart mit erwarteter PV-Leistung
- ✅ Settings: PV-Anlagen-Konfiguration (kWp, Azimuth, Tilt, Koordinaten)
- ✅ Backend Service mit 1h Caching

**Phase 2 - Smart Planner (2-3 Tage):**
- ✅ Automatische Berechnung optimaler Ladezeiten
- ✅ Berücksichtigung: Hausverbrauch, E3DC-Batterie, Wallbox-Limits
- ✅ UI: Empfehlungskarten mit "Ladung planen" Button
- ✅ Integration mit bestehendem Scheduler
- ✅ Persistenz: Geplante Ladezeiten speichern

**Phase 3 - Automation (2 Tage):**
- ✅ Auto-Modus: "Immer PV-optimal laden"
- ✅ Push-Benachrichtigungen: "Morgen viel Sonne → Jetzt nicht laden!"
- ✅ Kostenberechnung & Einsparungen-Tracking
- ✅ Wetter-Icons & visuell ansprechende Darstellung
- ✅ Historische Analyse: "Diesen Monat 47€ durch PV-Optimierung gespart"

**Phase 4 - Premium Features (optional, 3-4 Tage):**
- ⭐ Solcast Integration (höhere Genauigkeit, 10 Calls/Tag)
- ⭐ Dynamische Stromtarife (Tibber/aWATTar API)
- ⭐ ML-basierte Hausverbrauch-Prognose
- ⭐ Multi-Standort Support

#### Technische Details

**APIs:**
| API | Free Tier | Calls/Tag | API Key | Genauigkeit |
|-----|-----------|-----------|---------|-------------|
| Forecast.Solar | ✅ Unbegrenzt | ∞ | ❌ Nicht nötig | ⭐⭐⭐ |
| Solcast | ✅ Home nur | 10 | ✅ Ja | ⭐⭐⭐⭐⭐ |
| Open-Meteo | ✅ Unbegrenzt | 10.000 | ❌ Nicht nötig | ⭐⭐⭐⭐ |

**Empfohlener Start:** Forecast.Solar (einfach, kostenlos, keine Registrierung)

**Backend:**
```typescript
// server/pv-forecast.ts
interface PVForecast {
  timestamp: string;
  pvPowerWatt: number;
  pvEnergyWh: number;
  confidence: number;
  weather: string;
}

interface ChargingRecommendation {
  startTime: string;
  endTime: string;
  expectedPVEnergy: number;
  gridEnergyNeeded: number;
  estimatedCost: number;
  savingsVsGrid: number;
}
```

**Frontend:**
- Neue Seite: "PV-Prognose"
- Chart Library: Recharts (bereits vorhanden)
- Widgets: Kompakte Prognose-Kachel auf Startseite
- Notifications: Web Push API

**Schema-Erweiterungen:**
```typescript
// shared/schema.ts
export const pvSystemConfigSchema = z.object({
  enabled: z.boolean(),
  capacityKwp: z.number().min(1).max(100),
  azimuth: z.number().min(0).max(360),  // 180 = Süd
  tilt: z.number().min(0).max(90),      // 35° = typisch
  latitude: z.number(),
  longitude: z.number(),
});
```

#### Nutzen

**Für User:**
- 💰 **Kostenersparnis:** "27€ gespart diesen Monat durch PV-Optimierung"
- 🎯 **Komfort:** App plant automatisch → Kein manuelles Eingreifen nötig
- 🌱 **Ökologisch:** Maximiert Eigenverbrauch = weniger Netzstrom
- 📊 **Transparenz:** User versteht sein Energiesystem besser

**Use Cases:**
- Urlaubsplanung: "Nächste Woche schlechtes Wetter → Vor Abreise vollladen"
- Dynamische Planung: Kombiniert PV-Prognose + Strompreise
- Batterie-Optimierung: Plant E3DC-Entladung für Wallbox bei wenig PV
- Multi-Auto Haushalte: Verteilt PV-Überschuss intelligent auf mehrere Fahrzeuge

#### Beispiel-Szenario
```
Montag, 25.11.2024 - 19:30 Uhr
─────────────────────────────────
📊 PV-Prognose Morgen:
   08:00-10:00  →  2.1 kWh  ☁️ (bewölkt)
   10:00-14:00  → 12.4 kWh  ☀️ (sonnig!)
   14:00-16:00  →  3.8 kWh  ⛅ (teils bewölkt)

💡 Empfehlung:
   "Starte Überschussladung morgen 10:00 Uhr
    → Erwartete PV-Ladung: ~10 kWh (kostenlos!)"

🔋 Dein Auto braucht noch 15 kWh → Empfehlung:
   - 10 kWh via PV-Überschuss (Mo 10-14 Uhr)
   - 5 kWh Nachtladung (heute 22:00)
   
💰 Ersparnis: 3,50€ vs. vollständige Netzladung
```

#### Abhängigkeiten
- Keine kritischen Abhängigkeiten
- Optional: Solcast API Key (falls höhere Genauigkeit gewünscht)
- Optional: Dynamische Stromtarif APIs (Tibber, aWATTar)

#### Offene Fragen
- Soll ML-basierte Hausverbrauch-Prognose implementiert werden?
- Multi-Wallbox Support bereits einplanen?
- Soll historische Genauigkeit der Prognosen getrackt werden?

---

## 🎨 Medium Priority Features

### 2. 🎨 Animierter Energiefluss-Diagram

**Status:** 📋 Planned  
**Coolness:** ⭐⭐⭐⭐⭐ (5/5)  
**Aufwand:** 🕐🕐 (2-3 Tage)

#### Beschreibung
Live-Animation zeigt Energiefluss PV→Batterie→Haus→Wallbox mit fließenden Partikeln und modernen Animationen. Ähnlich wie Tesla Powerwall App.

#### Technische Umsetzung
- Framer Motion für Animationen
- SVG-basierte Darstellung
- Echtzeit-Updates via bestehende E3DC-Daten
- Responsive Design für Mobile + Desktop

---

### 3. 💰 Kosten-Dashboard & Einsparungen

**Status:** 📋 Planned  
**Coolness:** ⭐⭐⭐⭐ (4/5)  
**Aufwand:** 🕐🕐 (1-2 Tage)

#### Beschreibung
Visualisiert konkrete Zahlen:
- "Diesen Monat 47€ gespart"
- "PV-Eigenverbrauch: 127 kWh"
- "Netz-Bezug vermieden: 89€"
- Monatliche Reports & Jahresübersicht

#### Features
- Recharts Diagramme (bereits vorhanden)
- Konfigurierbarer Strompreis (ct/kWh)
- Export als PDF/CSV
- Vergleich: Vormonat, Vorjahr

---

### 4. 📱 Web Push-Benachrichtigungen

**Status:** 📋 Planned  
**Coolness:** ⭐⭐⭐⭐ (4/5)  
**Aufwand:** 🕐🕐 (2 Tage)

#### Beschreibung
Erweitert bestehende Prowl-Benachrichtigungen um Web Push API:
- "🔌 Ladung abgeschlossen (45 kWh)"
- "⚠️ Netzfrequenz kritisch (49.2 Hz)"
- "☀️ PV-Überschuss: Jetzt laden?"

#### Technische Umsetzung
- Service Worker für Offline-Benachrichtigungen
- Integration in bestehenden Prowl-Event-System
- User-Preferences: Welche Benachrichtigungen aktiv?

---

## 🚀 Advanced Features (Long-term)

### 5. 🎮 Gamification & Achievements

**Status:** 💡 Idea  
**Coolness:** ⭐⭐⭐⭐ (4/5)  
**Aufwand:** 🕐🕐🕐 (3 Tage)

#### Beschreibung
- Achievements: "🏆 100% Sonnenladung 7 Tage", "🌱 500 kg CO₂ gespart"
- Leaderboard für mehrere Nutzer (Multi-User Support)
- Monatliche Challenges

---

### 6. 🚗 Fahrzeug-Integration (OCR)

**Status:** 💡 Idea  
**Coolness:** ⭐⭐⭐⭐⭐ (5/5)  
**Aufwand:** 🕐🕐🕐🕐 (4-5 Tage)

#### Beschreibung
Erkennt Fahrzeug am Kennzeichen (Kamera + OCR):
- Zeigt "Tesla Model 3: 67% SoC, noch 45 min"
- Individuelle Profile pro Auto
- Automatische Abrechnungs-System für Mehrfamilienhäuser

---

### 7. 🗣️ Sprachsteuerung

**Status:** 💡 Idea  
**Coolness:** ⭐⭐⭐ (3/5)  
**Aufwand:** 🕐🕐🕐 (3 Tage)

#### Beschreibung
Alexa/Google Home Integration:
- "Starte Überschussladung"
- "Wie viel PV-Leistung habe ich?"
- "Stoppe Wallbox in 30 Minuten"

---

### 8. 🏠 Multi-Wallbox Support

**Status:** 💡 Idea  
**Coolness:** ⭐⭐⭐⭐ (4/5)  
**Aufwand:** 🕐🕐🕐🕐🕐 (5+ Tage)

#### Beschreibung
Steuert 2-4 Wallboxen gleichzeitig:
- Intelligentes Load-Balancing
- Verteilt PV-Überschuss auf mehrere Autos
- Priorisierungs-Regeln

---

### 9. 💰 Dynamische Stromtarife (Tibber/aWATTar)

**Status:** 💡 Idea  
**Coolness:** ⭐⭐⭐⭐⭐ (5/5)  
**Aufwand:** 🕐🕐🕐🕐 (4 Tage)

#### Beschreibung
- Integration Tibber/aWATTar APIs
- Lädt automatisch wenn Strom billig ist
- Zeigt Einsparungen in Echtzeit
- Kombiniert PV-Prognose + Preise

---

### 10. 🧠 ML-basierte Optimierung

**Status:** 💡 Idea  
**Coolness:** ⭐⭐⭐⭐⭐ (5/5)  
**Aufwand:** 🕐🕐🕐🕐🕐🕐 (6+ Tage)

#### Beschreibung
KI lernt User-Verhalten:
- "Du fährst meist Mo-Fr 7 Uhr → optimiert automatisch Nachtladung"
- Sagt Verbrauch voraus
- Optimiert Batterienutzung automatisch
- TensorFlow.js im Browser

---

## 🐛 Bug Fixes & Improvements

*(Noch keine Einträge)*

---

## 📝 Technical Debt

*(Noch keine Einträge)*

---

## ✅ Completed Features

- ✅ E3DC Modbus TCP Integration (Netzfrequenz-Monitoring)
- ✅ Wallbox Zeitgesteuerte Ladung mit Badge-Anzeige
- ✅ System-Informationen Kachel (Autarkie + Netzfrequenz)
- ✅ SSE (Server-Sent Events) für Echtzeit-Updates
- ✅ Charging Strategy System mit 4 Modi
- ✅ FHEM Bidirektionale Integration
- ✅ Prowl Push-Benachrichtigungen
- ✅ Demo-Modus mit Unified Mock Server

---

**Letzte Aktualisierung:** 24.11.2024

# Ladestrategien

EnergyLink bietet 4 Ladestrategien, die jederzeit – auch während einer laufenden Ladung – gewechselt werden können.

## Übersicht

| Strategie | PV nutzen | Batterie nutzen | Netz nutzen | Ideal für |
|-----------|:---------:|:---------------:|:-----------:|-----------|
| Überschuss (Batterie prio) | ✅ | ❌ (Prio Batterie) | ❌ | Max. Eigenverbrauch |
| Überschuss (Fahrzeug prio) | ✅ | Teilweise | ❌ | Ausgewogenes Laden |
| Maximum (mit Batterie) | ✅ | ✅ (Entladung) | ✅ | Schnellstmöglich laden |
| Maximum (ohne Batterie) | ✅ | ❌ | ✅ | Schnell, Batterie schonen |

---

## 1. Überschuss – Batterie priorisiert

Die Hausbatterie hat absolute Priorität. Die Wallbox erhält nur Überschuss, der **nach** der Batterie-Ladung übrig bleibt.

**Formel:** `Überschuss = PV - Hausverbrauch - Batterie-Aufnahme`

- Maximale Eigenverbrauchsoptimierung
- Batterie wird geschont
- E-Auto lädt nur bei echtem Überschuss (typisch: Mittag bei voller Batterie)

## 2. Überschuss – Fahrzeug priorisiert

Wallbox und Hausbatterie teilen sich den PV-Überschuss gleichberechtigt.

- Automatischer Batterie-Schutz bei längerer Entladung
- Ausgewogenes Verhältnis zwischen Autarkie und Auto-Ladung
- Lädt früher als „Batterie prio", da Batterie nicht zuerst voll sein muss

## 3. Maximum – mit Batterie

Maximale Ladeleistung durch PV + Batterie-Entladung + Netz.

- Hausbatterie wird aktiv entladen, um Wallbox zu speisen
- Schnellstmögliches Laden
- **Achtung:** Reduziert temporär die Hausautarkie

## 4. Maximum – ohne Batterie

Maximale Ladeleistung aus PV + Netz, Batterie bleibt unberührt.

- Kein Entladen der Hausbatterie
- Rest-Bedarf kommt aus dem Netz
- Guter Kompromiss zwischen Geschwindigkeit und Batterie-Schonung

---

## Automatische Regelung

Der Charging Strategy Controller prüft alle **15 Sekunden** die E3DC-Livedaten und passt den Wallbox-Ladestrom dynamisch an:

1. **PV-Überschuss berechnen** (aus Modbus-TCP-Daten)
2. **Zielstrom bestimmen** (Überschuss ÷ 230V, gerundet auf ganze Ampere)
3. **Schwellwerte prüfen** (Start/Stopp-Leistung, Verzögerungen)
4. **UDP-Befehl senden** (`curr <mA>` an die KEBA Wallbox)

### Schutzfunktionen

- **Start-Verzögerung:** Überschuss muss konfigurierbare Zeit anliegen, bevor Ladung startet
- **Stopp-Verzögerung:** Kurze Wolkenphasen werden überbrückt
- **Mindest-Stromänderung:** Verhindert ständiges Nachjustieren bei kleinen Schwankungen
- **Mindest-Änderungsintervall (Dwell-Time):** Schützt Wallbox vor zu häufigen Änderungen

Alle Parameter sind konfigurierbar – siehe [Konfiguration](configuration.md).

---

## Zeitgesteuerte Ladung

Zusätzlich zu den 4 Strategien gibt es ein konfigurierbares Zeitfenster (z.B. 00:00–05:00) für automatische Nachtladung:

- Lädt mit Maximalstrom im definierten Zeitfenster
- Kann mit jeder Strategie kombiniert werden
- Optional: Hausbatterie parallel aus dem Netz laden (Nachtstromtarif)
- Status-Icon zeigt aktive zeitgesteuerte Ladung an

---

## Weiterführend

- [Konfiguration](configuration.md) – Strategie-Parameter im Detail
- [Use Cases](use-cases.md) – Praxisszenarien mit Event-Flows
- [Architektur](architecture.md) – Technische Umsetzung

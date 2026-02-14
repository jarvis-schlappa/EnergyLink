# Getting Started

Diese Anleitung beschreibt Installation und Deployment von EnergyLink.

## Voraussetzungen

### Hardware
- **KEBA Wallbox** (P20, P30 oder kompatibles Modell mit UDP-Schnittstelle)
- **Optional:** E3DC S10 Hauskraftwerk (Modbus TCP für PV-Überschuss-Strategien)
- Alle Geräte im gleichen lokalen Netzwerk

### Software
- Node.js 18+ (für Bare-Metal-Installation)
- Docker + Docker Compose (für Container-Deployment)
- Moderner Browser (Chrome, Safari, Firefox, Edge)

---

## Deployment-Optionen

### Option 1: Docker (empfohlen)

```bash
# Image bauen und starten
docker-compose up -d

# Logs anzeigen
docker-compose logs -f

# Stoppen
docker-compose down
```

Alternativ ohne Compose:

```bash
docker build -t energylink .
docker run -d --name energylink --network host energylink
```

Die App ist erreichbar unter `http://localhost:5000`.

> **Hinweis:** `--network host` ist erforderlich für UDP-Kommunikation mit der Wallbox im LAN.

### Option 2: Bare Metal

```bash
git clone https://github.com/jarvis-schlappa/EnergyLink.git
cd EnergyLink
npm install
npm run build
NODE_ENV=production PORT=8080 node dist/index.js
```

#### Systemd-Service (optional)

```ini
# /etc/systemd/system/energylink.service
[Unit]
Description=EnergyLink Wallbox Controller
After=network.target

[Service]
Type=simple
WorkingDirectory=/opt/energylink
ExecStart=/usr/bin/node dist/index.js
Environment=NODE_ENV=production PORT=8080
Restart=always
User=energylink

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl enable --now energylink
```

### Option 3: Replit Autoscale (Demo)

Für eine öffentliche Demo ohne eigene Hardware:

1. Repository auf Replit importieren
2. Secrets setzen: `DEMO_AUTOSTART=true`, `NODE_ENV=production`
3. **Publish** → Autoscale Deployment wählen
4. App ist live unter `https://your-app.replit.app`

**Kosten:** ~$3-6/Monat (mit Core Credits meist kostenlos)

> ⚠️ Autoscale hat keinen persistenten Storage – nur für Demo/Showcase geeignet.

---

## PWA installieren

1. App-URL im mobilen Browser öffnen
2. **iOS (Safari):** Teilen → „Zum Home-Bildschirm"
3. **Android (Chrome):** Menü (⋮) → „Zum Startbildschirm hinzufügen"

Die App erscheint wie eine native App auf dem Startbildschirm.

---

## Erste Schritte nach der Installation

1. **Wallbox-IP konfigurieren** – Einstellungen → IP-Adresse der KEBA Wallbox eintragen
2. **E3DC aktivieren** (optional) – IP + Port des E3DC S10 eintragen (z.B. `192.168.40.50:502`)
3. **Ladestrategie wählen** – Siehe [Ladestrategien](charging-strategies.md)
4. **Feintuning** – Schwellwerte und Verzögerungen anpassen, siehe [Konfiguration](configuration.md)

---

## Nächste Schritte

- [Konfiguration](configuration.md) – Alle Einstellungen im Detail
- [Ladestrategien](charging-strategies.md) – Die 4 Strategien verstehen
- [FAQ](faq.md) – Häufige Fragen

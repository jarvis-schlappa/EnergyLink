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

Die App ist erreichbar unter `http://localhost:3000`.

> **Hinweis:** `--network host` ist erforderlich für UDP-Kommunikation mit der Wallbox im LAN.

### Option 2: Bare Metal

```bash
git clone https://github.com/mschlappa/EnergyLink.git
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

### Option 3: Demo-Modus (ohne Hardware)

EnergyLink hat einen eingebauten Demo-Modus, der Wallbox und E3DC simuliert:

```bash
DEMO_AUTOSTART=true node dist/index.js
```

Ideal zum Testen aller Funktionen ohne echte Hardware.

---

## PWA installieren

1. App-URL im mobilen Browser öffnen
2. **iOS (Safari):** Teilen → „Zum Home-Bildschirm"
3. **Android (Chrome):** Menü (⋮) → „Zum Startbildschirm hinzufügen"

Die App erscheint wie eine native App auf dem Startbildschirm.

---

## HTTPS einrichten (für iOS Push-Benachrichtigungen)

iOS erfordert HTTPS für Push-Benachrichtigungen. Für Tailscale-Nutzer:

```bash
# Auf dem Server (z.B. Raspberry Pi):
tailscale cert <hostname>.tailnet.ts.net
mkdir -p /opt/energylink/certs
mv <hostname>.crt /opt/energylink/certs/cert.pem
mv <hostname>.key /opt/energylink/certs/key.pem
```

In `data/settings.json`:
```json
{
  "tls": {
    "enabled": true,
    "certPath": "certs/cert.pem",
    "keyPath": "certs/key.pem"
  }
}
```

> **Voraussetzung:** HTTPS muss im Tailscale Admin Panel aktiviert sein (DNS → Enable HTTPS).

---

## Push-Benachrichtigungen einrichten

1. **HTTPS aktivieren** (siehe oben) – erforderlich für iOS
2. **PWA installieren** – Push funktioniert nur aus der installierten App
3. **In den Settings:** Browser Push aktivieren → „Browser für Push registrieren"
4. **Event-Toggles konfigurieren** – wähle welche Events Benachrichtigungen auslösen

Push-Benachrichtigungen sehen auf iOS aus wie native Notifications (Lockscreen, Banner, Notification Center).

---

## Erste Schritte nach der Installation

1. **Wallbox-IP konfigurieren** – Einstellungen → IP-Adresse der KEBA Wallbox eintragen
2. **E3DC aktivieren** (optional) – IP + Port des E3DC S10 eintragen
3. **Ladestrategie wählen** – Siehe [Ladestrategien](charging-strategies.md)
4. **HTTPS + Push** (optional) – Siehe Abschnitte oben
5. **Feintuning** – Schwellwerte und Verzögerungen anpassen, siehe [Konfiguration](configuration.md)

---

## Nächste Schritte

- [Konfiguration](configuration.md) – Alle Einstellungen im Detail
- [Ladestrategien](charging-strategies.md) – Die 4 Strategien verstehen
- [FAQ](faq.md) – Häufige Fragen

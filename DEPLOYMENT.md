# EnergyLink - Replit Autoscale Deployment

## Voraussetzungen

- Replit Account mit Core/Teams Plan (für Autoscale)
- Repository ist auf Replit geforkt/importiert

## Deployment-Schritte

### 1. Publishing Tool öffnen

In der Replit Workspace:
- Klicken Sie auf **"Publish"** im Header, oder
- Öffnen Sie die Command Bar und suchen Sie nach **"Publishing"**

### 2. Autoscale Deployment konfigurieren

**Deployment-Typ:** Autoscale

**Machine Konfiguration:**
- **vCPU:** 1 vCPU (Standard)
- **RAM:** 2 GiB (Standard)
- **Max Machines:** 1-3 (je nach erwartetem Traffic)

**Run Command:** (bereits in `.replit` konfiguriert)
```bash
npm run start
```

**Build Command:** (bereits in `.replit` konfiguriert)
```bash
npm run build
```

### 3. Environment Variables (Secrets) hinzufügen

Klicken Sie auf **"Add published app secret"** und fügen Sie hinzu:

| Variable Name | Wert | Beschreibung |
|--------------|------|--------------|
| `DEMO_AUTOSTART` | `true` | Startet Mock-Server automatisch im Demo-Modus |
| `NODE_ENV` | `production` | Node.js Production-Modus |

**Wichtig:** Diese Secrets werden verschlüsselt und sind nur für die deployed App verfügbar, nicht in der Development Environment!

### 4. Deployment starten

- Klicken Sie auf **"Publish"**
- Die App wird kompiliert und deployed (dauert 1-2 Minuten)
- Nach erfolgreichem Deployment erhalten Sie eine URL: `https://your-app.replit.app`

### 5. Deployment verifizieren

Nach dem Deployment:

1. **Öffnen Sie die App-URL** in einem Browser
2. **Überprüfen Sie die Logs** im Publishing Tool → "Logs" Tab:
   ```
   ✅ Sollten Sie sehen:
   
   ╔═══════════════════════════════════════════════════════════╗
   ║           🎭 DEMO MODE - MOCK SERVER AKTIV 🎭             ║
   ╚═══════════════════════════════════════════════════════════╝
   ✅ KEBA Wallbox UDP Mock Server gestartet auf Port 7090
   ✅ E3DC S10 Modbus Mock Server gestartet auf Port 5502
   ✅ FHEM HTTP Mock Server gestartet auf Port 8083
   ```

3. **Testen Sie die Features:**
   - Wallbox Status wird angezeigt
   - E3DC Energie-Monitoring funktioniert
   - SmartHome-Controls sind bedienbar

### 6. Monitoring & Updates

**Logs überwachen:**
- Publishing Tool → **"Logs"** Tab
- Zeigt Live-Logs der deployed App

**Ressourcen überwachen:**
- Publishing Tool → **"Resources"** Tab
- CPU/RAM Usage, Request Count

**App aktualisieren:**
- Code im Replit Workspace ändern
- Erneut auf **"Publish"** klicken
- Autoscale deployed automatisch die neue Version

## Kosten

Autoscale Deployments werden nach **Compute Units** berechnet:
- **Basis-Gebühr:** ~$3-6/Monat (1 vCPU, 2 GiB RAM, niedrig Traffic)
- **Pay-per-Request:** Sie zahlen nur wenn die App Requests bearbeitet
- **Unused Core Credits:** Werden zuerst verwendet

**Für Demo/Showcase:** Perfekt geeignet, da Traffic minimal ist.

## Unterschied: Development vs. Deployed

| Feature | Development (Workspace) | Deployed (Autoscale) |
|---------|------------------------|---------------------|
| Mock Server | Nur wenn `demoMode=true` in Settings | Automatisch via `DEMO_AUTOSTART=true` |
| Port | 5000 (Vite dev server) | 8080 (Production Express) |
| Storage | Persistent in Workspace | **NICHT persistent** (nur in-memory) |
| URL | `*.replit.dev` | `*.replit.app` |

**Wichtig:** Autoscale hat **keinen persistenten Storage**! Alle Settings werden im `data/` Ordner gespeichert und gehen bei Redeploy verloren. Für Production empfehlen wir:
- Lokales Deployment (Raspberry Pi/Server) mit systemd, oder
- Replit Reserved VM (persistent storage)

## Lokales Production Deployment

Für echte KEBA Wallbox & E3DC Hardware:

1. **Klonen Sie das Repository:**
   ```bash
   git clone https://github.com/your-repo/EnergyLink.git
   cd EnergyLink
   ```

2. **Installieren Sie Dependencies:**
   ```bash
   npm install
   ```

3. **Konfigurieren Sie Production Settings:**
   ```bash
   # Settings von Git ausschließen:
   git update-index --skip-worktree data/settings.json
   
   # Bearbeiten Sie data/settings.json:
   nano data/settings.json
   ```
   
   Setzen Sie:
   ```json
   {
     "wallboxIp": "192.168.40.16",
     "e3dcIp": "192.168.40.50:502",
     "pvSurplusOnUrl": "http://192.168.40.11:8083/fhem?...",
     "demoMode": false
   }
   ```

4. **Kompilieren Sie die App:**
   ```bash
   npm run build
   ```

5. **Starten Sie den Production Server:**
   ```bash
   NODE_ENV=production node dist/index.js
   ```

6. **Systemd Service (Optional):**
   ```bash
   sudo nano /etc/systemd/system/keba-wallbox.service
   ```
   
   Inhalt siehe README.md

## Support

Bei Fragen oder Problemen:
- GitHub Issues: [Link zu Repository]
- Replit Support: support@replit.com

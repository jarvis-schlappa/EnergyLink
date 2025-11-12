# 🚀 EnergyLink - Autoscale Deployment Quick Start

## In 5 Minuten auf Replit Autoscale deployen!

### Schritt 1: Publishing öffnen
1. Klicken Sie auf **"Publish"** im Header
2. Wählen Sie **"Autoscale"** als Deployment-Typ

### Schritt 2: Environment Variables setzen

**Wichtig!** Fügen Sie diese Secrets hinzu:

```
DEMO_AUTOSTART = true
NODE_ENV = production
```

So geht's:
- Klicken Sie auf **"Add published app secret"**
- Name: `DEMO_AUTOSTART`, Value: `true`
- Klicken Sie erneut auf **"Add published app secret"**
- Name: `NODE_ENV`, Value: `production`

### Schritt 3: Publish!

- Klicken Sie auf **"Publish"**
- Warten Sie ~2 Minuten
- Ihre App ist live! 🎉

### Was passiert beim Deployment?

Der **Unified Mock Server** startet automatisch und simuliert:
- ✅ KEBA P20 Wallbox (UDP Port 7090)
- ✅ E3DC S10 System (Modbus TCP Port 5502)
- ✅ FHEM SmartHome (HTTP Port 8083)

### Verifizierung

Nach dem Deployment sollten Sie in den **Logs** sehen:

```
╔═══════════════════════════════════════════════════════════╗
║           🎭 DEMO MODE - MOCK SERVER AKTIV 🎭             ║
╚═══════════════════════════════════════════════════════════╝

✅ KEBA Wallbox UDP Mock Server gestartet auf Port 7090
✅ E3DC S10 Modbus Mock Server gestartet auf Port 5502  
✅ FHEM HTTP Mock Server gestartet auf Port 8083

serving on port 5000
```

### Kosten

**Geschätzt:** ~$3-6/Monat für Demo/Showcase
- Niedrig Traffic
- 1 vCPU, 2 GiB RAM
- Pay-per-Request Modell

**Core/Teams Credits** werden zuerst verwendet!

### Wichtige Hinweise

⚠️ **Kein persistenter Storage!**  
Alle Einstellungen werden in-memory gespeichert und gehen bei Redeploy verloren.

✅ **Für Showcase/Demo perfekt!**  
Die App zeigt alle Features mit simulierten Daten.

❌ **Für echte Hardware:**  
Nutzen Sie lokales Deployment (siehe `DEPLOYMENT.md`)

### Support

Vollständige Anleitung: Siehe `DEPLOYMENT.md`

Bei Problemen: GitHub Issues oder Replit Support

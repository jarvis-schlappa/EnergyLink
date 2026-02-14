# Produktionstest 2026-02-14

**Umgebung:** Mac mini, Bare Metal, Node.js Production Mode, Debug-Loglevel
**Geräte:** Wallbox Keba P20 (192.168.40.16), E3DC (192.168.40.200 Modbus), FHEM (192.168.40.11:7072)

---

## 1. Echte Device-Responses vs. Mocks

### Wallbox Report 1 (Geräteinfo)
```json
{"ID":"1","Product":"KC-P20-EC240130-000            ","Serial":"16314582","Firmware":"KEBA P20 v 2.5a3 (160613-061001)","Sec":7849664}
```
- **Auffällig:** `Product` hat Trailing Spaces (Padding auf feste Länge)
- **`Sec`:** Betriebssekunden (~90 Tage Uptime)

### Wallbox Report 2 (Ladezustand) – während Ladung
```json
{"ID":"2","State":3,"Error1":0,"Error2":0,"Plug":7,"Enable sys":1,"Enable user":1,"Max curr":16000,"Max curr %":266,"Curr HW":32000,"Curr user":10000,"Curr FS":0,"Tmo FS":0,"Output":0,"Input":0,"Serial":"16314582","Sec":...}
```
- **State 3** = Laden aktiv
- **Plug 7** = Kabel an Box + Auto, verriegelt
- **`Max curr %` = 266** – nicht dokumentiert, vermutlich interner Prozentwert
- **`Curr user`** spiegelt den Regler-Wert korrekt wider (10000 = 10A nach manueller Reduktion)

### Wallbox Report 2 – nach Stopp
```json
{"State":5,"Plug":7,"Enable sys":0,"Enable user":0,"Max curr":0,"Max curr %":1000,"Curr HW":32000,"Curr user":10000}
```
- **State 5** = Unterbrochen (Auto da, lädt nicht)
- **`Enable sys` und `Enable user`** beide 0
- **`Max curr` = 0**, aber `Curr user` bleibt bei 10000

### Wallbox Report 3 (Energiezähler) – während Ladung @10A 3P
```json
{"ID":"3","U1":237,"U2":233,"U3":237,"I1":15832,"I2":16033,"I3":16115,"P":11385922,"PF":999,"E pres":1212,"E total":311668295,"Serial":"16314582","Sec":...}
```
- **Spannungen asymmetrisch:** 233-239V (nicht identisch!)
- **Ströme asymmetrisch:** ±200mA Abweichung zwischen Phasen
- **PF = 998-999** (Power Factor 0.998-0.999)
- **Leistung in mW** (nicht W!): 11.385.922 mW = 11,39 kW
- **E pres in 0.1 Wh:** 1212 = 121,2 Wh (Session-Energie)
- **E total:** 311.668.295 × 0.1 Wh = 31.166,8 kWh (Gesamtenergie)

### Wallbox Report 3 – Idle (kein Laden)
```json
{"U1":0,"U2":0,"U3":0,"I1":0,"I2":0,"I3":0,"P":0,"PF":0,"E pres":7846,"E total":311668295}
```
- Alle Spannungen/Ströme 0 wenn nicht geladen wird
- `E pres` behält letzten Session-Wert

### Wallbox Stopp-Befehl
```
ena 0 → {"TCH-OK":"done"}
```

---

## 2. Beobachtete Probleme / Verbesserungspotential

### 🔴 P1: Spontane Wallbox-Broadcasts werden ignoriert
Die Keba sendet eigenständig `{"E pres": 1313}` Broadcasts während der Ladung (ca. alle 1-2s).
Diese werden im Log als `Antwort ignoriert (passt nicht zu "report X")` verworfen.

**Impact:** Energie-Updates gehen verloren. Der Broadcast-Listener sollte diese `E pres`-Updates verarbeiten und in den SSE-Stream einspeisen.

### 🟡 P2: Doppelter Stopp-Befehl
Beim Stoppen über den UI-Button wird `ena 0` zweimal gesendet, mit ~1s Abstand. Beide Male kommt "Ladung gestoppt" im Log. Vermutlich doppelter Event-Trigger (UI-Button + Strategy-Controller).

### 🟡 P3: Strategy-Target vs. User-Limit nicht im Log unterschieden
Die Strategy berechnet `16000mA`, der User hat aber auf 10A begrenzt. Im Log steht nur `adjustCurrent mit 16000mA @ 3P` – es fehlt die Info dass das User-Limit greift. Verwirrend beim Debugging.

### 🟡 P4: Ramp-Up nicht simuliert in Mocks
Echte Wallbox braucht ~30s um von 0 auf Zielstrom zu rampen (7kW → 11.4kW beobachtet). Mocks springen vermutlich sofort auf Zielwert.

---

## 3. Mock-Verbesserungen (Erkenntnisse für realistischere Simulation)

### Wallbox-Mock sollte:
1. **Asymmetrische Spannungen** simulieren (233-239V statt identische Werte)
2. **Asymmetrische Ströme** pro Phase (±200mA Jitter)
3. **PF = 998-999** statt statisch 1000
4. **Ramp-Up simulieren** (~30s von 0 auf Zielstrom, nicht instant)
5. **Spontane `E pres`-Broadcasts** senden (wie echte Keba, alle 1-2s)
6. **`Product`-String mit Trailing Spaces** (Fixed-Width Format)
7. **`E pres` inkrementell** hochzählen basierend auf aktueller Leistung
8. **`Max curr %`-Feld** korrekt berechnen (266 bei 16A – Formel unklar)
9. **State-Übergänge realistisch:** Idle→Laden nicht instant
10. **Nach Stopp:** `Enable sys=0`, `Enable user=0`, `Max curr=0`, aber `Curr user` behält letzten Wert

### E3DC-Mock sollte:
1. **Hausverbrauch reagiert auf Wallbox-Last** (2.7kW idle → +7-11kW bei Ladung)
2. **SOC ändert sich nicht sofort** bei Battery-Lock
3. **Autarkie/Eigenverbrauch** realistisch berechnen (2% bei voller Netzlast, nicht feste Werte)

---

## 4. Sonstige Beobachtungen

- **FHEM-Sync stabil:** Event-driven + 10s Fallback-Timer funktioniert zuverlässig
- **E3DC Modbus-Verbindung:** Sofort connected bei korrekter IP (192.168.40.200)
- **SSE-Stream:** Client verbindet sich, bekommt Updates bei State-Änderungen
- **Prowl-Notifications:** Rate-Limiting funktioniert ("zu früh nach letzter")
- **Config-Reload:** Settings werden bei Strategiewechsel in settings.json geschrieben, aber nicht hot-reloaded beim Neustart (müssen vorher in der Datei stehen)
- **Battery Lock:** Wurde korrekt erkannt ("bereits deaktiviert - überspringe"), aber nie aktiviert da Strategie direkt auf max_with_battery gestartet wurde ohne vorherigen Wechsel

---

## 5. Produktions-Bugs

### 🔴 P5: Massives Polling im Idle
Nach Ladungs-Stopp (Strategie "off") pollt der Server weiterhin alle ~7s `report 2` an die Wallbox. Kein Grund im Idle so häufig zu pollen. Sollte auf 30-60s runter oder ganz stoppen wenn Strategie "off".

### 🟡 P6: Env-Var-Warnings im Production Mode
`DEMO_AUTOSTART nicht gesetzt`, `BUILD_BRANCH nicht gesetzt` etc. werden als WARNING geloggt. Im Production Mode sind das keine Warnings – das ist Normalzustand. Sollte DEBUG sein oder ganz entfallen.

### 🟡 P7: Kein Graceful Shutdown
Kein Signal-Handler für SIGTERM/SIGINT. Modbus-TCP, UDP-Socket und SSE-Connections werden nicht sauber geschlossen. Kann zu Port-Konflikten beim Neustart führen (EADDRINUSE).

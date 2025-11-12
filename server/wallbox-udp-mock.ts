/**
 * UDP-Mock-Server für KEBA Wallbox
 * 
 * Simuliert eine KEBA P20/P30 Wallbox auf localhost:7090
 * Antwortet auf UDP-Anfragen gemäß KEBA-Protokoll
 */
import dgram from 'dgram';
import { WallboxMockService } from './wallbox-mock';

const PORT = 7090;
const HOST = '0.0.0.0'; // Lauscht auf allen Interfaces

// Singleton Mock-Service für State-Management
const mockService = new WallboxMockService();
mockService.initializeDemo();

// UDP-Server
const server = dgram.createSocket('udp4');

server.on('error', (err) => {
  console.error(`[UDP-Mock] Server Error:\n${err.stack}`);
  server.close();
});

server.on('message', (msg, rinfo) => {
  const message = msg.toString().trim();
  console.log(`[UDP-Mock] Received: "${message}" from ${rinfo.address}:${rinfo.port}`);
  
  let response: any;
  
  // KEBA-Kommandos verarbeiten
  if (message.startsWith('report ')) {
    const reportNum = message.split(' ')[1];
    if (reportNum === '1') {
      response = mockService.getReport1();
    } else if (reportNum === '2') {
      response = mockService.getReport2();
    } else if (reportNum === '3') {
      response = mockService.getReport3();
    }
  } else if (message.startsWith('ena ') || message.startsWith('curr ')) {
    response = mockService.executeCommand(message);
  } else if (message.startsWith('mode pv ')) {
    // PV-Surplus-Modus umschalten (nur für Mock, echte Wallbox ignoriert diesen Befehl)
    const pvMode = message.split(' ')[2];
    if (pvMode === '1' || pvMode === '0') {
      mockService.setPvSurplusMode(pvMode === '1');
      console.log(`[UDP-Mock] PV-Surplus-Modus ${pvMode === '1' ? 'aktiviert (1-Phase, 6-32A)' : 'deaktiviert (3-Phase, 6-16A)'}`);
      response = { "TCH-OK": "done" };
    } else {
      response = { "TCH-ERR": "invalid mode value" };
    }
  } else {
    response = { "TCH-ERR": "unknown command" };
  }
  
  // Antwort als JSON senden
  if (response) {
    const responseStr = JSON.stringify(response);
    server.send(responseStr, rinfo.port, rinfo.address, (err) => {
      if (err) {
        console.error(`[UDP-Mock] Error sending response:`, err);
      } else {
        console.log(`[UDP-Mock] Sent: ${responseStr.substring(0, 100)}${responseStr.length > 100 ? '...' : ''}`);
      }
    });
  }
});

server.on('listening', () => {
  const address = server.address();
  console.log(`[UDP-Mock] KEBA Wallbox Mock-Server läuft auf ${address.address}:${address.port}`);
  console.log(`[UDP-Mock] Verwende IP-Adresse "127.0.0.1" in den Einstellungen für Demo-Modus`);
  console.log(`[UDP-Mock] Initialer Zustand: State 2 (Bereit), Kabel gesteckt, Laden ausgeschaltet`);
});

// Server starten
server.bind(PORT, HOST);

// Graceful Shutdown
process.on('SIGINT', () => {
  console.log('\n[UDP-Mock] Server wird heruntergefahren...');
  server.close(() => {
    console.log('[UDP-Mock] Server gestoppt');
    process.exit(0);
  });
});

process.on('SIGTERM', () => {
  console.log('\n[UDP-Mock] Server wird heruntergefahren...');
  server.close(() => {
    console.log('[UDP-Mock] Server gestoppt');
    process.exit(0);
  });
});

// Export für PV-Modus-Steuerung
export { mockService };

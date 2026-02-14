import express, { type Request, Response, NextFunction } from "express";
import { registerRoutes } from "./routes/index";
import { storage } from "./core/storage";
import { startUnifiedMock, stopUnifiedMock } from "./demo/unified-mock";
import { startBroadcastListener, stopBroadcastListener } from "./wallbox/broadcast-listener";
import { sendUdpCommand } from "./wallbox/transport";
import { log } from "./core/logger";
import { initializeProwlNotifier, triggerProwlEvent } from "./monitoring/prowl-notifier";
import { requireApiKey } from "./core/auth";
import { healthHandler } from "./core/health";
import { validateEnvironment } from "./core/env-validation";
import { e3dcClient } from "./e3dc/client";
import { RealE3dcGateway, MockE3dcGateway } from "./e3dc/gateway";

// Validate environment variables before anything else
const envResult = validateEnvironment();
if (!envResult.valid) {
  process.exit(1);
}

const app = express();

declare module 'http' {
  interface IncomingMessage {
    rawBody: unknown
  }
}
app.use(express.json({
  verify: (req, _res, buf) => {
    req.rawBody = buf;
  }
}));
app.use(express.urlencoded({ extended: false }));

app.use((req, res, next) => {
  const start = Date.now();
  const path = req.path;
  let capturedJsonResponse: Record<string, any> | undefined = undefined;

  const originalResJson = res.json;
  res.json = function (bodyJson, ...args) {
    capturedJsonResponse = bodyJson;
    return originalResJson.apply(res, [bodyJson, ...args]);
  };

  res.on("finish", () => {
    const duration = Date.now() - start;
    if (path.startsWith("/api")) {
      // Nur bei TRACE-Level HTTP-Logs ausgeben (sehr detailliert)
      const logSettings = storage.getLogSettings();
      if (logSettings.level === "trace") {
        let logLine = `${req.method} ${path} ${res.statusCode} in ${duration}ms`;
        if (capturedJsonResponse) {
          logLine += ` :: ${JSON.stringify(capturedJsonResponse)}`;
        }

        if (logLine.length > 80) {
          logLine = logLine.slice(0, 79) + "…";
        }

        log('debug', 'system', logLine);
      }
    }
  });

  next();
});

(async () => {
  // Import UDP-Channel
  const { wallboxUdpChannel } = await import('./wallbox/udp-channel');

  // E3DC Gateway: Einmalig entscheiden ob Real oder Mock
  const shouldStartMock = process.env.DEMO_AUTOSTART === 'true' || storage.getSettings()?.demoMode;

  if (shouldStartMock) {
    e3dcClient.setGateway(new MockE3dcGateway());
    log('info', 'system', '🔧 E3DC Gateway: Mock-Modus aktiviert');
  } else {
    e3dcClient.setGateway(new RealE3dcGateway());
    log('info', 'system', '🔧 E3DC Gateway: Production-Modus aktiviert');
  }

  if (shouldStartMock) {
    try {
      // UDP-Channel wird automatisch vom Mock-Server gestartet
      await startUnifiedMock();
      log('info', 'system', '✅ Unified Mock Server automatisch gestartet (Demo-Modus)');
    } catch (error) {
      log('error', 'system', '⚠️ Fehler beim Starten des Mock-Servers', error instanceof Error ? error.message : String(error));
      log('warning', 'system', 'Fortsetzung ohne Mock-Server...');
    }
  } else {
    // Kein Mock-Modus: UDP-Channel für Production starten
    try {
      await wallboxUdpChannel.start();
      log('info', 'system', '✅ UDP-Channel gestartet (Production-Modus)');
    } catch (error) {
      log('error', 'system', '⚠️ Fehler beim Starten des UDP-Channels', error instanceof Error ? error.message : String(error));
    }
  }

  // Broadcast-Listener starten (verwendet UDP-Channel + ChargingStrategyController)
  try {
    await startBroadcastListener(sendUdpCommand);
  } catch (error) {
    log('error', 'system', '⚠️ Fehler beim Starten des Broadcast-Listeners', error instanceof Error ? error.message : String(error));
  }

  // Prowl-Notifier initialisieren (VOR dem ersten triggerProwlEvent Aufruf!)
  const settings = storage.getSettings();
  initializeProwlNotifier(settings);

  // Prowl-Benachrichtigung: App gestartet (nach erfolgreicher Initialisierung)
  triggerProwlEvent(settings, "appStarted", (notifier) =>
    notifier.sendAppStarted()
  );

  // Health-check endpoint (before auth - must be accessible by monitoring tools)
  app.get("/api/health", healthHandler);

  // API-Key-Authentifizierung für alle API-Routen (inkl. SSE)
  app.use("/api", requireApiKey);

  const server = await registerRoutes(app);

  // SSE-Server ist bereits via /api/wallbox/stream in routes.ts konfiguriert
  log('info', 'system', '✅ SSE-Server bereit auf /api/wallbox/stream');

  app.use((err: any, _req: Request, res: Response, _next: NextFunction) => {
    const status = err.status || err.statusCode || 500;
    const message = err.message || "Internal Server Error";

    res.status(status).json({ message });
  });

  // importantly only setup vite in development and after
  // setting up all the other routes so the catch-all route
  // doesn't interfere with the other routes
  if (app.get("env") === "development") {
    // Dynamic import to prevent vite from being bundled into production build
    const viteMod = "./core/vite";
    const { setupVite } = await import(/* @vite-ignore */ viteMod);
    await setupVite(app, server);
  } else {
    const { serveStatic } = await import("./core/static");
    serveStatic(app);
  }

  // ALWAYS serve the app on the port specified in the environment variable PORT
  // Other ports are firewalled. Default to 3000 if not specified.
  // this serves both the API and the client.
  // It is the only port that is not firewalled.
  const port = parseInt(process.env.PORT || '3000', 10);
  server.listen({
    port,
    host: process.env.HOST || "0.0.0.0",
  }, () => {
    log('info', 'system', `serving on port ${port}`);
  });

  // Graceful Shutdown für alle Server-Ressourcen (Issue #82)
  let isShuttingDown = false;
  const shutdown = async (signal: string) => {
    // Verhindere doppeltes Shutdown (z.B. SIGINT + SIGTERM gleichzeitig)
    if (isShuttingDown) return;
    isShuttingDown = true;

    log('info', 'system', `🛑 Server wird heruntergefahren... (Signal: ${signal})`);

    // Timeout: Falls Cleanup hängt, trotzdem nach 5s beenden
    const forceExitTimer = setTimeout(() => {
      log('warning', 'system', '⚠️ Shutdown-Timeout (5s) erreicht - erzwinge Exit');
      process.exit(1);
    }, 5000);
    forceExitTimer.unref(); // Timer soll process.exit nicht blockieren

    try {
      // 1. SSE-Clients benachrichtigen und schließen
      const { closeAllSSEClients } = await import('./wallbox/sse');
      closeAllSSEClients();

      // 2. Wallbox in sicheren Zustand versetzen (nur wenn gerade geladen wird)
      try {
        const context = storage.getChargingContext();
        if (context.isActive) {
          const settings = storage.getSettings();
          if (settings?.wallboxIp) {
            log('info', 'system', '🔌 Wallbox wird gestoppt (Ladung war aktiv)...');
            await sendUdpCommand(settings.wallboxIp, "ena 0");
            log('info', 'system', '✅ Wallbox gestoppt');
          }
        }
      } catch (error) {
        log('warning', 'system', 'Wallbox-Stopp beim Shutdown fehlgeschlagen', error instanceof Error ? error.message : String(error));
      }

      // 3. Schedulers, Mock-Server und Broadcast-Listener stoppen
      const { shutdownSchedulers } = await import('./routes');
      await Promise.all([
        stopUnifiedMock(),
        stopBroadcastListener(),
        shutdownSchedulers()
      ]);

      // 4. Modbus-TCP-Verbindung zum E3DC schließen
      try {
        const { getE3dcModbusService } = await import('./e3dc/modbus');
        const modbusService = getE3dcModbusService();
        await modbusService.disconnect();
        log('info', 'system', '✅ E3DC Modbus-Verbindung geschlossen');
      } catch (error) {
        log('debug', 'system', 'E3DC Modbus Disconnect beim Shutdown', error instanceof Error ? error.message : String(error));
      }

      // 5. UDP-Socket schließen
      try {
        await wallboxUdpChannel.stop();
        log('info', 'system', '✅ UDP-Socket geschlossen');
      } catch (error) {
        log('debug', 'system', 'UDP-Socket Close beim Shutdown', error instanceof Error ? error.message : String(error));
      }

      // 6. HTTP-Server schließen
      server.close(() => {
        log('info', 'system', '✅ HTTP-Server geschlossen');
      });

      log('info', 'system', '✅ Graceful Shutdown abgeschlossen');
    } catch (error) {
      log('error', 'system', 'Fehler beim Shutdown', error instanceof Error ? error.message : String(error));
    }

    clearTimeout(forceExitTimer);
    process.exit(0);
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
})();

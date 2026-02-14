import express, { type Request, Response, NextFunction } from "express";
import { registerRoutes } from "./routes";
import { setupVite, serveStatic, log as viteLog } from "./vite";
import { storage } from "./storage";
import { startUnifiedMock, stopUnifiedMock } from "./unified-mock";
import { startBroadcastListener, stopBroadcastListener } from "./wallbox-broadcast-listener";
import { sendUdpCommand } from "./wallbox-transport";
import { log } from "./logger";
import { initializeProwlNotifier, triggerProwlEvent } from "./prowl-notifier";
import { requireApiKey } from "./auth";
import { healthHandler } from "./health";
import { validateEnvironment } from "./env-validation";
import { e3dcClient } from "./e3dc-client";
import { RealE3dcGateway, MockE3dcGateway } from "./e3dc-gateway";

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

        viteLog(logLine);
      }
    }
  });

  next();
});

(async () => {
  // Import UDP-Channel
  const { wallboxUdpChannel } = await import('./wallbox-udp-channel');

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
    await setupVite(app, server);
  } else {
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
    viteLog(`serving on port ${port}`);
  });

  // Graceful Shutdown für Mock-Server, Broadcast-Listener und Scheduler (falls aktiv)
  const shutdown = async () => {
    log('info', 'system', '🛑 Graceful Shutdown wird durchgeführt...');
    try {
      // Import shutdownSchedulers dynamisch, da routes.ts erst nach registerRoutes existiert
      const { shutdownSchedulers } = await import('./routes');

      // Stoppe alle Dienste parallel
      await Promise.all([
        stopUnifiedMock(),
        stopBroadcastListener(),
        shutdownSchedulers()
      ]);
    } catch (error) {
      log('error', 'system', 'Fehler beim Shutdown', error instanceof Error ? error.message : String(error));
    }
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
})();

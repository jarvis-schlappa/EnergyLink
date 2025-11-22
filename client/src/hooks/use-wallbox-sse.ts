/**
 * Custom Hook für Server-Sent Events (SSE) Wallbox-Status-Updates
 * 
 * Nutzt SSE statt WebSocket für Echtzeit-Updates.
 * SSE funktioniert mit Vite ohne Proxy-Konfiguration.
 */

import { useEffect, useState, useRef } from "react";
import type { WallboxStatus } from "@shared/schema";

interface UseWallboxSSEOptions {
  enabled?: boolean;
  onStatusUpdate?: (status: WallboxStatus) => void;
  onError?: (error: Error) => void;
}

export function useWallboxSSE(options: UseWallboxSSEOptions = {}) {
  const { enabled = true } = options;
  const [status, setStatus] = useState<WallboxStatus | null>(null);
  const [isConnected, setIsConnected] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  const eventSourceRef = useRef<EventSource | null>(null);
  const reconnectTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  
  // Stabilisiere Callbacks mit useRef, damit sie das useEffect nicht triggern
  const onStatusUpdateRef = useRef(options.onStatusUpdate);
  const onErrorRef = useRef(options.onError);
  
  // Aktualisiere Refs bei Änderungen - läuft bei jedem Render (kein useEffect!)
  onStatusUpdateRef.current = options.onStatusUpdate;
  onErrorRef.current = options.onError;

  useEffect(() => {
    if (!enabled) return;

    const connect = () => {
      try {
        // Cleanup alte Verbindung
        if (eventSourceRef.current) {
          eventSourceRef.current.close();
        }

        // Neue SSE-Verbindung erstellen
        const eventSource = new EventSource('/api/wallbox/stream');
        eventSourceRef.current = eventSource;

        eventSource.onopen = () => {
          console.log("[SSE] Verbunden zum Wallbox-Status-Server");
          setIsConnected(true);
          setError(null);
        };

        eventSource.onmessage = (event) => {
          try {
            const message = JSON.parse(event.data);
            
            if (message.type === "wallbox-status" && message.data) {
              setStatus(message.data);
              onStatusUpdateRef.current?.(message.data);
            }
          } catch (parseError) {
            console.error("[SSE] Fehler beim Parsing der Nachricht:", parseError);
          }
        };

        eventSource.onerror = (event) => {
          console.error("[SSE] Verbindungsfehler:", event);
          setIsConnected(false);
          
          const sseError = new Error("SSE-Verbindungsfehler");
          setError(sseError);
          onErrorRef.current?.(sseError);

          // EventSource schließen und nach 3 Sekunden reconnecten
          eventSource.close();
          
          if (reconnectTimeoutRef.current) {
            clearTimeout(reconnectTimeoutRef.current);
          }
          
          reconnectTimeoutRef.current = setTimeout(() => {
            console.log("[SSE] Versuche Reconnect...");
            connect();
          }, 3000);
        };
      } catch (err) {
        const sseError = err instanceof Error ? err : new Error(String(err));
        setError(sseError);
        onErrorRef.current?.(sseError);
      }
    };

    connect();

    return () => {
      if (reconnectTimeoutRef.current) {
        clearTimeout(reconnectTimeoutRef.current);
      }
      if (eventSourceRef.current) {
        eventSourceRef.current.close();
      }
    };
  }, [enabled]); // Nur 'enabled' als Dependency - Callbacks sind jetzt stabilisiert

  return {
    status,
    isConnected,
    error,
  };
}

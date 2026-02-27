import { useState, useEffect } from "react";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Separator } from "@/components/ui/separator";
import { useToast } from "@/hooks/use-toast";
import type { Settings } from "@shared/schema";
import type { UseFormReturn } from "react-hook-form";

interface WebPushSectionProps {
  form: UseFormReturn<Settings>;
  handleToggleSave: (field: string, value: boolean) => void;
}

/**
 * Subscribes to push notifications via the browser Push API.
 * Returns the PushSubscription or null on failure.
 */
async function subscribeToPush(vapidPublicKey: string): Promise<PushSubscription | null> {
  const permission = await Notification.requestPermission();
  if (permission !== "granted") return null;

  const registration = await navigator.serviceWorker.ready;

  // Convert VAPID key from base64url to Uint8Array
  const padding = "=".repeat((4 - (vapidPublicKey.length % 4)) % 4);
  const base64 = (vapidPublicKey + padding).replace(/-/g, "+").replace(/_/g, "/");
  const rawData = atob(base64);
  const applicationServerKey = new Uint8Array(rawData.length);
  for (let i = 0; i < rawData.length; i++) {
    applicationServerKey[i] = rawData.charCodeAt(i);
  }

  const subscription = await registration.pushManager.subscribe({
    userVisibleOnly: true,
    applicationServerKey,
  });

  return subscription;
}

export default function WebPushSection({ form, handleToggleSave }: WebPushSectionProps) {
  const { toast } = useToast();
  const webPushEnabled = form.watch("webPush.enabled");
  const [isSubscribed, setIsSubscribed] = useState(false);
  const [isSubscribing, setIsSubscribing] = useState(false);
  const [subscriptionCount, setSubscriptionCount] = useState(0);
  const [pushSupported] = useState(
    () => "serviceWorker" in navigator && "PushManager" in window,
  );

  // Check current subscription status
  useEffect(() => {
    if (!pushSupported) return;
    navigator.serviceWorker.ready.then((reg) => {
      reg.pushManager.getSubscription().then((sub) => {
        setIsSubscribed(!!sub);
      });
    });
  }, [pushSupported]);

  // Count subscriptions from settings
  useEffect(() => {
    const subs = form.getValues("webPush.subscriptions" as any);
    setSubscriptionCount(Array.isArray(subs) ? subs.length : 0);
  }, [form, webPushEnabled]);

  const handleSubscribe = async () => {
    setIsSubscribing(true);
    try {
      // Get VAPID public key from backend
      const keyRes = await fetch("/api/push/vapid-key");
      if (!keyRes.ok) throw new Error("VAPID Key nicht verfügbar");
      const { publicKey } = await keyRes.json();

      const subscription = await subscribeToPush(publicKey);
      if (!subscription) {
        toast({
          title: "Berechtigung verweigert",
          description: "Erlaube Benachrichtigungen in den Browser-Einstellungen",
          variant: "destructive",
        });
        return;
      }

      // Send subscription to backend
      const subJson = subscription.toJSON();
      const res = await fetch("/api/push/subscribe", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          endpoint: subJson.endpoint,
          keys: subJson.keys,
          label: navigator.userAgent.split("(")[1]?.split(")")[0] || "Browser",
        }),
      });

      if (res.ok) {
        setIsSubscribed(true);
        setSubscriptionCount((c) => c + 1);
        toast({
          title: "Push aktiviert",
          description: "Dieser Browser empfängt jetzt Benachrichtigungen",
        });
      } else {
        throw new Error("Subscription speichern fehlgeschlagen");
      }
    } catch (error) {
      toast({
        title: "Fehler",
        description: error instanceof Error ? error.message : "Push-Registrierung fehlgeschlagen",
        variant: "destructive",
      });
    } finally {
      setIsSubscribing(false);
    }
  };

  const handleUnsubscribe = async () => {
    try {
      const registration = await navigator.serviceWorker.ready;
      const subscription = await registration.pushManager.getSubscription();
      if (subscription) {
        const endpoint = subscription.endpoint;
        await subscription.unsubscribe();

        // Remove from backend
        await fetch("/api/push/subscribe", {
          method: "DELETE",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ endpoint }),
        });
      }
      setIsSubscribed(false);
      setSubscriptionCount((c) => Math.max(0, c - 1));
      toast({
        title: "Push deaktiviert",
        description: "Dieser Browser empfängt keine Benachrichtigungen mehr",
      });
    } catch (error) {
      toast({
        title: "Fehler",
        description: "Abmeldung fehlgeschlagen",
        variant: "destructive",
      });
    }
  };

  if (!pushSupported) {
    return (
      <div className="border rounded-lg p-4 space-y-3">
        <div className="space-y-0.5">
          <Label className="text-sm font-medium">
            Browser Push-Benachrichtigungen
          </Label>
          <p className="text-xs text-muted-foreground">
            Dein Browser unterstützt keine Push-Benachrichtigungen. Verwende Chrome, Edge oder Firefox.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="border rounded-lg p-4 space-y-3">
      <div className="flex items-center justify-between">
        <div className="space-y-0.5">
          <Label htmlFor="webpush-enabled" className="text-sm font-medium">
            Browser Push-Benachrichtigungen
          </Label>
          <p className="text-xs text-muted-foreground">
            Benachrichtigungen direkt im Browser (PWA) – gleiche Events wie Prowl
          </p>
        </div>
        <Switch
          id="webpush-enabled"
          checked={webPushEnabled}
          onCheckedChange={(checked) => {
            form.setValue("webPush.enabled", checked);
            handleToggleSave("webPush.enabled", checked);
          }}
          data-testid="switch-webpush-enabled"
        />
      </div>

      {webPushEnabled && (
        <>
          <Separator />

          <div className="space-y-4">
            {/* Subscription status */}
            <div className="p-3 rounded-md bg-muted">
              <p className="text-xs text-muted-foreground">
                {isSubscribed ? (
                  <>✅ Dieser Browser ist für Push-Benachrichtigungen registriert.</>
                ) : (
                  <>ℹ️ Registriere diesen Browser um Benachrichtigungen zu erhalten. Für beste Ergebnisse als PWA installieren.</>
                )}
              </p>
              {subscriptionCount > 0 && (
                <p className="text-xs text-muted-foreground mt-1">
                  📱 {subscriptionCount} Gerät{subscriptionCount !== 1 ? "e" : ""} registriert
                </p>
              )}
            </div>

            {/* Subscribe/Unsubscribe button */}
            {isSubscribed ? (
              <Button
                type="button"
                variant="outline"
                onClick={handleUnsubscribe}
                className="w-full"
                data-testid="button-webpush-unsubscribe"
              >
                Browser abmelden
              </Button>
            ) : (
              <Button
                type="button"
                onClick={handleSubscribe}
                disabled={isSubscribing}
                className="w-full"
                data-testid="button-webpush-subscribe"
              >
                {isSubscribing ? "Wird registriert..." : "Browser für Push registrieren"}
              </Button>
            )}

            <Separator />

            {/* Test button */}
            <Button
              type="button"
              variant="outline"
              onClick={async () => {
                try {
                  const response = await fetch("/api/push/test", { method: "POST" });
                  if (response.ok) {
                    const data = await response.json();
                    toast({
                      title: "Test-Benachrichtigung gesendet",
                      description: data.message || "Prüfe deine Benachrichtigungen",
                    });
                  } else {
                    const error = await response.json();
                    toast({
                      title: "Test fehlgeschlagen",
                      description: error.error || "Prüfe die Logs",
                      variant: "destructive",
                    });
                  }
                } catch {
                  toast({
                    title: "Fehler",
                    description: "Test-Benachrichtigung konnte nicht gesendet werden",
                    variant: "destructive",
                  });
                }
              }}
              className="w-full"
              data-testid="button-webpush-test"
              disabled={!isSubscribed}
            >
              Test-Benachrichtigung senden
            </Button>
          </div>
        </>
      )}
    </div>
  );
}

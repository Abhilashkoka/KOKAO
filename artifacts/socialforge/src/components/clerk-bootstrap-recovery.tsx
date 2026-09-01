import { useEffect, useState } from "react";
import { LogoLoader } from "@/components/logo-loader";
import { Button } from "@/components/ui/button";

const CLERK_BOOTSTRAP_RELOAD_KEY = "kokao-clerk-bootstrap-reload-v1";

export function ClerkBootstrapRecovery({
  timeoutMs = 8_000,
  reload = () => window.location.reload(),
}: {
  timeoutMs?: number;
  reload?: () => void;
}) {
  const [stalled, setStalled] = useState(false);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      try {
        if (sessionStorage.getItem(CLERK_BOOTSTRAP_RELOAD_KEY) === "1") {
          setStalled(true);
          return;
        }
        sessionStorage.setItem(CLERK_BOOTSTRAP_RELOAD_KEY, "1");
        reload();
      } catch {
        setStalled(true);
      }
    }, timeoutMs);
    return () => window.clearTimeout(timer);
  }, [reload, timeoutMs]);

  return (
    <div className="min-h-screen flex flex-col items-center justify-center gap-4 bg-background px-6 text-center">
      <LogoLoader label="Loading workspace..." />
      {stalled && (
        <div className="max-w-md space-y-3" role="alert" data-testid="error-clerk-bootstrap">
          <p className="text-sm text-muted-foreground">
            Your session is taking longer than expected to load.
          </p>
          <Button type="button" variant="outline" onClick={reload}>
            Reload workspace
          </Button>
        </div>
      )}
    </div>
  );
}

export function ClerkBootstrapReady() {
  useEffect(() => {
    try {
      sessionStorage.removeItem(CLERK_BOOTSTRAP_RELOAD_KEY);
    } catch {
      // Storage can be disabled; successful Clerk initialization needs no cleanup.
    }
  }, []);
  return null;
}
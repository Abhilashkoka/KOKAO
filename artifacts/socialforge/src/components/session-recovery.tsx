import { useState } from "react";
import { useClerk } from "@clerk/react";
import { Button } from "@/components/ui/button";
import { useBrand } from "@/lib/brand";

/**
 * A rejected API cookie is not proof that the Clerk session is revoked.
 * Never destroy the user's session automatically; keep workspace content
 * behind this boundary until the server verifies the session again.
 */
export function SessionRecovery({
  onRetry,
  onSignOut,
}: {
  onRetry: () => Promise<void>;
  onSignOut: () => Promise<void>;
}) {
  const { session } = useClerk();
  const { appName } = useBrand();
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  async function retry() {
    setBusy(true);
    setMessage(null);
    try {
      // Clerk restores its own cookies; do not attach mobile-style bearer
      // tokens to web requests or bypass the API's authentication checks.
      if (session) await session.reload();
      await onRetry();
    } catch {
      setMessage("Your session still cannot be verified. Check your browser's cookie settings, then retry or sign in again.");
    } finally {
      setBusy(false);
    }
  }

  async function signOut() {
    setBusy(true);
    setMessage(null);
    try {
      await onSignOut();
    } catch {
      setMessage("Unable to sign out. Please reload this page and try again.");
      setBusy(false);
    }
  }

  return (
    <main className="flex min-h-screen items-center justify-center bg-background p-6">
      <section className="w-full max-w-md space-y-5 rounded-2xl border bg-card p-8 shadow-sm" aria-labelledby="session-recovery-title">
        <p className="font-semibold text-primary">{appName || "KOKAO"}</p>
        <h1 id="session-recovery-title" className="text-xl font-semibold">Reconnect your sign-in</h1>
        <p className="text-sm text-muted-foreground">
          Clerk has you signed in, but {appName || "KOKAO"} cannot verify your session yet.
          You have not been automatically signed out. Your workspace and admin access stay protected while we reconnect.
        </p>
        <p className="text-sm text-muted-foreground">
          In Replit Preview, blocked third-party cookies or old site cookies can cause this.
          Allow cookies for the Preview site and Clerk, or try a browser without strict tracking protection.
        </p>
        {message && <p role="alert" className="text-sm text-destructive">{message}</p>}
        <div className="flex flex-wrap gap-3">
          <Button onClick={() => void retry()} disabled={busy}>{busy ? "Please wait..." : "Retry connection"}</Button>
          <Button variant="outline" onClick={() => void signOut()} disabled={busy}>Sign out and sign in again</Button>
        </div>
      </section>
    </main>
  );
}

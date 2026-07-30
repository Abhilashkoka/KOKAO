import { Link } from "wouter";
import { Sparkles, X } from "lucide-react";
import { useQueryClient } from "@tanstack/react-query";
import {
  useListNotifications,
  useMarkNotificationRead,
  getListNotificationsQueryKey,
} from "@workspace/api-client-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { apiErrorMessage } from "@/lib/apiErrorMessage";

/** Notification type emitted once when a new workspace gets its welcome credit bundle. */
export const SIGNUP_CREDITS_GRANTED = "signup_credits_granted";

/**
 * One-time dismissible welcome banner on the dashboard, driven by the unread
 * `signup_credits_granted` notification. Dismissing marks the notification
 * read, so it never reappears. Renders nothing when no unread notification
 * of that type exists.
 */
export function WelcomeBanner() {
  const queryClient = useQueryClient();
  const { data: notifications } = useListNotifications();
  const { mutate: markRead, isPending } = useMarkNotificationRead();
  const [dismissError, setDismissError] = useState<string | null>(null);

  const welcome = notifications?.find(
    (n) => n.type === SIGNUP_CREDITS_GRANTED,
  );
  if (!welcome) return null;

  const dismiss = () => {
    if (isPending) return;
    setDismissError(null);
    markRead(
      { id: welcome.id },
      {
        onSuccess: () =>
          queryClient.invalidateQueries({
            queryKey: getListNotificationsQueryKey(),
          }),
        onError: (err) =>
          setDismissError(
            apiErrorMessage(
              err,
              "Couldn't dismiss right now. Click X to try again.",
            ),
          ),
      },
    );
  };

  return (
    <div
      className="relative flex items-start gap-4 rounded-xl border border-primary/30 bg-primary/10 px-5 py-4 overflow-hidden"
      data-testid="banner-welcome-credits"
    >
      <div className="absolute top-0 right-0 w-40 h-40 bg-primary/10 rounded-full -mr-12 -mt-12 blur-2xl pointer-events-none" />
      <div className="h-10 w-10 rounded-xl bg-primary/15 border border-primary/20 flex items-center justify-center shrink-0">
        <Sparkles className="h-5 w-5 text-primary" />
      </div>
      <div className="flex-1 min-w-0">
        <p className="font-semibold text-foreground">{welcome.title}</p>
        <p className="text-sm text-muted-foreground mt-0.5">
          {welcome.message}
        </p>
        {dismissError ? (
          <p
            className="text-sm text-destructive mt-1.5"
            data-testid="text-dismiss-error"
          >
            {dismissError}
          </p>
        ) : null}
        <Link href="/studio">
          <Button size="sm" className="mt-3" data-testid="button-start-creating">
            <Sparkles className="h-4 w-4 mr-2" /> Start creating
          </Button>
        </Link>
      </div>
      <Button
        variant="ghost"
        size="icon"
        className="h-7 w-7 shrink-0"
        onClick={dismiss}
        disabled={isPending}
        aria-label="Dismiss welcome banner"
        data-testid="button-dismiss-welcome"
      >
        <X className="h-4 w-4" />
      </Button>
    </div>
  );
}

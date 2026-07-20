import { Link } from "wouter";
import { AlertCircle, X } from "lucide-react";
import { useQueryClient } from "@tanstack/react-query";
import {
  useListNotifications,
  useMarkNotificationRead,
  useMarkAllNotificationsRead,
  getListNotificationsQueryKey,
} from "@workspace/api-client-react";
import { Button } from "@/components/ui/button";

// Publish-outcome notifications link to the library (optionally a specific
// post); connection alerts link to reconnect flows. Label accordingly.
function linkLabel(linkUrl: string): string {
  const path = linkUrl.split(/[?#]/)[0] ?? "";
  if (path === "/library") return "View post";
  return "Reconnect now";
}

export function NotificationsBanner() {
  const queryClient = useQueryClient();
  const { data: notifications } = useListNotifications();
  const { mutate: markRead, isPending } = useMarkNotificationRead();
  const { mutate: markAllRead, isPending: isDismissingAll } =
    useMarkAllNotificationsRead();

  if (!notifications || notifications.length === 0) return null;

  const invalidate = () => {
    queryClient.invalidateQueries({
      queryKey: getListNotificationsQueryKey(),
    });
  };

  const dismiss = (id: number) => {
    markRead({ id }, { onSuccess: invalidate });
  };

  const dismissAll = () => {
    markAllRead(undefined, { onSuccess: invalidate });
  };

  return (
    <div className="flex flex-col gap-2 mb-6">
      {notifications.length > 1 && (
        <div className="flex justify-end">
          <Button
            variant="ghost"
            size="sm"
            className="h-7 text-muted-foreground"
            onClick={dismissAll}
            disabled={isDismissingAll}
          >
            Dismiss all
          </Button>
        </div>
      )}
      {notifications.map((n) => (
        <div
          key={n.id}
          className="flex items-start gap-3 rounded-lg border border-destructive/30 bg-destructive/10 px-4 py-3"
        >
          <AlertCircle className="h-5 w-5 text-destructive shrink-0 mt-0.5" />
          <div className="flex-1 min-w-0">
            <p className="font-semibold text-sm text-foreground">{n.title}</p>
            <p className="text-sm text-muted-foreground">{n.message}</p>
            {n.linkUrl && (
              <Link href={n.linkUrl}>
                <span className="inline-block mt-1 text-sm font-medium text-primary hover:underline cursor-pointer">
                  {linkLabel(n.linkUrl)}
                </span>
              </Link>
            )}
          </div>
          <Button
            variant="ghost"
            size="icon"
            className="h-7 w-7 shrink-0"
            onClick={() => dismiss(n.id)}
            disabled={isPending}
            aria-label="Dismiss notification"
          >
            <X className="h-4 w-4" />
          </Button>
        </div>
      ))}
    </div>
  );
}

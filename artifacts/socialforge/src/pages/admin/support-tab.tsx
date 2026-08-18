import { useState } from "react";
import {
  useAdminListSupportRequests,
  useAdminResolveSupportRequest,
  getAdminListSupportRequestsQueryKey,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  CardDescription,
} from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";
import { useToast } from "@/hooks/use-toast";
import { apiErrorMessage } from "@/lib/apiErrorMessage";
import { CheckCircle2 } from "lucide-react";
import { RippleSpinner } from "@/components/ui/ripple-spinner";

export function SupportTab() {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const { data: requests, isLoading } = useAdminListSupportRequests();
  const resolve = useAdminResolveSupportRequest();

  const [replyFor, setReplyFor] = useState<number | null>(null);
  const [reply, setReply] = useState("");

  const handleResolve = (id: number) => {
    resolve.mutate(
      { id, data: reply.trim() ? { reply: reply.trim() } : {} },
      {
        onSuccess: () => {
          setReplyFor(null);
          setReply("");
          queryClient.invalidateQueries({
            queryKey: getAdminListSupportRequestsQueryKey(),
          });
          toast({
            title: "Request resolved",
            description: "The workspace has been notified.",
          });
        },
        onError: (err) => {
          toast({
            title: "Couldn't resolve the request",
            description: apiErrorMessage(err, "Something went wrong. Please try again."),
            variant: "destructive",
          });
        },
      },
    );
  };

  const open = (requests ?? []).filter((r) => r.status === "open");
  const closed = (requests ?? []).filter((r) => r.status !== "open");

  return (
    <Card>
      <CardHeader>
        <CardTitle>Support requests</CardTitle>
        <CardDescription>
          Complaints, questions, and bug reports filed by workspaces from
          their Help page. Resolving notifies the workspace (with your reply,
          if you write one).
        </CardDescription>
      </CardHeader>
      <CardContent>
        {isLoading ? (
          <div className="space-y-3">
            <Skeleton className="h-20 w-full" />
            <Skeleton className="h-20 w-full" />
          </div>
        ) : !requests || requests.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No support requests yet.
          </p>
        ) : (
          <div className="space-y-3">
            {[...open, ...closed].map((r) => (
              <div
                key={r.id}
                className="rounded-lg border border-border p-4 space-y-2"
                data-testid={`admin-support-request-${r.id}`}
              >
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-medium">{r.subject}</span>
                  <Badge variant="outline">{r.category}</Badge>
                  {r.status === "open" ? (
                    <Badge variant="secondary">Open</Badge>
                  ) : (
                    <Badge className="bg-green-100 text-green-800 hover:bg-green-100">
                      <CheckCircle2 className="h-3 w-3 mr-1" /> Resolved
                    </Badge>
                  )}
                  <span className="text-xs text-muted-foreground ml-auto">
                    {new Date(r.createdAt).toLocaleString()}
                  </span>
                </div>
                <p className="text-xs text-muted-foreground">
                  {r.tenantName}
                  {r.submitterEmail
                    ? ` · ${r.submitterEmail}`
                    : r.tenantEmail
                      ? ` · ${r.tenantEmail}`
                      : ""}
                </p>
                <p className="text-sm whitespace-pre-wrap">{r.message}</p>
                {r.adminReply && (
                  <div className="rounded-md bg-muted/60 p-3">
                    <p className="text-xs font-semibold mb-1">Your reply</p>
                    <p className="text-sm whitespace-pre-wrap">
                      {r.adminReply}
                    </p>
                  </div>
                )}
                {r.status === "open" &&
                  (replyFor === r.id ? (
                    <div className="space-y-2">
                      <Textarea
                        value={reply}
                        onChange={(e) => setReply(e.target.value)}
                        placeholder="Optional reply shown to the workspace..."
                        rows={3}
                        maxLength={5000}
                        data-testid={`admin-support-reply-${r.id}`}
                      />
                      <div className="flex gap-2">
                        <Button
                          size="sm"
                          onClick={() => handleResolve(r.id)}
                          disabled={resolve.isPending}
                          data-testid={`admin-support-resolve-${r.id}`}
                        >
                          {resolve.isPending ? (
                            <>
                              <RippleSpinner className="h-4 w-4 mr-2" />{" "}
                              Resolving...
                            </>
                          ) : (
                            "Resolve request"
                          )}
                        </Button>
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() => {
                            setReplyFor(null);
                            setReply("");
                          }}
                        >
                          Cancel
                        </Button>
                      </div>
                    </div>
                  ) : (
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => {
                        setReplyFor(r.id);
                        setReply("");
                      }}
                      data-testid={`admin-support-open-reply-${r.id}`}
                    >
                      Reply & resolve
                    </Button>
                  ))}
              </div>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

import { useState } from "react";
import { RippleSpinner } from "@/components/ui/ripple-spinner";
import {
  useGetMe,
  useGetTeam,
  useCreateTeamInvite,
  useRevokeTeamInvite,
  useRemoveTeamMember,
  useCreateSeatRequest,
  useLeaveTeam,
  getGetTeamQueryKey,
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
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { useToast } from "@/hooks/use-toast";
import { Users, Trash2, X, LogOut } from "lucide-react";
import { apiErrorMessage } from "@/lib/apiErrorMessage";

export function TeamSettings() {
  const { data: me } = useGetMe();
  const { data: team, isLoading } = useGetTeam();
  const queryClient = useQueryClient();
  const { toast } = useToast();

  const createInvite = useCreateTeamInvite();
  const revokeInvite = useRevokeTeamInvite();
  const removeMember = useRemoveTeamMember();
  const createSeatRequest = useCreateSeatRequest();
  const leaveTeam = useLeaveTeam();

  const [inviteEmail, setInviteEmail] = useState("");
  const [inviteRole, setInviteRole] = useState<"admin" | "member">("member");
  const [requestSeats, setRequestSeats] = useState("");
  const [requestNote, setRequestNote] = useState("");
  const [memberToRemove, setMemberToRemove] = useState<{
    id: number;
    email: string | null;
  } | null>(null);
  const [leaveConfirmOpen, setLeaveConfirmOpen] = useState(false);

  const refresh = () =>
    queryClient.invalidateQueries({ queryKey: getGetTeamQueryKey() });

  const canManage = team?.role === "owner" || team?.role === "admin";

  const handleInvite = () => {
    const email = inviteEmail.trim();
    if (!email) return;
    createInvite.mutate(
      { data: { email, role: inviteRole } },
      {
        onSuccess: () => {
          setInviteEmail("");
          setInviteRole("member");
          refresh();
          toast({
            title: "Invite sent",
            description:
              "They will join your workspace when they sign in with that email address.",
          });
        },
        onError: (err: any) => {
          toast({
            variant: "destructive",
            title: "Could not send invite",
            description: apiErrorMessage(err, "Please try again."),
          });
        },
      },
    );
  };

  const handleRequestSeats = () => {
    const seats = Number(requestSeats.trim());
    if (!Number.isInteger(seats) || seats < 1) {
      toast({
        variant: "destructive",
        title: "Enter a valid number of seats",
        description: "Seats must be a whole number of at least 1.",
      });
      return;
    }
    createSeatRequest.mutate(
      { data: { requestedSeats: seats, note: requestNote.trim() || undefined } },
      {
        onSuccess: () => {
          setRequestSeats("");
          setRequestNote("");
          refresh();
          toast({
            title: "Request sent",
            description:
              "A platform admin will review your request. You'll get a notification with the decision.",
          });
        },
        onError: (err: any) => {
          toast({
            variant: "destructive",
            title: "Could not send request",
            description: apiErrorMessage(err, "Please try again."),
          });
        },
      },
    );
  };

  if (isLoading || !team) {
    return <Skeleton className="h-[300px] w-full rounded-xl" />;
  }

  const pendingRequest = team.seatRequests.find((r) => r.status === "pending");
  const isInvitedUser = team.role !== "owner";

  const handleLeave = () => {
    leaveTeam.mutate(undefined as never, {
      onSuccess: () => {
        setLeaveConfirmOpen(false);
        toast({
          title: "You left the workspace",
          description: "Setting up your own workspace...",
        });
        // Drop every cached query from the old workspace right away so no
        // stale content/brand-kit/account data lingers, then do a full
        // reload into the freshly auto-provisioned personal workspace.
        queryClient.clear();
        setTimeout(
          () => window.location.assign(import.meta.env.BASE_URL),
          800,
        );
      },
      onError: (err: any) => {
        setLeaveConfirmOpen(false);
        toast({
          variant: "destructive",
          title: "Could not leave the workspace",
          description: apiErrorMessage(err, "Please try again."),
        });
      },
    });
  };

  return (
    <div className="space-y-6">
      {isInvitedUser && (
        <Card className="border-border shadow-sm">
          <CardHeader>
            <CardTitle>Your membership</CardTitle>
            <CardDescription>
              You&apos;re part of someone else&apos;s workspace. Everything you
              see in this app belongs to it.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="rounded-lg border border-border divide-y divide-border">
              <div className="flex items-center justify-between px-4 py-3">
                <p className="text-sm text-muted-foreground">Workspace</p>
                <p className="text-sm font-medium">
                  {me?.team?.workspaceName || "Workspace"}
                </p>
              </div>
              <div className="flex items-center justify-between px-4 py-3">
                <p className="text-sm text-muted-foreground">Your role</p>
                <Badge variant="outline" className="capitalize">
                  {team.role}
                </Badge>
              </div>
              {me?.team?.invitedByEmail && (
                <div className="flex items-center justify-between px-4 py-3">
                  <p className="text-sm text-muted-foreground">Invited by</p>
                  <p className="text-sm font-medium">
                    {me.team.invitedByEmail}
                  </p>
                </div>
              )}
              {me?.team?.joinedAt && (
                <div className="flex items-center justify-between px-4 py-3">
                  <p className="text-sm text-muted-foreground">Joined</p>
                  <p className="text-sm font-medium">
                    {new Date(me.team.joinedAt).toLocaleDateString()}
                  </p>
                </div>
              )}
            </div>
            <Button
              variant="outline"
              onClick={() => setLeaveConfirmOpen(true)}
              disabled={leaveTeam.isPending}
            >
              {leaveTeam.isPending ? (
                <RippleSpinner className="h-4 w-4 mr-2" />
              ) : (
                <LogOut className="h-4 w-4 mr-2" />
              )}
              Leave this workspace
            </Button>
          </CardContent>
        </Card>
      )}
      <Card className="border-border shadow-sm">
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Users className="h-5 w-5 text-primary" /> Team
          </CardTitle>
          <CardDescription>
            {team.enabled
              ? `${team.seatsUsed} of ${team.seatLimit} seats in use (the owner counts as one seat; pending invites hold a seat).`
              : "The team add-on is not enabled for your workspace. Request seats below or upgrade to a plan that includes them."}
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-6">
          {team.enabled && canManage && (
            <div className="flex flex-col sm:flex-row gap-2">
              <Input
                value={inviteEmail}
                onChange={(e) => setInviteEmail(e.target.value)}
                placeholder="teammate@example.com"
                type="email"
                className="sm:flex-1"
              />
              <Select
                value={inviteRole}
                onValueChange={(v) => setInviteRole(v as "admin" | "member")}
              >
                <SelectTrigger className="sm:w-36">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="member">Member</SelectItem>
                  <SelectItem value="admin">Admin</SelectItem>
                </SelectContent>
              </Select>
              <Button
                onClick={handleInvite}
                disabled={createInvite.isPending || !inviteEmail.trim()}
              >
                {createInvite.isPending ? (
                  <RippleSpinner className="h-4 w-4" />
                ) : (
                  "Invite"
                )}
              </Button>
            </div>
          )}

          <div className="space-y-2">
            <h4 className="text-sm font-semibold">People</h4>
            <div className="rounded-lg border border-border divide-y divide-border">
              <div className="flex items-center justify-between px-4 py-3">
                <div className="min-w-0">
                  <p className="text-sm font-medium truncate">
                    {me?.tenant && team.role === "owner"
                      ? "You"
                      : "Workspace owner"}
                  </p>
                  <p className="text-xs text-muted-foreground">Owner</p>
                </div>
                <Badge variant="secondary">Owner</Badge>
              </div>
              {team.members.map((m) => (
                <div
                  key={m.id}
                  className="flex items-center justify-between px-4 py-3 gap-2"
                >
                  <div className="min-w-0">
                    <p className="text-sm font-medium truncate">
                      {m.email || "Team member"}
                    </p>
                    <p className="text-xs text-muted-foreground capitalize">
                      {m.role}
                    </p>
                  </div>
                  <div className="flex items-center gap-2">
                    <Badge variant="outline" className="capitalize">
                      {m.role}
                    </Badge>
                    {canManage && (
                      <Button
                        variant="ghost"
                        size="icon"
                        onClick={() =>
                          setMemberToRemove({ id: m.id, email: m.email })
                        }
                        aria-label="Remove member"
                        title="Remove from team"
                      >
                        <Trash2 className="h-4 w-4 text-muted-foreground" />
                      </Button>
                    )}
                  </div>
                </div>
              ))}
              {team.invites.map((i) => (
                <div
                  key={i.id}
                  className="flex items-center justify-between px-4 py-3 gap-2"
                >
                  <div className="min-w-0">
                    <p className="text-sm font-medium truncate">{i.email}</p>
                    <p className="text-xs text-muted-foreground">
                      Invited — joins when they sign in
                    </p>
                  </div>
                  <div className="flex items-center gap-2">
                    <Badge variant="outline">Pending</Badge>
                    {canManage && (
                      <Button
                        variant="ghost"
                        size="icon"
                        onClick={() =>
                          revokeInvite.mutate(
                            { id: i.id },
                            {
                              onSuccess: () => {
                                refresh();
                                toast({ title: "Invite cancelled" });
                              },
                              onError: (err: any) => {
                                toast({
                                  variant: "destructive",
                                  title: "Could not cancel invite",
                                  description:
                                    apiErrorMessage(err, "Please try again."),
                                });
                              },
                            },
                          )
                        }
                        disabled={revokeInvite.isPending}
                        aria-label="Cancel invite"
                        title="Cancel invite"
                      >
                        <X className="h-4 w-4 text-muted-foreground" />
                      </Button>
                    )}
                  </div>
                </div>
              ))}
              {team.members.length === 0 && team.invites.length === 0 && (
                <div className="px-4 py-6 text-sm text-muted-foreground text-center">
                  No team members yet.
                </div>
              )}
            </div>
          </div>
        </CardContent>
      </Card>

      {canManage && (
        <Card className="border-border shadow-sm">
          <CardHeader>
            <CardTitle>Request more seats</CardTitle>
            <CardDescription>
              Ask a platform admin to grant your workspace more team seats.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            {pendingRequest ? (
              <div className="rounded-lg border border-border bg-muted/30 px-4 py-3 text-sm">
                Your request for {pendingRequest.requestedSeats} seats is
                waiting for review.
              </div>
            ) : (
              <>
                <div className="space-y-2">
                  <label className="text-sm font-medium">
                    Total seats you need
                  </label>
                  <Input
                    value={requestSeats}
                    onChange={(e) => setRequestSeats(e.target.value)}
                    placeholder="e.g. 10"
                    className="max-w-40"
                  />
                </div>
                <div className="space-y-2">
                  <label className="text-sm font-medium">
                    Note (optional)
                  </label>
                  <Textarea
                    rows={3}
                    value={requestNote}
                    onChange={(e) => setRequestNote(e.target.value)}
                    placeholder="Tell us why you need more seats"
                  />
                </div>
                <Button
                  onClick={handleRequestSeats}
                  disabled={createSeatRequest.isPending}
                >
                  {createSeatRequest.isPending ? (
                    <>
                      <RippleSpinner className="h-4 w-4 mr-2" />{" "}
                      Sending...
                    </>
                  ) : (
                    "Send request"
                  )}
                </Button>
              </>
            )}
            {team.seatRequests.filter((r) => r.status !== "pending").length >
              0 && (
              <div className="space-y-2">
                <h4 className="text-sm font-semibold">Past requests</h4>
                <div className="rounded-lg border border-border divide-y divide-border">
                  {team.seatRequests
                    .filter((r) => r.status !== "pending")
                    .map((r) => (
                      <div
                        key={r.id}
                        className="flex items-center justify-between px-4 py-3"
                      >
                        <p className="text-sm">
                          {r.requestedSeats} seats requested
                          {r.status === "approved" &&
                            r.grantedSeats !== null &&
                            ` — ${r.grantedSeats} granted`}
                        </p>
                        <Badge
                          variant={
                            r.status === "approved" ? "secondary" : "outline"
                          }
                          className="capitalize"
                        >
                          {r.status}
                        </Badge>
                      </div>
                    ))}
                </div>
              </div>
            )}
          </CardContent>
        </Card>
      )}

      <AlertDialog open={leaveConfirmOpen} onOpenChange={setLeaveConfirmOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Leave this workspace?</AlertDialogTitle>
            <AlertDialogDescription>
              You will immediately lose access to{" "}
              {me?.team?.workspaceName || "this workspace"} and its content.
              You&apos;ll get your own personal workspace instead, and your
              seat is freed for someone else.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={handleLeave}>Leave</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog
        open={memberToRemove !== null}
        onOpenChange={(open) => !open && setMemberToRemove(null)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Remove team member?</AlertDialogTitle>
            <AlertDialogDescription>
              {memberToRemove?.email || "This member"} will immediately lose
              access to this workspace. Their seat is freed for someone else.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                if (!memberToRemove) return;
                removeMember.mutate(
                  { id: memberToRemove.id },
                  {
                    onSuccess: () => {
                      refresh();
                      toast({ title: "Member removed" });
                    },
                    onError: (err: any) => {
                      toast({
                        variant: "destructive",
                        title: "Could not remove member",
                        description:
                          apiErrorMessage(err, "Please try again."),
                      });
                    },
                  },
                );
                setMemberToRemove(null);
              }}
            >
              Remove
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

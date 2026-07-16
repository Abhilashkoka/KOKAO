import { useGetMe } from "@workspace/api-client-react";
import { useEffect, useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Users } from "lucide-react";
import { Link } from "wouter";

const ackKey = (tenantId: number, role: string) =>
  `kokao-team-welcome-${tenantId}-${role}`;

/**
 * One-time welcome shown to invited members/admins after invite auto-accept,
 * so they know which workspace they landed in and who invited them.
 * Acknowledgement is remembered per workspace in localStorage.
 */
export function TeamWelcomeDialog() {
  const { data: me } = useGetMe();
  const [open, setOpen] = useState(false);

  const isInvitedUser = Boolean(me && me.team && me.team.role !== "owner");
  const tenantId = me?.tenant?.id;
  const role = me?.team?.role;

  useEffect(() => {
    if (!isInvitedUser || tenantId === undefined || !role) return;
    try {
      if (!localStorage.getItem(ackKey(tenantId, role))) setOpen(true);
    } catch {
      // localStorage unavailable — skip the welcome rather than loop it.
    }
  }, [isInvitedUser, tenantId, role]);

  if (!isInvitedUser || !me?.team) return null;

  const dismiss = () => {
    setOpen(false);
    if (tenantId !== undefined && role) {
      try {
        localStorage.setItem(ackKey(tenantId, role), "1");
      } catch {
        // Ignore storage failures; worst case the welcome shows again.
      }
    }
  };

  return (
    <Dialog open={open} onOpenChange={(o) => !o && dismiss()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Users className="h-5 w-5 text-primary" />
            You&apos;ve joined {me.team.workspaceName || "a workspace"}
          </DialogTitle>
          <DialogDescription>
            {me.team.invitedByEmail
              ? `${me.team.invitedByEmail} invited you to this workspace.`
              : "You were invited to this workspace by its team."}{" "}
            You&apos;re a{me.team.role === "admin" ? "n admin" : " member"}{" "}
            here, so everything you see — content, brand kits, and connected
            accounts — belongs to this shared workspace. You can review your
            membership or leave the team anytime from Settings.
          </DialogDescription>
        </DialogHeader>
        <DialogFooter className="gap-2 sm:gap-0">
          <Link href="/settings" onClick={dismiss}>
            <Button variant="outline">View membership</Button>
          </Link>
          <Button onClick={dismiss}>Got it</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

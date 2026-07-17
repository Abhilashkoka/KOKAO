import { useGetMe } from "@workspace/api-client-react";
import { Mail } from "lucide-react";

/**
 * Banner shown to a workspace owner when one of their verified emails has a
 * pending team invite to another workspace. Invites only auto-accept on the
 * FIRST sign-in with the invited address, so a user who signed in with a
 * different email (e.g. a Google account) would otherwise never learn their
 * invite exists.
 */
export function PendingInviteBanner() {
  const { data: me } = useGetMe();
  const invite = me?.pendingInvite;
  if (!invite) return null;

  return (
    <div
      className="mb-6 rounded-lg border border-primary/30 bg-primary/5 px-4 py-3 flex items-start gap-3"
      data-testid="banner-pending-invite"
    >
      <Mail className="h-5 w-5 text-primary mt-0.5 shrink-0" />
      <div className="text-sm">
        <p className="font-medium">
          You have a pending invite to join {invite.workspaceName}
        </p>
        <p className="text-muted-foreground mt-1">
          The invite was sent to <strong>{invite.email}</strong>. Invites are
          matched by sign-in email, so to join that workspace sign out and
          sign back in with that exact address — or ask the workspace admin to
          re-invite you at the email you use now.
        </p>
      </div>
    </div>
  );
}

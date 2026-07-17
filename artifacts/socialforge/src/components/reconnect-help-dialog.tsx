import { useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { ExternalLink, HelpCircle } from "lucide-react";

export type ReconnectPlatform =
  | "facebook"
  | "instagram"
  | "twitter"
  | "linkedin"
  | "youtube"
  | "threads";

interface HelpStep {
  text: string;
  link?: { label: string; href: string };
}

interface HelpGuide {
  title: string;
  why: string;
  steps: HelpStep[];
}

const GUIDES: Record<ReconnectPlatform, HelpGuide> = {
  facebook: {
    title: "Reconnect your Facebook Page",
    why: "Facebook access tokens can expire or be revoked (for example after a password change or a security checkup). When that happens, publishing pauses until you save a fresh token.",
    steps: [
      {
        text: "Open Meta's Graph API Explorer and sign in with the Facebook account that manages your Page.",
        link: {
          label: "Open Graph API Explorer",
          href: "https://developers.facebook.com/tools/explorer/",
        },
      },
      {
        text: 'In the token dropdown on the right, choose "Get Page Access Token" and pick your Page. Approve the permissions pages_manage_posts and pages_read_engagement when asked.',
      },
      {
        text: "Copy the generated access token (the long text starting with EAA...).",
      },
      {
        text: "If you also need your Page ID: open your Page on facebook.com, go to Settings, then Page transparency (or About), and copy the numeric Page ID.",
        link: {
          label: "Open Facebook",
          href: "https://www.facebook.com/",
        },
      },
      {
        text: 'Come back to this card, paste the Page ID and the new token, and click "Save and verify". The app automatically upgrades your token to a long-lived one that does not expire on its own.',
      },
    ],
  },
  instagram: {
    title: "Reconnect your Instagram account",
    why: "Instagram publishing runs through your Facebook Page connection. Most Instagram failures are fixed by repairing the Facebook Page connection first.",
    steps: [
      {
        text: "Check the Facebook Page Publishing card above. If it shows a problem, fix that first — Instagram uses the same access token.",
      },
      {
        text: "Make sure your Instagram account is a Business (or Creator) account linked to your Facebook Page: on Facebook, open your Page Settings, then Linked accounts.",
        link: {
          label: "Open Facebook",
          href: "https://www.facebook.com/",
        },
      },
      {
        text: "To find your Instagram Business account ID, use the Graph API Explorer: with your Page token, query me?fields=instagram_business_account and copy the numeric ID.",
        link: {
          label: "Open Graph API Explorer",
          href: "https://developers.facebook.com/tools/explorer/",
        },
      },
      {
        text: 'Paste the ID in this card and click "Save and verify".',
      },
    ],
  },
  twitter: {
    title: "Reconnect your X account",
    why: "X connections can stop working when the authorization is revoked on X's side or the saved sign-in becomes outdated.",
    steps: [
      {
        text: 'Click the "Connect X" (or "Reconnect") button on this card. A new browser tab opens on x.com.',
      },
      {
        text: "Sign in to the X account you post from, and approve the requested access.",
      },
      {
        text: "After you approve, come back to this tab — the card flips to Connected on its own within a few seconds.",
      },
      {
        text: "If the approval page shows an error, your session on X may be stale — sign out and back in on x.com first, then retry.",
        link: { label: "Open X", href: "https://x.com/" },
      },
    ],
  },
  linkedin: {
    title: "Reconnect your LinkedIn account",
    why: "LinkedIn access tokens expire roughly every 60 days by design, and LinkedIn does not offer tokens that never expire. Reconnecting takes under a minute.",
    steps: [
      {
        text: 'Click the "Reconnect LinkedIn" button on this card. A new browser tab opens on linkedin.com.',
      },
      {
        text: "Sign in (if needed) and approve the access request.",
      },
      {
        text: "After you approve, come back to this tab — the card flips to Connected on its own within a few seconds.",
      },
      {
        text: "If approval fails, check that you are signed in to the right LinkedIn account first.",
        link: { label: "Open LinkedIn", href: "https://www.linkedin.com/" },
      },
    ],
  },
  youtube: {
    title: "Reconnect your YouTube channel",
    why: "Google can revoke access after a password change, a security review, or long inactivity. Reconnecting restores the link.",
    steps: [
      {
        text: 'Click the "Reconnect YouTube" button on this card. A new browser tab opens on Google sign-in.',
      },
      {
        text: "Choose the Google account that owns your channel and approve the access.",
      },
      {
        text: "After you approve, come back to this tab — the card flips to Connected on its own within a few seconds.",
      },
      {
        text: "If you don't see your channel, verify which Google account owns it on youtube.com (avatar menu, Your channel).",
        link: { label: "Open YouTube", href: "https://www.youtube.com/" },
      },
    ],
  },
  threads: {
    title: "Reconnect your Threads profile",
    why: "Threads uses long-lived tokens that refresh automatically, but they still die if they stay unused for 60+ days or you revoke the app's access.",
    steps: [
      {
        text: 'Click the "Reconnect Threads" button on this card. A new browser tab opens on Threads.',
      },
      {
        text: "Sign in with your Instagram credentials (Threads uses your Instagram account) and approve the access.",
      },
      {
        text: "After you approve, come back to this tab — the card flips to Connected on its own within a few seconds.",
      },
      {
        text: "If approval fails, open the Threads app or threads.net and confirm you can sign in there first.",
        link: { label: "Open Threads", href: "https://www.threads.net/" },
      },
    ],
  },
};

/**
 * A small "How to fix this" button that opens an in-app dialog with detailed,
 * platform-specific reconnection steps and direct links to the pages the user
 * needs. Rendered inside the account cards whenever a connection is broken.
 */
export function ReconnectHelpDialog({ platform }: { platform: ReconnectPlatform }) {
  const [open, setOpen] = useState(false);
  const guide = GUIDES[platform];

  return (
    <>
      <Button
        variant="outline"
        size="sm"
        onClick={() => setOpen(true)}
        data-testid={`reconnect-help-${platform}`}
      >
        <HelpCircle className="h-4 w-4 mr-2" /> How to fix this
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-w-lg max-h-[85vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>{guide.title}</DialogTitle>
            <DialogDescription>{guide.why}</DialogDescription>
          </DialogHeader>
          <ol className="list-decimal pl-5 space-y-3 text-sm">
            {guide.steps.map((step, i) => (
              <li key={i} className="space-y-1.5">
                <span>{step.text}</span>
                {step.link && (
                  <div>
                    <a
                      href={step.link.href}
                      target="_blank"
                      rel="noreferrer"
                      className="text-primary font-medium inline-flex items-center gap-1 hover:underline"
                    >
                      {step.link.label} <ExternalLink className="h-3 w-3" />
                    </a>
                  </div>
                )}
              </li>
            ))}
          </ol>
          <p className="text-xs text-muted-foreground">
            Once reconnected, the status on this card turns green and publishing
            resumes automatically — nothing else to change.
          </p>
        </DialogContent>
      </Dialog>
    </>
  );
}

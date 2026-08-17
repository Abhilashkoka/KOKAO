import { useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { BookOpen, ExternalLink } from "lucide-react";

export type SetupPlatform =
  | "facebook"
  | "instagram"
  | "twitter"
  | "linkedin"
  | "youtube"
  | "threads";

interface GuideStep {
  text: string;
  link?: { label: string; href: string };
}

interface SetupGuide {
  title: string;
  intro: string;
  steps: GuideStep[];
  note?: string;
}

const GUIDES: Record<SetupPlatform, SetupGuide> = {
  facebook: {
    title: "Connect your Facebook Page — step by step",
    intro:
      "You need two things: your Page ID (a number) and a Page access token (a long code starting with EAA...). Both come from Meta's free developer tools.",
    steps: [
      {
        text: "Make sure you have a Facebook Page (not just a personal profile) and that your Facebook account is an admin of it.",
        link: { label: "Open your Pages", href: "https://www.facebook.com/pages/?category=your_pages" },
      },
      {
        text: "Get your Page ID: open your Page on facebook.com, go to Settings → Page transparency (or the About section), and copy the numeric Page ID.",
      },
      {
        text: "Open Meta's Graph API Explorer and sign in with the same Facebook account.",
        link: { label: "Open Graph API Explorer", href: "https://developers.facebook.com/tools/explorer/" },
      },
      {
        text: "Important: in the \"Meta App\" dropdown at the top right, select this workspace's configured Meta app — tokens from any other app are rejected because they can't be kept alive. If you don't see the app listed, ask your workspace administrator to add you to it as a tester or developer.",
      },
      {
        text: 'Then in the "User or Page" dropdown, choose "Get Page Access Token" and pick your Page. Approve the permissions pages_manage_posts and pages_read_engagement when asked.',
      },
      {
        text: "Copy the generated token (the long text starting with EAA...).",
      },
      {
        text: 'Paste the Page ID and token into this card and click "Save and verify". We test them immediately, store them encrypted, and exchange the token for a long-lived one (if the exchange fails, you\'ll see a clear error here — usually it means the token came from the wrong app).',
      },
    ],
    note: "Not sure which Meta app the workspace uses, or can't get access to it? Contact your workspace administrator — they set up the Meta app and can grant you access or generate the token for you.",
  },
  instagram: {
    title: "Connect your Instagram account — step by step",
    intro:
      "Instagram publishing rides on your Facebook Page connection, so you only need one extra thing: your Instagram Business account ID (a number).",
    steps: [
      {
        text: "First, connect and verify the Facebook Page card above — Instagram uses the same access token.",
      },
      {
        text: "Make sure your Instagram account is a Business or Creator account (Instagram app → Settings → Account type and tools), not a personal one.",
      },
      {
        text: "Link it to your Facebook Page: on facebook.com open your Page → Settings → Linked accounts → Instagram.",
        link: { label: "Open Facebook", href: "https://www.facebook.com/" },
      },
      {
        text: "Find your Instagram Business account ID: in the Graph API Explorer (with your Page token selected), run the query me?fields=instagram_business_account and copy the numeric ID it returns.",
        link: { label: "Open Graph API Explorer", href: "https://developers.facebook.com/tools/explorer/" },
      },
      {
        text: "Alternatively: Meta Business Suite → Settings → Accounts → Instagram accounts also shows the account ID.",
        link: { label: "Open Business Suite settings", href: "https://business.facebook.com/settings" },
      },
      {
        text: 'Paste the ID into this card and click "Save and verify".',
      },
    ],
  },
  twitter: {
    title: "Connect your X account — step by step",
    intro:
      "No tokens or keys needed on your side — X uses a secure sign-in handshake. The whole thing takes under a minute.",
    steps: [
      {
        text: 'Click the "Connect X" button on this card. A new browser tab opens on x.com.',
      },
      {
        text: "Sign in to the X account you post from (check the account name shown before approving).",
        link: { label: "Open X", href: "https://x.com/" },
      },
      { text: "Approve the requested access." },
      {
        text: "Come back to this tab — the card flips to Connected on its own within a few seconds.",
      },
    ],
  },
  linkedin: {
    title: "Connect your LinkedIn account — step by step",
    intro:
      "No tokens or keys needed on your side — LinkedIn uses a secure sign-in handshake.",
    steps: [
      {
        text: 'Click the "Connect LinkedIn" button on this card. A new browser tab opens on linkedin.com.',
      },
      {
        text: "Sign in to the LinkedIn account you post from and approve the access request.",
        link: { label: "Open LinkedIn", href: "https://www.linkedin.com/" },
      },
      {
        text: "Come back to this tab — the card flips to Connected on its own within a few seconds.",
      },
      {
        text: "Heads-up: LinkedIn access expires roughly every 60 days by design; when that happens the card will show a Reconnect button.",
      },
    ],
  },
  youtube: {
    title: "Connect your YouTube channel — step by step",
    intro:
      "No tokens or keys needed on your side — the connection uses Google sign-in.",
    steps: [
      {
        text: 'Click the "Connect YouTube" button on this card. A new browser tab opens on Google sign-in.',
      },
      {
        text: "Choose the Google account that owns your channel and approve the access.",
      },
      {
        text: "Not sure which account owns the channel? Check on youtube.com under your avatar menu → Your channel.",
        link: { label: "Open YouTube", href: "https://www.youtube.com/" },
      },
      {
        text: "Come back to this tab — the card flips to Connected on its own within a few seconds.",
      },
    ],
  },
  threads: {
    title: "Connect your Threads profile — step by step",
    intro:
      "No tokens or keys needed on your side — Threads uses a secure sign-in handshake with your Instagram credentials.",
    steps: [
      {
        text: 'Click the "Connect Threads" button on this card. A new browser tab opens on Threads.',
      },
      {
        text: "Sign in with your Instagram credentials (Threads accounts are Instagram accounts) and approve the access.",
        link: { label: "Open Threads", href: "https://www.threads.net/" },
      },
      {
        text: "Come back to this tab — the card flips to Connected on its own within a few seconds.",
      },
    ],
  },
};

/**
 * A "Setup guide" button that opens an in-app dialog walking the user through
 * first-time connection setup for a platform: where to click, which links to
 * open, and exactly where each ID/token comes from. Rendered on every account
 * connection card (complements ReconnectHelpDialog, which covers repairs).
 */
export function SetupGuideDialog({ platform }: { platform: SetupPlatform }) {
  const [open, setOpen] = useState(false);
  const guide = GUIDES[platform];

  return (
    <>
      <Button
        variant="outline"
        size="sm"
        onClick={() => setOpen(true)}
        data-testid={`setup-guide-${platform}`}
      >
        <BookOpen className="h-4 w-4 mr-2" /> Setup guide
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-w-lg max-h-[85vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>{guide.title}</DialogTitle>
            <DialogDescription>{guide.intro}</DialogDescription>
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
          {guide.note && <p className="text-xs text-muted-foreground">{guide.note}</p>}
        </DialogContent>
      </Dialog>
    </>
  );
}

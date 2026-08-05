/**
 * Source-of-truth catalog of notification types the app can raise. The
 * notification settings tab (tenant) and the admin policy screen render off
 * this list, and the dispatch code keys preferences/policies by `type`.
 *
 * Add a new entry here when introducing a new backend-raised notification so it
 * automatically appears in both control surfaces.
 */

export type EmailPolicy = "optional" | "forced" | "off";

export const EMAIL_POLICIES: EmailPolicy[] = ["optional", "forced", "off"];

export interface NotificationTypeDef {
  type: string;
  label: string;
  description: string;
  /**
   * Only effective superadmins can ever receive this notification, so only
   * they should see (or write) settings toggles for it.
   */
  adminOnly?: boolean;
}

export const NOTIFICATION_TYPES: NotificationTypeDef[] = [
  {
    type: "social_connection_failed",
    label: "Connection problems",
    description:
      "A connected social account's access expired or was revoked and needs reconnecting before you can keep publishing.",
  },
  {
    type: "seat_request_decided",
    label: "Seat request decisions",
    description:
      "A request for more team seats was approved or denied by a platform admin.",
  },
  {
    type: "seat_request_submitted",
    label: "New seat requests (platform admins)",
    description:
      "A workspace submitted a request for more team seats and is waiting for a decision. Only platform admins receive this.",
    adminOnly: true,
  },
  {
    type: "upgrade_requested",
    label: "Upgrade requests",
    description:
      "A teammate asked the workspace owner to upgrade the plan or add credits because the workspace is running low on quota.",
  },
  {
    type: "team_member_joined",
    label: "Team joins",
    description:
      "An invited teammate signed in and joined your workspace, taking up their seat.",
  },
  {
    type: "team_member_left",
    label: "Team departures",
    description:
      "A teammate left your workspace on their own, freeing up a seat.",
  },
  {
    type: "team_member_removed",
    label: "Team removals",
    description:
      "A workspace admin removed a teammate from your workspace, freeing up a seat.",
  },
  {
    type: "removed_from_workspace",
    label: "Removed from a workspace",
    description:
      "You were removed from a team workspace you belonged to and no longer have access to its content.",
  },
  {
    type: "sweep_stalled",
    label: "Stalled safety checks (platform admins)",
    description:
      "The background connection safety check has stopped completing runs and expired social connections will go undetected until it recovers. Only platform admins receive this.",
    adminOnly: true,
  },
  {
    type: "sweep_fail_streak",
    label: "Chronic connection failures (platform admins)",
    description:
      "One workspace's social connection check has failed many sweeps in a row — a chronic breakage worth reviewing. Only platform admins receive this.",
    adminOnly: true,
  },
  {
    type: "sweep_history_trimmed",
    label: "Mass connection outages (platform admins)",
    description:
      "So many connections failed at once that the safety check's failure history overflowed and was trimmed — usually a platform-wide outage. Only platform admins receive this.",
    adminOnly: true,
  },
  {
    type: "sweep_fail_ratio",
    label: "Widespread connection failures (platform admins)",
    description:
      "A large share of connection checks failed in a single safety sweep — likely a platform-wide outage, even if the failure history did not overflow. Only platform admins receive this.",
    adminOnly: true,
  },
  {
    type: "textgen_failover",
    label: "AI text provider failover (platform admins)",
    description:
      "The selected AI text-generation provider went down and requests were diverted to the built-in provider so content kept flowing. Only platform admins receive this.",
    adminOnly: true,
  },
  {
    type: "fx_rate_stale",
    label: "Stale currency rate (platform admins)",
    description:
      "The daily USD→INR exchange-rate refresh has kept failing for days, so AI cost tracking is drifting on an old rate. Only platform admins receive this.",
    adminOnly: true,
  },
  {
    type: "scheduled_post_published",
    label: "Scheduled posts published",
    description:
      "A post you scheduled was automatically published to the platform at its scheduled time.",
  },
  {
    type: "scheduled_publish_failed",
    label: "Scheduled publish failures",
    description:
      "A post you scheduled could not be published automatically and needs your attention.",
  },
  {
    type: "ads_connection_failed",
    label: "Ad account connection problems",
    description:
      "A connected ad account's access expired or was revoked and needs reconnecting before ad changes can be applied.",
  },
  {
    type: "ads_draft_pending",
    label: "Ad changes awaiting approval",
    description:
      "A teammate drafted an advertising change that needs the workspace owner's approval before it is applied.",
  },
  {
    type: "ads_change_applied",
    label: "Ad changes applied",
    description:
      "An approved advertising change was successfully applied to your ad account.",
  },
  {
    type: "ads_verify_mismatch",
    label: "Ad changes that didn't stick",
    description:
      "An approved advertising change was accepted by the ad platform but a follow-up check shows it never took effect.",
  },
  {
    type: "ads_change_failed",
    label: "Ad change failures",
    description:
      "An approved advertising change could not be applied to your ad account and needs your attention.",
  },
  {
    type: "signup_credits_granted",
    label: "Welcome credits",
    description:
      "Your new workspace received a one-time bundle of free caption, image, or video credits to get started.",
  },
  {
    type: "publish_interrupted",
    label: "Interrupted publishes",
    description:
      "A post that was mid-publish when the server restarted was marked failed and needs a quick retry.",
  },
];

export const NOTIFICATION_TYPE_SET = new Set(
  NOTIFICATION_TYPES.map((t) => t.type),
);

export const ADMIN_ONLY_NOTIFICATION_TYPE_SET = new Set(
  NOTIFICATION_TYPES.filter((t) => t.adminOnly).map((t) => t.type),
);

export const DEFAULT_EMAIL_POLICY: EmailPolicy = "optional";

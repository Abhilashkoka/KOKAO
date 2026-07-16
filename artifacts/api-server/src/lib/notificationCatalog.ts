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
    type: "publish_interrupted",
    label: "Interrupted publishes",
    description:
      "A post that was mid-publish when the server restarted was marked failed and needs a quick retry.",
  },
];

export const NOTIFICATION_TYPE_SET = new Set(
  NOTIFICATION_TYPES.map((t) => t.type),
);

export const DEFAULT_EMAIL_POLICY: EmailPolicy = "optional";

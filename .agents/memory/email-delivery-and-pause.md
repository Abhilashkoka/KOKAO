---
name: Email delivery, pause switch, and notification email default
description: How SocialForge decides whether a transactional email actually sends — the two independent gates and their fail-closed defaults.
---

# Email delivery gates in SocialForge

A transactional email only goes out when BOTH independent gates allow it:

1. **Notification control layer** (`notificationSettings.ts` `resolveEffective`) — decides
   whether a given (tenant, notification type) even *attempts* the email channel.
   The built-in default preference is **email:false** (`defaultPreference()`), and the
   default policy is `emailPolicy:"optional"`. So with no global `notification_policies`
   row and no tenant opt-in, `effective.email` is **false** and no email is attempted.
   Email only fires by default when a global policy sets `emailPolicy:"forced"`.

2. **App-level delivery gate** (`email_settings` table via `emailSettings.ts`
   `getEmailDeliveryState`) — a superadmin-owned pause switch plus optional manual
   SendGrid creds. **Default is PAUSED (fail-closed) when no row exists** — newly
   deployed environments never send until a superadmin enables it from the admin
   "Email delivery" card. Manual creds (encrypted API key + fromEmail) take precedence
   over the Replit SendGrid connector.

**Why:** these are separate concerns — the notification layer is per-type/per-tenant
policy; the delivery gate is a global kill-switch + credential source. Both default
closed so email is opt-in, not opt-out.

**How to apply:**
- Any test that exercises the breakage email side channel must SEED a forced policy
  (`setNotificationPolicy(type, {emailPolicy:"forced"})` in `test/dbHelpers.ts`) or it
  will see zero sends and look "broken" — this is not a regression, it's the default.
- `sendEmail` respects the pause switch (no-op false when paused/unconfigured).
  `sendTestEmail` deliberately BYPASSES the pause so an admin can verify creds while
  still paused. `isEmailConfigured()` returns false while paused even if creds exist.
- Tests for `email.ts` should mock `./emailSettings` `getEmailDeliveryState`; tests that
  mock `./email` wholesale (e.g. notification tests) are unaffected by the delivery gate.

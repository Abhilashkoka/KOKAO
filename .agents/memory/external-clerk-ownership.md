---
name: External Clerk ownership
description: Use the owner's Clerk instance rather than managed auth or hostname-derived keys.
---
Use Clerk with the owner's keys from Secrets; do not introduce Replit Auth or provision a replacement Clerk instance.

**Why:** The owner explicitly requested their own Clerk keys. Clerk management detection confirmed external ownership. Hostname-derived live publishable keys can silently select a different instance than the configured secret.

**How to apply:** Preserve explicit configured keys across web, API, and mobile; never use hostname-based key derivation. Production keys must belong to the same external Clerk instance. External ownership does not imply direct Frontend API transport: retain the configured Clerk proxy before session middleware. Removing it breaks existing login requests with 401, while direct access may fail until Clerk domain DNS/TLS is configured.

Preview needs a matching Development publishable/secret key pair from the owner's Clerk app, separate from its production live keys.

**Why:** Using the API's production key in the Preview browser revealed Clerk's explicit domain restriction: live keys for kokao.in are rejected on the Replit Preview origin. A test browser key paired with a live API key also leaves successful browser sign-in unauthenticated at the API.

**How to apply:** Use development-only launch configuration for the separate pair, including the API process environment so global Clerk user lookups use the same Development secret as session middleware. Leave production build/run keys and proxy unchanged. Never solve Preview by copying a live key into its browser bundle.

Switching Clerk instances does not transfer ownership of an existing workspace. The same email can produce a new, empty workspace while all saved credits and content remain attached to the previous identity.

**Why:** After switching Preview to the owner's external Development instance, successful sign-in created a second workspace; the missing balance was an ownership association issue, not lost credits.

**How to apply:** Verify the new identity's primary email directly with Clerk and obtain owner approval before reconnecting it to an existing workspace. Check for active work, preserve the newly provisioned workspace, and audit both prior identity associations atomically. Keep credits and content on their original workspace; never automatically reassign ownership by cached email or transfer balances to mask the problem. Development reconnects do not authorize production changes.

Clerk sign-in screens, including Google's account chooser, should show the KOKAO logo and name, not Replit branding.

**Why:** The owner explicitly requested KOKAO branding on the Clerk sign-in screens.

**How to apply:** Keep KOKAO branding on the embedded sign-in/sign-up forms while preserving the external Clerk account and existing authentication transport. Branding only the embedded form does not meet the requirement: Google's account chooser needs the owner's KOKAO-branded Google OAuth client configured in Clerk, with Google branding verified and published separately.

Fresh throwaway users in the external Development instance may require Clerk's `choose-organization` task even after ticket sign-in succeeds.

**Why:** A development-only test identity completed ticket sign-in but could not enter Studio because the pending organization task kept redirecting it back to sign-in.

**How to apply:** Treat ticket acceptance and protected-page access as separate checks. Satisfy the development account's required tasks through the existing supported flow before testing protected pages, or report that browser verification is blocked. Do not change production authentication or disable instance-wide requirements merely to force a test through.

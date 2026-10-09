---
name: External Clerk ownership
description: Use the owner's Clerk instance rather than managed auth or hostname-derived keys.
---
Use Clerk with the owner's keys from Secrets; do not introduce Replit Auth or provision a replacement Clerk instance.

**Why:** The owner explicitly requested their own Clerk keys. Clerk management detection confirmed external ownership. Hostname-derived live publishable keys can silently select a different instance than the configured secret.

**How to apply:** Preserve explicit configured keys across web, API, and mobile; never use hostname-based key derivation. Production keys must belong to the same external Clerk instance. External ownership does not imply direct Frontend API transport: retain the configured Clerk proxy before session middleware. Removing it breaks existing login requests with 401, while direct access may fail until Clerk domain DNS/TLS is configured.

Clerk sign-in screens should show the KOKAO logo and name, not Replit branding.

**Why:** The owner explicitly requested KOKAO branding on the Clerk sign-in screens.

**How to apply:** Keep KOKAO branding on the embedded sign-in/sign-up forms while preserving the external Clerk account and existing authentication transport. Third-party consent screens are configured separately from the in-app forms.

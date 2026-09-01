---
name: Clerk route loading states
description: Prevent blank app shells while Clerk restores or changes browser sessions.
---

Wrap the authenticated route tree in Clerk's loaded boundary and render a visible, branded loading surface from its loading boundary. Do not rely only on parallel signed-in and signed-out conditionals. In preview, a stale Clerk bootstrap can remain in the loading boundary even while the SDK reports no page error; a normal reload may immediately recover it. Bound that state with one guarded automatic reload, then show a manual retry instead of looping.

**Why:** During Clerk's initial handshake, neither signed-in nor signed-out conditions render. Without a separate loading state, the React app can present a completely empty white screen even though no runtime exception occurred. A preview test reproduced a stale bootstrap that recovered on reload despite healthy Clerk CDN responses and canonical key/proxy wiring.

**How to apply:** Use this at the application root for browser routes that branch on Clerk state, especially protected landing pages and post-sign-in redirects. Keep page-level auth loading states as secondary safeguards. Persist a session-scoped reload guard, clear it when Clerk loads, and never auto-reload repeatedly.
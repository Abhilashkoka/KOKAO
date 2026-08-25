---
name: Clerk route loading states
description: Prevent blank app shells while Clerk restores or changes browser sessions.
---

Wrap the authenticated route tree in Clerk's loaded boundary and render a visible, branded loading surface from its loading boundary. Do not rely only on parallel signed-in and signed-out conditionals.

**Why:** During Clerk's initial handshake, neither signed-in nor signed-out conditions render. Without a separate loading state, the React app can present a completely empty white screen even though no runtime exception occurred.

**How to apply:** Use this at the application root for browser routes that branch on Clerk state, especially protected landing pages and post-sign-in redirects. Keep page-level auth loading states as secondary safeguards.
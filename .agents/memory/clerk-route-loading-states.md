---
name: Clerk route loading states
description: Prevent blank app shells while Clerk restores or changes browser sessions.
---

Mount the router directly beneath ClerkProvider; never gate the whole route tree behind ClerkLoaded. Public routes must render while Clerk initializes. Protected routes must resolve indeterminate auth to a visible sign-in recovery rather than an uncovered blank or unbounded loader.

**Why:** A signed-in production session stalled indefinitely inside the global ClerkLoaded gate while the same public deployment worked for signed-out visitors and emitted no runtime error. Reload guards were unreliable across sandboxed panes.

**How to apply:** Follow the canonical Replit-managed Clerk structure: ClerkProvider → query provider → router. The home route falls back to the public landing page while auth loads; protected routes redirect to the base-aware branded sign-in route unless positively signed in.
---
name: Clerk route loading states
description: Prevent blank app shells while Clerk restores or changes browser sessions.
---

Mount the router directly beneath ClerkProvider; never gate the whole route tree behind ClerkLoaded. Public routes must render while Clerk initializes. Protected routes must resolve indeterminate auth to a visible sign-in recovery rather than an uncovered blank or unbounded loader.

**Why:** A signed-in production session stalled indefinitely inside the global ClerkLoaded gate while the same public deployment worked for signed-out visitors and emitted no runtime error. Reload guards were unreliable across sandboxed panes.

**How to apply:** Follow the canonical Replit-managed Clerk structure: ClerkProvider → query provider → router. The home route falls back to the public landing page while auth loads; protected routes redirect to the base-aware branded sign-in route unless positively signed in.

Keep protected feature pages off the pre-mount import graph. Mount the router and public/auth routes eagerly, then load protected pages behind one visible Suspense boundary; exceptionally large nested features may use an additional component-local boundary.

**Why:** Eager transformation of every protected page left some managed preview panes indefinitely on the static pre-JavaScript loader even though fresh probes could render. An earlier experiment that delayed the whole route tree was unreliable; keeping the router/auth shell eager avoids that failure mode.

**How to apply:** Mount the app, router, public pages, auth recovery, and global providers eagerly. Split protected pages by route with an outer visible fallback, and split unusually large nested bodies inside the page with a local fallback.

Never auto-reload the static boot fallback on a timer in the managed preview.

**Why:** The embedded proxy did not reliably preserve a URL retry marker, and an eight-second reload repeatedly interrupted Vite's initial transform before React could mount. A new-tab preview hid the problem because its transform completed faster.

**How to apply:** Let the module load without navigation. After a generous delay, reveal a user-triggered cache-busting retry link; do not redirect automatically.
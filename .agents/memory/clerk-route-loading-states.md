---
name: Clerk route loading states
description: Prevent blank app shells while Clerk restores or changes browser sessions.
---

Mount the router directly beneath ClerkProvider; never gate the whole route tree behind ClerkLoaded. Public routes must render while Clerk initializes. Protected routes must resolve indeterminate auth to a visible sign-in recovery rather than an uncovered blank or unbounded loader.

**Why:** A signed-in production session stalled indefinitely inside the global ClerkLoaded gate while the same public deployment worked for signed-out visitors and emitted no runtime error. Reload guards were unreliable across sandboxed panes.

**How to apply:** Follow the canonical Replit-managed Clerk structure: ClerkProvider → query provider → router. The home route falls back to the public landing page while auth loads; protected routes redirect to the base-aware branded sign-in route unless positively signed in.

Keep the startup and route graph static in the managed development preview; do not use runtime `import()` for App, protected routes, or nested Studio features.

**Why:** Runtime imports worked in a new tab but the embedded iframe failed them with `Failed to fetch dynamically imported module` for `/src/App.tsx`. Moving the boundary deeper only moved the same failure to route/feature chunks.

**How to apply:** Import App, routes, and Video Studio statically. Configure Vite `server.warmup.clientFiles` for the main entry so the large static transform graph is cached before the embedded pane requests it.

Never auto-reload the static boot fallback on a timer in the managed preview.

**Why:** The embedded proxy did not reliably preserve a URL retry marker, and an eight-second reload repeatedly interrupted Vite's initial transform before React could mount. A new-tab preview hid the problem because its transform completed faster.

**How to apply:** Let the module load without navigation. After a generous delay, reveal a user-triggered cache-busting retry link; do not redirect automatically.
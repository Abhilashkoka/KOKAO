---
name: KOKAO branding vs code package name
description: The app is presented to users as "KOKAO" while its code package stays @workspace/socialforge.
---

# KOKAO branding

The user-facing brand is **KOKAO** (logo, favicon, page title, auth/landing/onboarding copy), but the
code package, workflows, and artifact slug remain `@workspace/socialforge` / `socialforge`.

**Why:** The product was renamed at the branding layer only; renaming packages/slugs/DB is high-risk churn
the user did not ask for. Do NOT "fix" the SocialForge↔KOKAO mismatch by renaming packages.

**How to apply:**
- Brand assets live in `attached_assets/` and are imported via the `@assets` Vite alias in React
  (e.g. `kokao-lockup_*.svg`). Files that must be served by URL (index.html favicon, Clerk `logoImageUrl`
  which reads `public/logo.svg`) are COPIED into `artifacts/socialforge/public/`.
- Palette: Set A green `#B9FF3A` (gc4), Set B green `#9BF80A` (gc6, the production asset color), ink `#14141A`.
  On green, always pair with ink; use reversed (white-text) logo variants on dark.
- Superadmin-only brand kit reference page: `/app-brand-kit`.

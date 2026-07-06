---
name: App branding (white-label) editor
description: How the superadmin "Branding" editor stores/serves/applies platform brand assets in SocialForge.
---

# App branding editor

Superadmin-only editor at `/app-brand` (nav label "Branding") lets an admin upload a logo + icon/favicon and set app name + primary/background colors; changes apply live across nav, landing, auth, favicon, title, and theme.

## Key constraints / decisions

- **Brand assets MUST be public.** The logo/favicon render on the pre-auth landing/auth pages, so they cannot use the tenant-scoped PRIVATE upload flow (`getObjectEntityUploadURL`, which namespaces by tenantId and gates reads). They upload via a dedicated `getPublicBrandUploadURL()` into the first `PUBLIC_OBJECT_SEARCH_PATHS` entry under `brand/<uuid>` and are served by the existing public route `/api/storage/public-objects/brand/<uuid>`.
  **Why:** private objects 404 for unauthenticated visitors and cross-tenant; brand assets are intentionally global + public.

- **`GET /app-brand` is mounted BEFORE `requireTenant`** (public), while `PUT /app-brand` + `POST /app-brand/upload-url` are behind `requireTenant` + `requireSuperadmin`.
  **Why:** the frontend `BrandProvider` fetches branding on the landing/auth pages where there is no session.

- **Single-row config.** `app_brand_settings` is a singleton (id defaults to 1, upsert `onConflictDoUpdate` on id). All fields nullable → null means "fall back to the bundled KOKAO default", never a hard value.

- **Theme colors are stored as hex but the theme tokens are HSL triplets** (`--background`, `--primary`, `--ring` used as `hsl(var(--token))`). `BrandProvider` converts hex→`"H S% L%"` and sets the CSS vars on `document.documentElement`; clearing a color removes the override so the CSS default returns.

- **Favicon reset:** clearing the icon must set the favicon href back to the bundled default (`/favicon.svg`), not leave the old custom one — handle the null case explicitly.

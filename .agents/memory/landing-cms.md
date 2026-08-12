---
name: Landing page CMS
description: CMS-driven public landing/privacy pages with superadmin editor; safety rules for CMS URLs and public object serving.
---

# Landing page CMS

- Content is one JSON document (snake_case keys from the original PHP kit's content.json) in the singleton `landing_content_settings` row (id=1). NULL/invalid stored doc = bundled default; GET always returns the effective document.
- Public GET `/landing-content` pre-auth; PUT superadmin-only, whole-doc replace, audit action `landing_content_change` (compact summary only, best-effort).
- Client bundles a copy of the default doc (`src/content/landing-default.json`) for instant first paint; landing.tsx exports `DEFAULT_LANDING`/`FAQ_ITEMS` for seo-static test parity with index.html JSON-LD — keep in sync.
- **Why the URL guards exist:** CMS strings render as hrefs on the public page = stored-XSS vector. PUT recursively rejects any `href`/`link`/`cta_link` not matching internal path, `#`, `https://`, or `mailto:`; logo must be an uploaded brand asset path or https. Client `CmsLink` also coerces unsafe schemes to `#` (defense in depth).
- Public object serving (`/storage/public-objects/*`) forces `nosniff` and downgrades non-passive content types (anything not image/video/audio/font, or SVG) to octet-stream attachment — user uploads must never render as HTML on the app origin.
- Known gaps (follow-up tasks proposed): no optimistic concurrency on whole-doc PUT; static OG/Twitter/JSON-LD in index.html stays at bundled defaults after CMS edits.

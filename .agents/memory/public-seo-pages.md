---
name: Public SEO pages
description: Rules for adding new publicly-crawlable routes to the KOKAO web app
---

Every new public route in the web app must own its full SEO surface, or completion review rejects it:

- **Canonical:** index.html ships a static home-page canonical; `usePageMeta(title, description, canonicalUrl)` overrides it per page (restores on unmount). A public page without its own canonical gets canonicalized to `/` by crawlers.
- Also update in lockstep: `public/sitemap.xml`, `public/robots.txt` (default-disallow posture — new public paths need explicit Allow), `public/llms.txt`, landing-page links, and any FAQ text in both landing.tsx and index.html JSON-LD (they must stay in sync).
- Structured-data prices must mirror what's rendered: prefer authoritative numeric fields (paise), parse the display label as fallback, and omit — never guess — unpriceable plans.

**Why:** the /pricing task was rejected once solely for the inherited home canonical.

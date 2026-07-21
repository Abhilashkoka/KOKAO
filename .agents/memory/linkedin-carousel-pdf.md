---
name: LinkedIn carousel publishing
description: How carousels publish to LinkedIn as multi-page PDF documents, and the kill-switch fallback rule.
---

LinkedIn has no native multi-image carousel API for organic posts. The carousel feature publishes slide images as a multi-page PDF via the Documents API (`/rest/documents?action=initializeUpload` then PUT the binary), and the post uses the document URN instead of an image URN.

- The document branch in `createLinkedinPost` triggers only when the content item has >= 2 `carouselSlides` with an `imagePath`; otherwise it falls through to the normal single-image path.
- **Kill switch rule:** the branch also checks `isFeatureEnabled("carousel")` at publish time. When the platform-wide carousel switch is off, publishes (manual AND scheduled) fall back to single-image instead of the document path. Gating only the `/ai/generate-carousel` route prefix is NOT enough — publish paths are a separate execution path the flag must cover.
- PDF is built with pdf-lib; slide images are format-sniffed (PNG magic bytes vs JPEG) since storage keys carry no extension. Slide image reads go through `objectStorageService.getObjectEntityFile(path, tenantId)` so tenant scoping is preserved.

**Why:** review caught that a disabled carousel flag still published carousels via the scheduler; kill switches must gate every execution path, not just the generation route.

Metering: `/ai/generate-carousel` meters exactly 1 caption via reserve/settle/release; it releases (charges nothing) on clarifying questions AND when the model returns fewer than the requested slide count — settle only on a complete carousel. Slide images are generated client-side one at a time through the normal metered `/ai/generate-image`.

---
name: Studio quick publish
description: Inline publish/schedule from the Studio; campaign auto-save draft mapping rules.
---

The Studio's quick-publish panel (flag `studioQuickPublish`) publishes/schedules the auto-saved draft directly from the results view.

**Rules learned:**
- Campaign generations auto-save one library draft per platform. The platform→draftId mapping MUST be epoch-guarded: bump a ref on every generation and drop late `createContent` responses from superseded generations, or rapid regenerates bind stale draft ids (image sync, Save-in-place, and schedule then act on old items).
- After an inline publish or schedule succeeds, clear the studio draft/session state — otherwise the Discard button deletes a live/scheduled item.
- Anything added to the localStorage session payload must also be added to the persistence effect's dependency array or it silently won't be saved.
- CampaignPostCard Save updates the auto-saved draft in place (404 → fallback create) so Save never duplicates library items.

**Why:** architect review caught the stale-mapping race and the missing persistence dependency; both are invisible in tests that don't simulate rapid regenerates.

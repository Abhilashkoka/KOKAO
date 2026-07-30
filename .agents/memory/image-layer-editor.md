---
name: Layered image editor
description: Konva-based web image editor — layer doc semantics, flatten-on-save, AI repair funding contract.
---

Web editor (react-konva) lets users add text/uploaded-element layers and AI-repair regions on a post image.

**Layer doc contract:** persisted `imageLayers = {version:1, basePath, layers[]}` where `basePath` is the ORIGINAL pre-flatten base image; the post's `imagePath` is the flattened output. Re-opening the editor must resume on `basePath` (layers live), never on the flattened image — otherwise layers get baked in twice or silently dropped.
**Why:** save uploads a new flattened object each time; comparing doc.basePath against the current imagePath always mismatches after the first save.
**How to apply:** any consumer of `imageLayers` (studio, mobile) resumes from `doc.basePath` when layers exist; a regenerate/remove of the image must null the layer doc.

Other rules:
- Layer coords are in the base image's natural pixels; stage is display-scaled and flattened with `toDataURL({pixelRatio: 1/scale})` (hide the repair-brush layer first).
- `/ai/edit-image` mirrors generate-image funding: validate source+mask BEFORE reserveFunding, settle on success, release on all failures; mask is PNG base64 ≤10MB, transparent = regenerate (OpenAI gpt-image-1 images.edit only).
- Request-body schema deliberately named `EditImageRequest` (never `<OpId>Body` — api-zod barrel collision).
- jsdom can't run konva; keep editor untested in web vitest, cover the server route instead.

## v2: external patch (July 30, 2026)
An externally-authored patch added layered generation (behind `layeredImages` flag, off by default) and a full-page Konva editor at `/editor/:id`. Key facts:
- Applying an external patch that conflicts with local work: apply it in a `git worktree` at its stated base commit on a branch, commit, then `git merge` into main — clean 3-way merge beats hand-resolving `git apply` failures.
- Layered generations emit the same `{version, basePath, layers}` doc the quick dialog uses; v1 docs migrate on open in the full editor. Both editors must keep writing the same format.
- `POST /ai/image-op` funding: reserve-before, settle/release-after; moderation errors must map to `ImageEditModerationError` → 422 (parity with /ai/edit-image).
- Async image job creation must refund the reservation if the DB insert itself fails, not just on enqueue rejection.
- "Full editor" from the library quick dialog saves the dialog state first, then navigates — local dialog edits are otherwise dropped.

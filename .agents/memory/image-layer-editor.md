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

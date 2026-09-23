---
name: Topic reference image semantics
description: Preserve the distinction between AI-conditioned references and exact on-screen images.
---

Uploaded prop/screenshot references are not character identities. Exact inserts must preserve the original image, fit without cropping, and retain narration; visual references may be transformed by AI.

**Why:** The user requested images mapped to the script, including screenshots whose text must remain intact. Mentioning an upload in a prompt alone does not satisfy this request, and passing screenshots through generation can corrupt their contents.

**How to apply:** Keep actual image conditioning separate from deterministic image insertion. Reject incompatible render paths rather than ignoring uploads. Freeze input bytes and scene assignments for retries; do not charge image/video generation for exact-insert scenes that make no provider call.
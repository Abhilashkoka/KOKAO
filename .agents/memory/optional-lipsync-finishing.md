---
name: Optional lip-sync finishing
description: Failure and framing rules for Studio lip-sync over an already-rendered video.
---

Optional Studio lip-sync is a per-scene finishing pass over a completed base video. Every fallible scene-specific step before a receipt—including segment cutting and audio extraction—must fail soft by preserving that base span. Receipt-bearing work must still fail closed rather than risk double charging. A stale worker must adopt or yield to a different completed finishing output instead of overwriting it.

**Why:** A single refused face-sync scene previously hid an otherwise complete, paid render. The refusal was caused by image-to-video drift introducing a second body into a solo keyframe. During restart recovery, an older worker can also fail after a newer worker has completed the pass; unguarded failure writes can incorrectly replace that success.

**How to apply:** Persist the base render before finishing. Put segment extraction, audio extraction, and provider dispatch inside the per-scene fail-soft boundary. If segment cutting fails, do not advance the cursor so later gap fill copies the original span; if a segment exists, append it unsynced. Report skipped scenes without provider billing events. For scenes selected for later lip-sync, animate from a positive hold instruction that preserves the same single subject throughout; do not repeat scene prose that implies or names an off-frame person. Before any refusal or terminal-failure write, check for a completed output from another worker; preserve that output and never re-account its receipts.
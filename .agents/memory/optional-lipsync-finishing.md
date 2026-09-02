---
name: Optional lip-sync finishing
description: Failure and framing rules for Studio lip-sync over an already-rendered video.
---

Optional Studio lip-sync is a per-scene finishing pass over a completed base video. A provider refusal before any receipt must mark only that scene skipped and ship its original footage; receipt-bearing work must still fail closed rather than risk double charging.

**Why:** A single refused face-sync scene previously hid an otherwise complete, paid render. The refusal was caused by image-to-video drift introducing a second body into a solo keyframe.

**How to apply:** Persist the base render before finishing. Report skipped scenes without provider billing events. For scenes selected for later lip-sync, animate from a positive hold instruction that preserves the same single subject throughout; do not repeat scene prose that implies or names an off-frame person.
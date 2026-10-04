---
name: Storyboard rejection cleanup
description: User requirement to delete associated characters when rejecting failed or completed storyboards.
---

The user requires that when a failed or completed storyboard is rejected, its relevant characters are deleted rather than leaving deletion blocked by Atlas Cloud assets.

**Why:** The user considers requiring separate Atlas console deletion an unacceptable restriction.

**How to apply:** Make rejection cleanup an explicit user-facing operation. Resolve whether reused library characters are included before implementing destructive cleanup; do not silently reinterpret rejection as the existing discard-and-rebuild action.
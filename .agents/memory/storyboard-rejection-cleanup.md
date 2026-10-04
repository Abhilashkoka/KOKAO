---
name: Storyboard rejection cleanup
description: User requirement to delete associated characters when rejecting failed or completed storyboards.
---

The user requires that when a failed or completed storyboard is rejected, its relevant characters are deleted rather than leaving deletion blocked by Atlas Cloud assets.

**Why:** The user considers requiring separate Atlas console deletion an unacceptable restriction.

**How to apply:** The user chose all characters used in the story, including existing library characters, if unused elsewhere. Preserve characters still referenced by another story or draft. Keep rejection distinct from discard-and-rebuild, and explain that deleting characters disables retrying the rejected story.

Provider cleanup must be durable but must not keep local library characters undeletable when Atlas is down. Retain provider handles atomically with local deletion; wait for accepted provider tasks to finish and verify absence before marking cleanup complete.

**Why:** The user explicitly rejected the requirement to visit the Atlas console before removing unwanted story characters.
---
name: Native Library publishing
description: Review snapshots and provider commit uncertainty for native video publishing.
---
Native Library publishing must never fall back to caption-only or thumbnail-only posting. Review freezes destination-specific copy and audience settings before enqueue; schedules use that snapshot even if Library copy later changes.

**Why:** uploads are asynchronous, and losing the final response does not prove that no post was created. Recreating an upload blindly risks duplicate public posts.

**How to apply:** persist create/commit fences before provider writes, resume by exact upload/container IDs, and distinguish processing from confirmed publication. Definitive or ambiguous outcomes require checking the destination before starting a fresh Library item. Reconnect resumes the existing checkpoint rather than creating a replacement upload.

Keep attempt scheduling timestamps separate from checkpoint timestamps. Explicit permission rejection can restore the pre-write checkpoint, but transport uncertainty cannot. Check compliance against the immutable outgoing copy rather than later Library edits.

**Why:** a permission-paused queue can starve other tenants if poll ordering uses unchanged checkpoints; changing those checkpoints instead destroys ambiguity timeouts. A rejected write is known not to have applied, unlike a lost response.

Schedule editing/removal is refused after processing starts or while its destination has an active upload, including permission-paused work.

**Why:** removing a calendar entry cannot cancel an already accepted remote write; reporting successful cancellation while a reconnect later publishes would be misleading.
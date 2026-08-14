---
name: Spend snapshots vs terminal job status
description: Ordering and fallback rules when surfacing per-generation spend to clients.
---
Rules for tenant-facing per-generation spend:
- Any value a polling client needs from a finished job MUST be persisted in
  the SAME write that flips the row to its terminal status. Clients stop
  polling the instant they see "succeeded"; a follow-up write is invisible.
- When a job row and its usage events both carry a snapshot, compute it once
  and pass it to both — recomputing later can desync them if config changes.
- A snapshotted 0 is a valid amount (cost_plus supplemental units). Presence
  checks must be `!= null`; never let a genuine 0 fall through to a nonzero
  flat/estimated figure.
- Multi-unit totals: if any unit lacks a snapshot, store NULL (client falls
  back to the flat estimate) — never a partial sum.

**Why:** clients that stop polling at the terminal status capture whatever the
row held at that instant; late writes are invisible, and `> 0` presence checks
silently replace real zeros with estimates.

## Shared images duplicate spend rows client-side
"Apply to all platforms" copies ONE generated image (and its one spend snapshot) under every campaign platform. Any client-side sum over per-platform image entries must dedupe by generation identity (imagePath) or it multiplies a single charge by the platform count.

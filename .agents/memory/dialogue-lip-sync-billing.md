---
name: Dialogue lip-sync billing
description: Durable financial and media-duration rules for composite AI-person dialogue videos.
---

Treat an AI dialogue lip-sync render as two independent provider units: AI visual generation and lip-sync. A successful job must account for both actual provider events. Once either provider succeeds, later local processing or provider failures must preserve and settle that completed work rather than issuing a full refund.

**Why:** The visual provider can bill before raw-video probing, local duration extension, or LatentSync runs. Telemetry alone does not debit a wallet, and a full refund after any of those later failures creates an untracked provider-cost loss.

**How to apply:** Capture the completed visual event immediately after the provider returns. Price its raw provider output, never the locally looped duration. Carry completed events through typed partial failures; settle wallet holds to completed actual/estimated work and refund only unfinished credit units. Extend short visual plates locally to the real narration duration and QA the final result against that narration.
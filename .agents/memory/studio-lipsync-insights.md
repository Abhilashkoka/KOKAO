---
name: Studio lip-sync insights
description: Privacy and semantic rules for aggregate optional Studio lip-sync reporting.
---

- Suppress every group until it has at least five accepted submissions, and omit all numeric fields for suppressed groups.
  **Why:** Coarse dimensions still become identifying when cohorts are tiny.
  **How to apply:** Enforce suppression on the server before serialization; the client must never receive hidden counts.

- Rank workflow comparisons by finished videos, where finished means successful finishes plus completed recoveries.
  **Why:** Total event volume does not answer which workflow delivers the most completed output.
  **How to apply:** Return the finished total explicitly and sort available groups by it.

- Never combine scene-count buckets whose event meanings differ. Toggle events have no funding/scene dimension, and skip events bucket skipped scenes rather than the accepted render plan.
  **Why:** Joining or presenting those values as one cohort would invent attribution from data the privacy-safe events do not contain.
  **How to apply:** Return unavailable/null for metrics that cannot be compared within the selected grouping and explain that limitation in the UI.
---
name: Guided dialogue replay
description: Safety invariants for replaying approved Guided Story frames as per-line character dialogue.
---

Guided Story dialogue replay must be a clean child execution over immutable approved inputs. Never inherit a source job's render, recovery, or provider checkpoints as child execution state. Multi-character frames require an active-speaker-capable lip-sync model after an owner-only animation plate; generic full-frame lip sync is not safe.

**Why:** A successful source can otherwise short-circuit to its old final render, and a generic lip-sync model can modify the wrong face in a multi-character approved frame.

**How to apply:** Allowlist replay child options, exclude source storyboard receipts from child settlement, and freeze exact line text, timing, owner, voice, preview, backdrop, and identity paths. On retry, validate every nested audio, plate, lip-sync, clip, preview, backdrop, character, and outfit path for receipt consistency, tenant ownership, and existence before funding.
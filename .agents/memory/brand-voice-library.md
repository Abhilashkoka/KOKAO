---
name: Brand voice library
description: Multiple saved cloned voices per brand kit — payload shape, provider-clone lifecycle, wallet invariants, record-dialog UX.
---

# Brand voice library

- Payload: flat `brand_voice` fields stay the ACTIVE voice (all synthesis reads them, untouched); `voices?: BrandVoiceEntry[]` is the library. Legacy kits (no `voices`) synthesize a one-entry library from the flat fields — never require the array.
- Cap: 5 saved voices (`MAX_VOICE_LIBRARY`), checked with a 400 BEFORE the wallet reservation.
- Provider clones: one per library entry, name `kokao-t{t}-k{kit}-{8-char uuid}` (unique — several stay alive side by side). Cloning no longer deletes the previous clone. Entry delete removes its provider clone best-effort; legacy DELETE /voice sweeps ALL library clones; kit delete re-scans historical versions as a recovery sweep — double deletes are safe because `deleteClonedVoiceQuietly` ignores 404s.
- `/voice/select` flips the active voice with NO provider call and is deliberately ungated by the kill switch (switching between already-paid clones must always work).
- Clone route wallet rule: track `cloned` + `committed` flags. Refund + provider-clone compensation only BEFORE the new kit version persists; after commit, settle failures are logged, never refunded.

**Why:** a settle inside the shared catch refunded successful work, and a thrown addVersion leaked a paid provider clone (caught in code review).
**How to apply:** any new terminal path in voice clone/delete routes must keep flat fields + voices[] consistent and respect the committed-flag refund boundary.

## Frontend (brand-kits.tsx voice section)
- Record button opens `dialog-record-voice`: ready (script+tips, mic closed) → recording (timer/meter) → review (local playback + name, nothing uploads until "Save this voice"). Picked files also route through review.
- The review take's object URL is mirrored into a ref and revoked on unmount; revoking twice is a harmless no-op.
- jsdom tests need `URL.createObjectURL`/`revokeObjectURL` stubs.

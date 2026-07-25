# Patch 2 of 5 — Music suite

Most users don't have a music file lying around. Now they don't need one.

## Apply (on top of captions.patch)

```bash
git am music-suite.patch
```

No schema change, no new dependencies, no new secrets. Restart the app.

## What you get

The Background music section (slideshow + topic videos) now offers three paths:

- **Upload** — unchanged.
- **Library** — a built-in search over Creative-Commons music (Openverse: Jamendo, Freesound, Wikimedia and more), filtered to commercially-usable licenses only. Preview tracks right in the dialog, pick one, and it's imported into the workspace with its license noted. No API key needed.
- **AI compose** — type a mood ("warm lofi chill beat") and MusicGen composes an instrumental bed via your existing Replicate token. Costs +1 video unit, shown on the chip before generating; refunded automatically if the job fails. If Replicate isn't configured, the error says exactly that — uploads and library still work.

Job progress shows "Composing the music" while the bed generates. Server-side downloads are SSRF-guarded (https-only, public hosts, re-checked per redirect, 15 MB cap).

## Sequence note

Apply strictly after captions.patch (patch 3 of the series will expect this one).

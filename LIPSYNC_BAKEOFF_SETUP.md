# Lipsync bake-off — setup

Standalone test: one character image + one voice track → OmniHuman 2.0 and 1.5
on Atlas Cloud → side-by-side comparison page. No database, wallet or job rows
are touched.

Applies on top of `feat/ai-error-guarantee`. Branch: `test/lipsync-bakeoff`.

## What you need

1. **Atlas Cloud key** — the same `ATLASCLOUD_API_KEY` KOKAO already uses.
   Top up ~$5–10. Two 15s clips cost about $1.05 (v2.0) + $1.80 (v1.5).
2. **Character image** — one front-facing KOKAO character sheet, face clearly visible.
3. **Voice track** — the Telugu script below, under 15–20s, as `.mp3` / `.wav`.
   Your own recording or a voice-clone output.

Files can be local paths or `https://` URLs. Local files are sent as data URIs;
if Atlas rejects that, pass a public or signed `https://` URL instead.

## Test script (Telugu, ~15s)

> ఛాతి నొప్పి అంటే చాలామంది గుండె గురించే ఆలోచిస్తారు.
> కానీ కొన్ని గుండె సమస్యలు స్ట్రోక్ ప్రమాదాన్ని కూడా పెంచుతాయి.
> ముఖం ఒకవైపు వాలడం, చేయి బలహీనపడటం, మాట తడబడటం కనిపిస్తే — ఆలస్యం చేయకండి.
> వెంటనే 108కి కాల్ చేయండి.
> మీకు సందేహాలుంటే, రిప్లై చేయండి.

Pause briefly between sentences — the pauses are what expose bad lip sync.

## Run

```bash
git fetch origin && git checkout test/lipsync-bakeoff

ATLASCLOUD_API_KEY=... node scripts/src/lipsync-bakeoff.mjs \
  --image ./doctor.png \
  --audio ./telugu.mp3 \
  --label telugu
```

Options: `--models v2.0` (one model only), `--prompt "..."`, `--max-sec 30`.

Output in `attached_assets/generated_videos/lipsync-bakeoff/<label>/`:
`v2.0.mp4`, `v1.5.mp4`, `results.json`, `index.html` (open it to compare).
This folder is git-ignored.

Then check pauses — the mouth must stay still while nobody speaks:

```bash
node scripts/src/lipsync-inspect.mjs attached_assets/generated_videos/lipsync-bakeoff/telugu/v2.0.mp4
```

## Reruns never double-pay

Each accepted prediction is saved in `checkpoint.json`. Rerunning resumes it.
Delete that file to pay for a fresh run.

## If it fails

| Error | Meaning |
|---|---|
| `Atlas 402` | Out of credits, or OmniHuman needs a one-time unlock like Seedance did |
| Mentions real / human / face / policy | Atlas flagged the character as a real person — try a more stylised sheet |
| `audio is Xs, over --max-sec` | Trim the audio or raise `--max-sec` |

## Scoring (1–5 each)

Lip accuracy · face matches the sheet · Telugu mouth shapes · English medical
words · mouth still in pauses · cost · render time.

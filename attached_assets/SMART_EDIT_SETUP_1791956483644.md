# Smart Edit — fix part of a finished video

Patch B of 3. It applies on top of Patch A (`guided-story-references.patch`).

A finished video is never edited in place. The flow is:

1. **Mark.** On the finished video, press **Edit**. Drag the start and end handles on the thumbnail timeline (or use **Start here** / **End here** at the playhead). Optionally press **Mark area** and drag a box on the paused frame.
2. **Describe.** Pick the edit type and say what should change.

   | Type | What it does |
   |---|---|
   | **Change** | Change or replace something; the box is optional. |
   | **Remove** | Erase what is in the box; a box is required. |
   | **Outfit** | Change what someone wears; their face and identity are kept. |
   | **New line** | Make the person say something else (lip-synced). |
   | **Re-shoot** | Regenerate the moment, optionally with a direction. |

   The estimated credits for the edit update live as you mark it.
3. **Cut.** The server cuts only that range out of the current version, frame-accurately.
4. **Regenerate only the cut:**
   - **Picture edits:**
     - The first frame of the cut (and its last frame, when the video model supports end frames) is edited inside the box.
     - The cut is then animated from the edited frame to the edited end frame, so both joins line up.
     - The clip runs as a hidden child job, so funding, refunds, retries and provider routing are the existing ones.
   - **New line:** the cut is lip-synced to the new line in the Brand Kit voice or a chosen stock voice. A consent tick is required.
5. **Review.** The **Before** cut and the **After** clip play side by side. Choose:
   - **Approve & stitch**
   - **Try again**: a new attempt with the same range and description.
   - **Discard**

   Nothing in the video changes until you approve.
6. **Stitch.**
   - The new clip replaces exactly that range. Picture edits keep the video's original soundtrack, so the length and sync stay identical.
   - A new line uses the clip's own audio, with short fades at the joins.
   - The result becomes a **new version**, the new current video for preview, download and Save to library.
7. **Repeat.** Edit any other part, or the same part again, as often as needed.
   - Every approved edit builds on the current version.
   - **Versions** keeps the original plus the last 10 edits.
   - **Restore** switches back to any of them.

## Rules worth knowing

- **Range:** 1–12 seconds per edit. Longer changes are split into several edits.
- **Open edits:** up to 3 at a time. Approve or discard to start more.
- **Version check:** an edit made on an older version can't be approved after the video changed. Press **Try again** to redo it on the current version.
- **NMC / ICAI:** for medical or CA videos, the job's frozen compliance rules check every edit description and new line. A blocking finding stops the edit before anything is charged.
- **Credits:** checked before the first paid call.
  - Picture edits cost one **image edit** per edited frame plus the clip's video seconds.
  - New lines cost voice plus lip-sync seconds.
- **Free plan:** blocked, the same as other AI video actions.
- **Saving:** approving or restoring a version clears "Saved to library", so the edited video can be saved as its own library item.
- **Job list:** child jobs are hidden from it; they belong to their parent video.

## Apply it

On top of Patch A, from the repo root:

```bash
git apply --check smart-edit.patch
git am smart-edit.patch
pnpm install
pnpm run typecheck
```

- **No database push.** State lives in `video_generations.options.smartEdit` (parent) and `options.smartEditOf` (child).
- **Generated clients are included** in the patch.

## API

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/ai/video-jobs/:id/smart-edit` | Versions, current version, and edit attempts with live status. When a cut is ready, the attempt includes the before (`cutPath`) and after (`clipPath`) paths. |
| POST | `/api/ai/video-jobs/:id/smart-edit/quote` | `{type, startSec, endSec, box?, instruction?, dialogueText?}` → credits |
| POST | `/api/ai/video-jobs/:id/smart-edit/edits` | Same fields plus `baseVersionId`, and for a new line `voice?` and `consent`. Cuts the range and starts the regeneration. |
| POST | `/api/ai/video-jobs/:id/smart-edit/edits/:editId/approve` | Stitches the cut into a new current version |
| POST | `/api/ai/video-jobs/:id/smart-edit/edits/:editId/discard` | Drops an attempt |
| POST | `/api/ai/video-jobs/:id/smart-edit/versions/:versionId/restore` | Makes an earlier version current |

`VideoJob` adds `smartEditVersionId`. `currentVideoPath` now follows the current Smart Edit version.

## Known limits

- **Box edits need the image-edit provider.** They use the built-in GPT Image mask editor, the same one the image editor uses. Without it, use **Re-shoot**, which needs no frame edit.
- **Joins depend on end-frame support.** If the default image-to-video model can't take an end frame, only the start of the cut is anchored, so the end join can show a small jump. Choose an end-frame model in admin video settings for the smoothest joins.
- **No "swap music" edit yet.** The finished file has music baked into its audio, so it can't be separated. For Guided Stories, change the music under **Your audio** before generating.

## Tests

- `api-server/src/lib/videoGen/smartEdit.test.ts`: request validation, masks, versions, prompts, and real ffmpeg cut and stitch (picture edit keeps length and sound; a new line changes the timeline).
- `api-server/src/routes/videos.test.ts` → "Smart Edit": validation before work, cut + hidden child job, approve → new version → restore original, refusing a stale edit.
- `socialforge/src/components/smart-edit-dialog.test.tsx`: range clamping, before/after review, approve, restore, area required for Remove.
- The full `videos.test.ts` (321) and every `lib/videoGen` suite pass, except one real-ffmpeg topic-video music test that also fails on the untouched base branch.

# Guided Story — uploads (@references), ad genres and requirements

Patch A of 3. B = Smart Edit (timeline + region regeneration), C = extras.

Guided Story now works for any product or service business, not only doctors and CAs. Users upload their own photos, videos, audio and briefs, name each one `@something`, and say what it is for. The script is written to use them and meet the product requirements first; the video is then rendered with them.

## What you got

### 1. Ad genres + custom tone
New genres: **Slice of Life, Problem → Solution, Customer Story, Heartwarming / Family, Inspirational, Explainer, Mythological / Period, Satire / Parody, Custom tone**. The original 7 are kept.

- **Custom tone:** a free-text tone, 3–200 characters.
- **The genre sets tone only.** A product that "doesn't fit" any genre still works: pick the feeling you want; the products, uploads and topic carry the pitch. The setup screen says this under the genres.

### 2. "Is this video medical or CA-related?"
New drafts must answer this, with three choices:

| Answer | What applies |
|---|---|
| **No — product or service** | No profession rules. No banned-words list. |
| **Yes — medical** | NMC rules, plus a **Never use these words** list for this video. |
| **Yes — CA** | ICAI rules, plus a **Never use these words** list for this video. |

- **Regulated brands stay regulated.** A Brand Kit (or workspace industry) that already resolves to Doctor or CA always keeps its rules. Answering "No" for such a brand returns a clear 400. The only off switch is the Brand Kit's Compliance tab.
- **Where it's enforced:** script writing, script approval and the job's frozen compliance snapshot. Banned words block approval through the existing checker.
- **Legacy drafts** without an answer behave exactly as before.

### 3. Uploads mapped with `@name`
**Setup → Your uploads → Add files** (up to 12).

| Media | Limit | Uses the user can map it to |
|---|---|---|
| Image (PNG, JPEG, WebP) | 10 MB | Character, Outfit, Product, Backdrop / location, Prop, Style / look, Logo, Opening shot, Closing shot, Other |
| Video (MP4, MOV, WebM) | 100 MB, 2 min | Motion / camera reference, Footage insert |
| Audio (MP3, M4A, WAV, OGG, WebM, AAC) | 25 MB, 10 min | Voice for a character, Background music, Voiceover, Sound effect |
| Brief (PDF, TXT, MD) | 5 MB | Brief (text is read locally; scanned PDFs are refused with a message) |

**On upload:**
- The server reads the file: type, size, duration, hash, and brief text.
- Images and videos get one AI description and a **suggested use**, shown as "AI thinks this is a prop — use that". Video descriptions are made from 3 frames.
- **Audio asks how to use it** in a pop-up: voice for a character, background music, voiceover, or sound effect.
  - **Voice:** pick which `@character` it voices.
  - **Voiceover:** has a **Transcribe** button so the script follows the recording.

**Rights:**
- Voice, voiceover, music and footage need a rights/consent tick.
- The server refuses to save them without it.

**`@mentions`:**
- The topic offers "Mention: @serum" chips.
- Unknown `@names` are flagged in the UI and rejected by the server.

### 4. Product requirements (script-first)
**Setup → Product requirements (optional):**
- **Must show:** free text or `@uploads`.
- **Must say:** exact phrases.
- **Call to action.**
- **Banned words:** shown only for medical and CA videos.

**How they're used:**
- The writer is told to meet every requirement.
- The script review shows a **checklist**: met or not met, for each requirement and each mapped upload.
- Unmet items also appear as script warnings. They never block approval, so the user can edit or regenerate.

### 5. How each upload is used

| Use | Script | Render |
|---|---|---|
| Character | The writer creates exactly one role for it (`role.referenceId`). | The cast card offers **Fill look from @maya**, which sets the generated character's description, and **Use @maya photo**, which uses the existing upload-source cast flow with candidate review and consent. |
| Outfit | The writer dresses the role in it. | **Wardrobe from @saree** fills the generated character's wardrobe. |
| Product | The writer tags scenes (`scene.referenceIds`). | On Wan reference-to-video, the photo is attached as a real `@ImageN` reference. Other models describe it in text. Brand Kit products still work as before. |
| Prop, Style, Opening / Closing shot, Other | The writer tags scenes. | Same as Product: attached on Wan, described elsewhere. |
| Motion (video) | The writer tags scenes. | The camera move and action are described from the AI description. |
| Backdrop | The writer tags scenes. | The backdrop step shows **Use @shop** buttons. Each one goes through the normal backdrop approval. |
| Logo | — | Visual choices shows **Use @logo**. |
| Footage insert | The tagged scene is written as narration-only. | Your clip covers that scene's picture in the finished video. The generated audio is kept. |
| Music, Voiceover, Sound effect | Voiceover transcripts guide the narration. | Mixed locally with ffmpeg after render. **Your audio** in the final step sets the scene, start/end, volume, ducking and voiceover replace. |
| Voice | — | The cast step shows **Clone voice @mayavoice** into the Brand Kit's voices and selects it for the role. |
| Brief | Its text is given to the writer as facts. | — |

**Re-checks:** every upload the renderer reads is re-hashed:
- at enqueue,
- before each Wan scene call,
- before mixing.

If a file changed, the job stops before money is spent, with a clear message.

## Apply it

On top of `feat/prompt-kit-script-variants` (`23ed8e3`), from the repo root:

```bash
git apply --check guided-story-references.patch   # dry run — should print nothing
git am guided-story-references.patch              # one commit
pnpm install                                       # adds unpdf (PDF briefs)
pnpm run typecheck
```

- **No database push.** Everything lives in the existing jsonb:
  - `guided_story_drafts.state`: `setup.references`, `setup.requirements`, `setup.category`, `setup.customTone`, `audioChoices`
  - `video_generations.options.guidedStory`: `references`, `audioChoices`
- **Generated clients are included.** `lib/api-zod` and `lib/api-client-react` are regenerated in the patch.

## API

| Method | Path | Purpose |
|---|---|---|
| POST | `/api/ai/guided-story/references/inspect` | `{path, label?, notes?, describe?}` → media facts, allowed uses, suggested use, AI description. Nothing is saved. |
| POST | `/api/ai/guided-story/references/transcribe` | `{path}` → `{transcript}` (metered speech-to-text) |
| POST / PATCH | `/api/ai/guided-story/drafts[/:id]` | `setup` adds `customTone`, `category`, `requirements`, and `uploads[]` (stored as `setup.references`). Omit `uploads` to keep them; send `[]` to clear. |
| PATCH | `/api/ai/guided-story/drafts/:id` | `audioChoices` (or `null`). Never resets cast or backdrop approvals. |

- **Draft responses** add `audioChoices` and `requirementChecks`.
- **Scripts** add `roles[].referenceId` and `scenes[].referenceIds` (max 3).

## Cost

| What | Charged? |
|---|---|
| AI description of an image or video upload | One vision call, at the existing **AI photo description** rate. |
| Transcription | At the normal speech-to-text rate. |
| Voice clone | At the existing Brand Kit clone rate. |
| Footage, music, voiceover and SFX mixing | Free: local ffmpeg, no provider call. |
| Scene prices | Unchanged. |

## Known limits

- **Footage scenes are still rendered (and charged).** The clip then covers them.
  - Why: the scene's generated audio keeps the timeline.
  - Next step: skip the paid render for footage scenes.
- **Uploaded faces depend on the provider.** Some providers refuse uploaded human likenesses; Atlas already blocks uploaded identities. "Fill look from @maya" works everywhere.
- **Uploaded outfits can't replace a saved character's outfit.** The server doesn't support that yet, so they guide the generated character's wardrobe instead.
- **Upload images attach as real references only on Wan reference-to-video.** Seedance, plain image-to-video and legacy preview jobs get the text description. If Wan rejects a scene for too many references, untag an upload in that scene.
- **Timing can drift slightly.** Audio and footage windows come from the rendered timeline when the job records one; otherwise the script timing is scaled to the actual video length.

## Tests

`api-server`:
- `src/lib/videoGen/guidedReferences.test.ts`: handles and mentions, freeze rules, script brief/parse/sanitize, scene prompt, requirements, category, story compliance, PDF/text briefs, ffprobe.
- `src/lib/videoGen/guidedAudioMix.test.ts`: placement validation, finishing plan, and real ffmpeg mixing with footage, music ducking and voiceover replace.
- The existing `videos.test.ts` (318), guided, compliance and Brand Kit product suites all pass.

`socialforge`:
- `src/components/guided-story-references.test.tsx`: category question, banned words only for medical/CA, upload + AI suggestion, audio use dialog, mentions, checklist.
- `guided-story-workflow.test.tsx` was updated to answer the category question.

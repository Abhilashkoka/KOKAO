# Profession Compliance (NMC / ICAI) — setup (v2)

When a brand's **Business / Industry** says *doctor* or *CA*, everything KOKAO
creates for that brand follows a pinned profession rule pack:

| Industry contains | Rule pack | Regulator |
| --- | --- | --- |
| doctor, Dr, physician, clinic, hospital, MBBS/MD, dermatology, IVF/fertility, … | `nmc-medical-advertising` | National Medical Commission |
| chartered accountant, CA, CA firm, ICAI | `icai-ca-advertising` | Institute of Chartered Accountants of India |

Dentistry (DCI) and AYUSH are **not** auto-mapped; the user can pick "Doctor (NMC)" manually.

## Apply

Base: `feat/prompt-kit-script-variants` @ `19e4c5ee` (v1 already applied there).

```bash
git checkout feat/prompt-kit-script-variants
git am compliance-v2.patch          # or: git am -3 compliance-v2.patch
pnpm install
pnpm run typecheck
```

No migration: everything lives in JSON (`brand_kit_versions.json_payload.compliance`,
`video_generations.options.compliance`). A new feature switch, **Compliance AI
Review (NMC / ICAI)** (`complianceAiReview`), is ON by default (no DB row = on).

## What v2 changes

### 1. Enforcement fixes
| Gap (v1) | v2 |
| --- | --- |
| Lookup failures fell back to "no rules" | `resolveJobCompliance` **throws** → 503 `compliance_unavailable`; nothing is funded or generated. Applies to video enqueue, Guided scripts, spokesperson scripts, all caption/post/campaign/carousel generation, scheduling and publishing. |
| Renderer didn't require the acknowledgement | One gate (`complianceGateError`) used by approval **and** by the runner at the start of `produceVideo`, in `renderApprovedClipStoryboard` and on topic resume. Runner requires: no block finding, AI review current, review findings acknowledged. |
| Acknowledgement fingerprinted finding ids | Fingerprint = every reviewed text (narration, dialogue + English meanings, visual prompts) + pinned pack version + facts + negative terms. Any edit voids it (`reviewAcknowledgedContentFingerprint`). |
| Later checks used today's rules | Packs are versioned and immutable (`2026.10.1`, `2026.10.2`). Jobs are checked with their pinned version; an unknown version → 409 `compliance_config`, never a guess. |
| Clip storyboards (text-to-video / animate-photo / slideshow) skipped the render check | Covered by the `produceVideo` / `renderApprovedClipStoryboard` gate; regulated jobs are forced into storyboard review on topic, text-to-video, animate-photo and slideshow. |

### 2. Remaining paths
- **Directed Text-to-Video**: inputs (brief, branding instructions, character description, overlays) checked at enqueue; the director AI gets the rules; its compiled prompt is checked (negative list + AI review) **before the paid provider call**, every attempt.
- **Post-approval polished shot prompts** (`renderVisual`) are checked before the first paid scene. They're excluded from the acknowledged content (machine-written after approval).
- **Spokesperson scripts**: rules injected; the draft's script, on-screen lines and B-roll are checked and shown in the review step (`SpokespersonScriptResult.compliance`).
- **Lip-sync with your own recording**: the recording is transcribed with the configured ASR provider at enqueue and the transcript is checked. If transcription fails → 503, nothing charged.
- **Lip-sync / AI-dialogue typed scripts, localized dubs**: checked at enqueue.
- **Captions & posts**: rules apply even with no brand kit (tenant industry). Scheduling (`POST /schedules`) and all five publish cores (Facebook, Instagram, LinkedIn, X, Threads — used by Publish-now and the scheduler) refuse blocked posts (422) and treat an unavailable check as transient (503 → scheduler retries). The Library editor shows a live check while editing.
- **Retry of a failed regulated job** goes through the same approval review (edited plans are re-reviewed; acknowledgement sent with the retry).
- **Mobile**: Brand Kit "Profession rules" card (Auto / Doctor / CA / Not regulated, registration and qualifications); a compliance badge on each video. Storyboard review stays on the web (as before).

### 3. Smarter checker
- **AI second pass** (`lib/compliance/semantic.ts`): judges meaning against the pinned pack in any language (English, Hindi, Telugu, Tamil, Hinglish), plus claims unsupported by verified facts. Fail-closed, platform-absorbed (shadow funding). Findings must use a real rule id, a real location and quote text that is actually there; it can only add findings. Bound to the content fingerprint and reused when unchanged.
- **Pack `2026.10.2`** adds native-script Hindi/Telugu/Tamil and Hinglish patterns for guarantees, cure claims, superiority, testimonials, inducements, sex selection and tax evasion.
- Brand Kit test box has **Deep check (AI, any language)**.

### 4. Tests
```bash
# unit (pure): packs, pinning, Indic patterns, fingerprints, AI-review parsing, post texts
cd artifacts/api-server && npx vitest run src/lib/compliance
# integration (real Postgres): review→edit→AI review→ack→approve→render gate, AI-review block and outage,
# unknown pinned version, retry, fail-closed lookups, cross-account isolation, scheduling/publishing
DATABASE_URL=… npx vitest run src/routes/compliance.integration.test.ts
cd artifacts/socialforge && npx vitest run src/components/brand-compliance
cd artifacts/mobile && npx vitest run test/brandKitScreen.test.tsx
```
`linkedin.publish.test.ts` (in-memory db stub) now stubs the publish gate; the gate itself is covered by the integration suite.

## API changes
- `ComplianceReport` gains `contentFingerprint`, `aiReview {required, upToDate, reviewedAt}`, `reviewAcknowledged`.
- `POST /brand-kits/compliance/check` accepts `deep: true` (AI pass; 503 if it can't run).
- `POST /ai/video-jobs/:id/retry` accepts `{acknowledgeComplianceReview}`.
- `SpokespersonScriptResult.compliance`; `FeatureFlags.complianceAiReview`.
- Error codes: `compliance_blocked` (400/422), `compliance_review_required`, `compliance_ai_review_required` (400), `compliance_unavailable` (503), `compliance_config` (409).

## Still true (say this to users)
- Neither check is a guarantee. The negative list and AI review reduce risk; a human still reviews every storyboard.
- **Verified facts are self-declared.** KOKAO does not verify registration numbers or qualifications against NMC/State Council/ICAI records.
- **Finished footage isn't inspected.** Visual negatives steer the models and previews are reviewed, but the final video frames aren't machine-checked (e.g. stray generated signage).
- Only NMC and ICAI packs exist — not dentistry (DCI), AYUSH, or other regulated professions.
- Resend of already-published comment/thread chunks isn't re-checked (the post was checked when published).

## Before go-live
1. **Qualified legal review** of `artifacts/api-server/src/lib/compliance/rulePacks.ts` (both versions) — sources are listed per pack. NMC's 2023 RMP regulations were placed in abeyance (Aug 2023) with the 2002 regulations continuing; re-verify before every pack bump.
2. Ship rule changes only as a **new version** via `extendPack` — never edit a published version.
3. ICAI rules **block** (same as NMC). To return to "warn only", ship a new ICAI version with `severity: "review"`.

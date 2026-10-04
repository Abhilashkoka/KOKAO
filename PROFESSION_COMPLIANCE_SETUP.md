# Profession Compliance (NMC / ICAI) — setup

> The second supplied compliance patch is now installed. For its enforcement,
> versioning, semantic-review, publishing and mobile changes, see
> `attached_assets/PROFESSION_COMPLIANCE_SETUP_1_1791120632329.md`.
> The original installation notes below describe the initial patch only.

When a brand's **Business / Industry** says *doctor* or *CA*, everything KOKAO
creates for that brand follows a profession rule pack:

| Industry contains | Rule pack | Regulator |
| --- | --- | --- |
| doctor, Dr, physician, clinic, hospital, MBBS/MD, dermatology, IVF/fertility, gynaecology, … | `nmc-medical-advertising` | National Medical Commission |
| chartered accountant, CA, CA firm, ICAI | `icai-ca-advertising` | Institute of Chartered Accountants of India |

Dentistry (DCI) and AYUSH systems are **not** auto-mapped to NMC; the user can pick
"Doctor (NMC)" manually in the Compliance tab.

## Apply

Base: `feat/prompt-kit-script-variants` @ `326130eb`.

```bash
git checkout feat/prompt-kit-script-variants
git am profession-compliance.patch      # or: git am -3 profession-compliance.patch
pnpm install
pnpm run typecheck
```

No database migration: the profile lives inside the brand kit's JSON payload
(`compliance`) and the job snapshot inside `video_generations.options`
(`compliance`). The generated API clients (`lib/api-zod`, `lib/api-client-react`)
are included; re-run `pnpm --filter @workspace/api-spec codegen` only if you
change `openapi.yaml` again.

## What it does

**1. Brand Kit → Compliance tab** (`components/brand-compliance.tsx`)
- Auto-detects the profession from Industry/Description, shows it, and asks the
  user to **Confirm**. They can override to Doctor / CA / "Not a regulated
  profession" (an explicit opt-out is the only way to switch rules off).
- **Verified facts**: name, registration no., registering council/ICAI,
  qualifications, services, address, other verified claims. The AI may state
  only these; any other credential, count, success rate or years of experience
  is flagged.
- **Never use these words**: extra negative list on top of the pack (the kit's
  existing restricted terms are enforced too).
- Rule list with sources, and a **Test a caption or script** box.

**2. Generation (rules go into every prompt)**
- Captions / posts / campaigns / carousels (`routes/ai.ts`, 5 prompt builders).
- Video scripts (topic, hybrid, screen-demo, presenter) via the brand-voice hint.
- Guided Story screenplay (`brandConstraints`).
- Visual / image / B-roll prompts get the pack's visual negatives (no patients,
  no before/after, no awards, no prices, no generated text/signage…).

**3. Checks (the negative list runs on the output)**
`lib/compliance/check.ts` scans spoken narration, dialogue (and the English
meaning of Hindi/Telugu/Tamil lines), on-screen titles and **visual prompts**.

| Gate | Blocking findings | Review findings |
| --- | --- | --- |
| Text-to-video / animate-photo prompt, localized-dub script (at enqueue) | rejected (400) | allowed |
| Guided Story script approval | rejected | allowed |
| Storyboard edit (PATCH) | rejected only if the edit **adds** one | allowed |
| Storyboard approval | rejected | need the "I have reviewed" tick (`acknowledgeComplianceReview: true`), recorded on the job with user + fingerprint |
| Render (job runner, whenever a saved storyboard is rendered) | job fails before any billable render | already acknowledged |

- Regulated jobs are forced into storyboard review (topic-to-video), so nothing
  renders without a human seeing the findings panel.
- The compliance snapshot (pack id + version, facts, negative terms) is frozen
  onto each job at enqueue, so a later Brand Kit edit can't loosen an in-flight job.
- Resolution order: job's kit → tenant default kit → tenant Business/Industry.
  It does **not** depend on the `brandVideo` kill switch.

## API

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/api/brand-kits/compliance/rule-packs` | Packs, rules, sources |
| POST | `/api/brand-kits/compliance/detect` | `{industry, description?}` → `{profession}` |
| POST | `/api/brand-kits/compliance/check` | `{text, brandKitId?, industry?, compliance?, restrictedTerms?, field?}` → report |
| POST | `/api/ai/video-jobs/:id/storyboard/approve` | now accepts `{acknowledgeComplianceReview}` |
| — | `VideoJob.compliance` | `{profession, packId, packVersion, reviewAcknowledgedAt, report}` |

Errors carry `code: "compliance_blocked" | "compliance_review_required"` and a
`compliance` report.

## Tests

```bash
# rule packs, detection, checker, gates, prompts (no DB needed)
cd artifacts/api-server && npx vitest run src/lib/compliance
cd artifacts/socialforge && npx vitest run src/components/brand-compliance
```

The api-server's default vitest config needs `DATABASE_URL`; the compliance
tests themselves are pure.

## Before go-live — please do

1. **Legal review of the rule packs** (`artifacts/api-server/src/lib/compliance/rulePacks.ts`).
   They are an engineering translation of:
   - IMC (Professional Conduct, Etiquette and Ethics) Regulations, 2002 — NMC put
     the 2023 RMP regulations in abeyance (23 Aug 2023) and directed the 2002
     regulations to continue. Re-verify this status before each pack bump.
   - Drugs and Magic Remedies (Objectionable Advertisements) Act, 1954; CCPA
     misleading-ads guidelines 2022; PC&PNDT Act 1994 / ART Act 2021 (IVF).
   - CA Act 1949, First Schedule Part I Clauses (6), (7), (10); ICAI Advertisement
     Guidelines 2008 (No.1-CA(7)/Council Guidelines/01/2008); ICAI Code of Ethics.
2. Bump `version` on a pack whenever a rule changes (jobs record the version).
3. Your earlier stance on ICAI was "warn, user's responsibility". This patch
   **blocks** ICAI violations the same way as NMC. To soften it, change the
   ICAI rules' `severity` from `"block"` to `"review"`.

## Limits (be honest with users)

- The negative list catches common wording and paraphrases; it cannot catch every
  way a model might phrase a prohibited claim. Storyboard review stays mandatory.
- Video models can still draw things the prompt forbids (e.g. stray signage).
  Previews are reviewed before render; final footage is not machine-checked.
- Not yet covered: the standalone spokesperson-script generator, lip-sync with a
  user-recorded take, and post-generation checks on captions (prompt rules only —
  use the Brand Kit test box or wire `/compliance/check` into the composer next).

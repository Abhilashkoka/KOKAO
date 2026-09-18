# Universal likeness attestation — setup

Makes the likeness-rights record provider-independent, extends it to
AI-generated photorealistic characters, moves collection to character creation,
and adds a reviewed per-provider eligibility table so a provider that will
refuse a face is never routed one.

Applies on top of `feat/prompt-kit-script-variants`.

```bash
git am likeness-attestation.patch
pnpm install
```

## Run order — the migration is two steps with a script between them

The legacy `providers` / `image_processor_scope` columns have to be read before
they are dropped, and recovering a provider id from a human label
(`"outfit|OpenAI (built in, no key needed) / gpt-image-1"`) is not something to
attempt in SQL.

```bash
# 1. Additive. Adds columns and tables, keeps the legacy columns, and strips the
#    ":image-processors:<hash>" suffix from existing policy versions.
psql "$DATABASE_URL" -f lib/db/sql/2026-09-18_universal_likeness_attestation.sql

# 2. Move recipients into the ledger. Dry run first; idempotent; exits non-zero
#    and tells you which grants to look at if any label cannot be mapped.
node scripts/src/backfill-likeness-recipients.mjs --dry-run
node scripts/src/backfill-likeness-recipients.mjs

# 3. Only once step 2 reports a clean run.
psql "$DATABASE_URL" -f lib/db/sql/2026-09-18_universal_likeness_attestation_cleanup.sql

# 4. Should report no drift.
pnpm --filter @workspace/db run push
```

Do not run step 3 while step 2 is still reporting unmapped labels — those users
would silently have to re-acknowledge their image recipients.

Rolling back after step 1 alone is safe: the legacy columns are still there.

## What existing users see once

Every current grant was written under the old statement text, which did not
separate video depiction from scripted speech. The migration infers
`allow_video_depiction` from `allow_scripted_speech`, and the new statement text
carries a new `LIKENESS_CONSENT_POLICY_VERSION`, so existing grants read as
`stale` and are re-asked for **once**, at the migration boundary.

That is the deliberate trade. The point of the change is that it does not happen
again when a provider changes — only when the statement itself changes.

## Environment

| Variable | Default | Effect |
|---|---|---|
| `LIKENESS_STANDING_DECLARATION_ENFORCED` | unset (record-only) | `true` makes a missing workspace declaration block generated-character work instead of only being reported. Leave unset on the first deploy; flip it after workspaces have been prompted. |

## Two layers

The attestation is about the person. The recipients are about who receives them.

- **Subject attestation** — `character_likeness_consent_grants`. Adult, image
  rights, self vs authorized person, and the three separable uses (wardrobe
  editing, video depiction, scripted speech). Bound to exact source bytes.
  Unaffected by routing changes.
- **Recipient ledger** — `character_likeness_recipient_disclosures`, append-only,
  one row per (grant, provider, model, operation) the user accepted, with
  per-recipient withdrawal in `character_likeness_recipient_revocations`.

So a newly configured provider costs one **Confirm** click, not a re-signature,
and withdrawing one provider does not destroy an attestation that is still true.

`LIKENESS_CONSENT_POLICY_VERSION` no longer hashes the selected image
processors. That hash is why an admin changing the global image provider used to
mark every attestation in the system stale.

## Three subject classes

| Class | Gate |
|---|---|
| `uploaded_self` | Hard. Per-character grant + acknowledged recipient. |
| `uploaded_authorized_person` | Hard, plus a written-permission declaration. |
| `generated_fictional` | Workspace standing declaration. Recorded by default, blocking behind the env flag. |

The third class is new. Every photorealistic AI character previously carried no
record at all — and those are the ones Replicate and OpenRouter keep rejecting.
The declaration is the evidence that the face depicts nobody real.

## Provider eligibility

`artifacts/api-server/src/lib/likenessProviderPolicy.ts` is the single reviewed
table, one entry per provider per surface, with two independent axes
(`realLikeness`, `generatedPhotorealistic`) because a classifier that refuses a
real face usually refuses a generated one too.

`undeclared` fails closed. `likenessProviderPolicy.test.ts` asserts
exhaustiveness against `IMAGE_GEN_PROVIDERS` and `VIDEO_GEN_PROVIDERS`, so a
newly added provider fails the suite until someone records a position. That is
the "no problem in the future" guarantee: it is not possible to add a provider
and have it silently start receiving faces.

Current positions, and what would change them:

| Provider | Real | Generated | Note |
|---|---|---|---|
| `openai` (image) | accepted | accepted | Already the disclosed wardrobe/sheet processor; exact masked edits leave the identity region untouched. |
| `atlascloud` (video) | accepted, Wan reference models only | accepted, any model | Asset Library is fine for generated, never for a real person. |
| `byteplus` (video) | accepted | accepted | Real likeness additionally requires BytePlus's own identity verification. |
| `replicate`, `openrouter` | refused | refused | Observed to reject photorealistic humans, generated sheets included. |
| `custom` | refused | refused | An admin-entered base URL is an undisclosed recipient by construction. |
| `gemini`, `bfl`, `seedream`, `stability`, `higgsfield`, `nvidia` | undeclared | undeclared | Not verified for this workflow. Each entry states what evidence would move it. |

Move an entry to `accepted` only after reading that provider's current terms and
the exact model contract. A consent record does not make a classifier accept an
image, and this table is what stops KOKAO paying to find that out.

**Routing is checked before the attestation and before funding.** A refused
provider is a fast explained failure rather than a paid rejection, and the user
is never asked to sign for a submission that could not have succeeded.

## Collection moved to creation

`POST /characters` now takes `likenessAttestation` and writes the grant in the
**same transaction** as the character row, plus disclosures for the recipients
the reference sheet is about to use.

Previously the attestation was a separate call behind a panel mounted in two
screens, so a character could be created, sheeted and dressed — spending image
credits at each step — and only fail at video funding.

`likenessAttestation.policyVersion` is optional. The creation form shows a
summary rather than the server statement verbatim, so asserting "I saw exactly
version X" would add a round trip without adding the protection it implies; the
server stamps its own version and stores the authoritative statement text. The
standalone grant route, where the server statement *is* displayed verbatim,
still requires an exact match.

## New endpoints

```
POST   /characters/:characterId/likeness-recipients
DELETE /characters/:characterId/likeness-recipients/:disclosureId
GET    /characters/likeness-declaration
POST   /characters/likeness-declaration
```

`GET /characters/:characterId/likeness-consent` gains `subjectClass`,
`recipients`, `pendingRecipients`, a `needs_recipient_acknowledgement` status,
and an `eligibility` array covering every catalogued provider rather than two
hard-coded Atlas rows.

## Frozen job snapshots

`PersonalLikenessVideoSnapshot` is now a version union. Existing `version: 1`
rows stay readable and keep rendering under exactly the authorization they were
funded against; new ones are `version: 2` with `provider`/`model` as strings
plus `subjectClass` and `recipientDisclosureId`.

A job stays bound to the grant **and** the disclosure it was funded against, so
it can never ride a newer attestation or a re-acknowledgement of the same
provider under a different model. Legacy v1 rows carry no disclosure id, so they
require the equivalent live record instead.

## Verification

```bash
pnpm --filter @workspace/api-server exec vitest run --config vitest.likeness.config.ts
pnpm --filter @workspace/api-server exec vitest run --config vitest.personal-likeness.config.ts
pnpm --filter @workspace/socialforge exec vitest run
pnpm --filter @workspace/mobile exec vitest run
```

As landed: api-server likeness suites 48 passing (was 22), socialforge 1130
passing, mobile 414 passing, and `tsc --noEmit` clean in api-server,
socialforge and mobile.

The migration sequence above was run end-to-end against a live Postgres with
two realistic legacy grants: backfill is idempotent, re-running after cleanup is
a no-op, and `drizzle-kit push` reports no drift afterwards.

## Not in this patch

`video-studio.tsx` still has four per-attempt checkboxes — `lipSyncConsent`,
`aiPersonConsent`, `studioLipSyncConsent`, and the guided-story `consent` whose
own comment says *"identity consent is per request, never persisted by this
component."* They gate a button and vanish, and none of them writes a grant row.

They are now redundant with the durable record for any uploaded character, but
unifying them touches the studio's generation gating broadly and is better as
its own change. They do not block anything and nothing regressed, so they are
left alone here rather than half-migrated.

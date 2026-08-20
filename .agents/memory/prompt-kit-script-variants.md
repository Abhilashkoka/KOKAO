---
name: Prompt Kit script variants
description: Base-plus-variant prompt resolution, script cleanup, intake context, and the additive-only installation rule.
---

The `video_script` flow is governed by TWO prompt cases at once: a BASE case (`variant_key IS NULL`, slug `topic-video-script`) holding rules every script obeys, and an optional VARIANT case (`marketing` / `training` / `social_short`) holding only what that kind of video does differently. `loadActiveCasePrompt(flowKey, variantKey)` resolves the exact variant first, falls back to the base, and returns `null` (built-in prompt) if neither is governed — so an unseeded variant degrades instead of failing.

At compile time the base blocks are prepended to the variant's, with the variant's `order` shifted by `VARIANT_BLOCK_ORDER_OFFSET` (1000). **A variant author does not repeat the shared rules** — writing them again just duplicates tokens in every completion.

`prompt_case_types` has two partial unique indexes (`..._flow_base_uniq`, `..._flow_variant_uniq`) rather than one, because Postgres treats each NULL as distinct: a single `(flow_key, variant_key)` index would still allow ten active base cases for one flow. Anything that creates or imports cases must key clash-detection on the PAIR — `promptKitAdmin.ts`'s bundle import learned this the hard way.

**The `cleanScript` trap.** `cleanScript` strips every `[bracket]` from spoken text, which is correct — a voice engine must never read a cue. But it used to do so silently, which meant a `[VERIFY: ...]` flag (the mechanism that stops the model inventing statistics) vanished without trace. Use `cleanScriptDetailed`, which also returns `stripped`, and lift the flags out via `collectOpenItems`. Beat-level text keeps its cues and uses `cleanCuedText` instead. If you add a new path that cleans model output, decide explicitly which of the three it needs.

**Where Block C comes from.** `resolveScriptInputs` builds the compiler's Context layer. Roughly 70% resolves with no user input at all — `brand_kits.payload` gives audience, tone, CTA style, brand terms and restricted terms; `video_style_profiles.payload` gives `scriptGuidance` and the measured `wordsPerMinute` that sets the word budget. The rest comes from `analyzeScriptIntake`, a ~200-token pre-pass that extracts only facts the topic ACTUALLY asserts and reports the remaining gaps; the studio asks about those and nothing else.

Brand values are resolved **server-side from `brandKitId`**. A client sends ids, never brand rules — and `bannedTerms` is a union of client and brand lists so a client can add restrictions but never shorten them. Everything reaching the prompt goes through `sanitizeLine`, which flattens newlines specifically so a value cannot forge a `## Mandatory instructions` heading.

**Seeds vs bundles.** Prompt Kit transfer imports are upserts: a matching slug, template, and version number can update stored content and promotion pointers. Feature-install bundles must therefore be additive-only and contain no existing base-case slugs. Script variants ship as four new draft cases only; a human reviews and promotes them deliberately. Never generate an install bundle by mapping every seed.

**Why:** A broad script-variant bundle was imported into a populated environment and replaced version-1 content while clearing five live production pointers. Restoring source code must never be coupled to rewriting recovered Prompt Kit data.

**How to apply:** Keep base prompts out of feature-install assets, assert the exact allowed slugs in a transfer regression, and snapshot an existing promoted prompt before/after the import. General Prompt Kit exports remain appropriate for intentional environment transfer, not feature installation.

Adding a value to `PROMPT_FLOW_KEYS` requires four matching edits or a test fails: the schema enum, a base-case seed (`unseededFlowKeys` asserts full coverage), the flowKey enums in `openapi.yaml` (there are five, kept identical), and `FLOW_KEYS` in `admin/prompt-kit/cases-section.tsx`. `video_motion` was seeded server-side but missing from the last two for a while, which made its case invisible in the admin UI.

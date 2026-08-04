---
name: Prompt Template Kit governance
description: Fail-open governed prompt contract, layer order, single-active-template rule, and customization auto-pick for KOKAO generation flows.
---

# Prompt Template Kit

## Fail-open contract
`getGovernedPrompt` (api-server lib/promptKit.ts) must NEVER throw into a generation path. Any error, missing case, missing active template, or missing production version returns `null` and the flow uses its built-in system prompt exactly as before.
**Why:** governance is optional; a bad template or DB hiccup must never break or bill a paid generation.
**How to apply:** any new governed flow wraps the lookup in the same null-check pattern; the built-in prompt stays as the fallback, and `logCompiledPrompt` is best-effort only (never affects funding settle/refund).

## Layer order (invariant)
global system rules → mandatory admin blocks → base template blocks → user customization → runtime context/user input → output format. User customization can never displace mandatory blocks; output/JSON contracts (incl. streaming platform-before-caption ordering) are ALWAYS appended after the governed prompt.

## Single active template per case
Exactly one active (non-archived) template per case type — enforced at template create AND on reactivation; the pipeline lookup additionally filters to templates with a production pointer and orders desc(id) for legacy dupes.
**Why:** the pipeline resolves the live prompt per case; a second active template makes promotion/rollback silently ineffective.

## Lifecycle atomicity
Promotion/rollback (demote previous production version + repoint template pointers + version lifecycle update) runs in ONE db.transaction.
**Why:** partial failure splits pointer vs. version state and silently fails open.

## Customization selection
Generation requests carry NO customizationId; the user's newest ACTIVE customization for the case is auto-applied (users control by enabling/disabling). Background video-script jobs have no user session → no per-user customization (clerkUserId "" + customizationId null).

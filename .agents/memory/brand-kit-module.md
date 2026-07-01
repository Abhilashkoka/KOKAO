---
name: Brand Kit module (SocialForge)
description: Non-obvious architectural decisions for the versioned brand-kit module — session-scoping, payload preservation, contract sync.
---

# Brand Kit module — durable decisions

## Endpoints are SESSION-scoped, not tenant-in-URL
`/brand-kits`, `/brand-preferences`, `/onboarding` take NO `tenantId` in the URL. This is deliberate IDOR avoidance — the tenant is always derived from the session (`req.tenantId`).
**Why:** exposing tenantId in the path invites cross-tenant access via id-swapping. **How to apply:** never "add tenantId to the URL for clarity"; scope every DB query by `req.tenantId` (and validate kit ownership before touching sub-resources like assets/versions/preferences).

## Payload is a versioned-JSON source of truth
Brand identity lives in `brand_kit_versions.json_payload` (typed `BrandKitPayload`), not flat columns. Editing = create a NEW version and activate it, not mutate in place.
**Why:** history/rollback + the 9-section spec schema. **How to apply:** the frontend edit flow must DEEP-CLONE the active payload and spread-preserve untouched sections (typography, layout_tokens, channel_rules, brand_controls, logos) — only override edited sections, or you silently drop data.

## OpenAPI contract must stay in lockstep with routes
The generated client defines operations from `openapi.yaml`; a missing server handler (e.g. `GET /brand-kits/:id/assets`) compiles fine but 404s at runtime for generated consumers.
**Why:** codegen trusts the spec, not the server. **How to apply:** when adding/altering any brand-kit path in the spec, implement every method the spec declares, and grep the generated `api.ts` for the operationId to confirm parity.

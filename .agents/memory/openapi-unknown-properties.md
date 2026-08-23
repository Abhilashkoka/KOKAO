---
name: OpenAPI unknown-property validation
description: Why additionalProperties false is not sufficient runtime rejection for security-sensitive generated request schemas.
---

Treat `additionalProperties: false` as an API contract and type-generation constraint, not proof that runtime validation rejects extra keys. The generated Zod parser can strip unknown properties and return a successful parse.

**Why:** Silent stripping is unsafe when the boundary must prove that arbitrary nested paths, IDs, or tenant-owned data were rejected rather than merely ignored.

**How to apply:** At security-sensitive write boundaries, inspect raw request object keys against an explicit allowlist before generated parsing, then use the generated schema for known-key value validation.
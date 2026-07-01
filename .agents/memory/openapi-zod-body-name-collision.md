---
name: OpenAPI zod body name collision
description: Why a request-body component schema can break codegen with a duplicate-export error, and how to name it.
---

The zod codegen (`@workspace/api-zod`) derives a request-body schema name from the
operationId: operationId `updateNotificationSettings` → exported `UpdateNotificationSettingsBody`.
The barrel re-exports BOTH the operation-derived zod schemas (`./generated/api`)
and the component-schema types (`./generated/types`). If you name a component
schema exactly `<OperationId>Body`, both files export the same identifier and
`tsc --build` fails with TS2308 "already exported a member named ...".

**Why:** operationId-derived name and component-schema name land in the same barrel namespace.

**How to apply:** Never name a request-body component schema `<PascalOperationId>Body`.
Give it a distinct name (e.g. `NotificationSettingsInput`) and `$ref` it from the
path. Note admin-prefixed operationIds (e.g. `adminUpdate...` → `AdminUpdate...Body`)
usually won't collide with an unprefixed schema name, so only the matching one breaks.
The zod validator you import in the route is still the operationId-derived name.

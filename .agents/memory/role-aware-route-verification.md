---
name: Role-aware route verification
description: Superadmin-only development checks can conceal access failures for ordinary production users.
---

Verify shared user endpoints as a non-superadmin as well as an administrator.

**Why:** An admin router mounted at the API root applied its permission check to later unrelated routers. Development administrator sessions concealed the bug while ordinary production users lost credit balances and notifications.

**How to apply:** In routing regressions, mount the real router before a representative tenant endpoint and assert that ordinary requests pass through, while admin paths remain forbidden. Do not fix middleware leakage merely by reordering routers.
---
name: Publish Python autodetection
description: Why unused root Python metadata can break publishing in this PNPM-only workspace.
---

Keep Python project metadata out of the repository unless the product actually uses Python. A root `pyproject.toml` makes publishing run `uv lock` even when all artifact services are Node/PNPM.

**Why:** An unused template `pyproject.toml` caused a publish build to fail because Replit treated the stale `.pythonlibs` directory as a virtual environment, but it contained no Python executable.

**How to apply:** If a publish build unexpectedly invokes `uv`, first verify whether Python is genuinely used. Remove only confirmed-unused Python placeholders; do not repair or add a virtual environment to a PNPM-only application.
---
name: Native dialogs blocked in preview iframe
description: window.confirm/alert/prompt silently fail in the Replit preview pane
---

Never use `window.confirm`, `alert`, or `prompt` in frontend code. The Replit preview pane is a sandboxed iframe that blocks native dialogs — `confirm()` returns false silently, so the guarded action simply never fires and looks like a dead button.

**Why:** A delete button guarded by `confirm()` appeared completely broken to the user; no error, no console output.

**How to apply:** Use an in-app Dialog (shadcn) for any confirmation. Also useful when e2e-testing: assert the in-app dialog appears rather than handling a native confirm.

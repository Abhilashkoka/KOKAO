---
name: JSX generic instrumentation
description: Explicit JSX type arguments can fail the instrumented Vite build even when TypeScript and Vitest pass.
---
Avoid explicit JSX type arguments in web components; infer generic props instead, using NoInfer on secondary inputs when needed.

**Why:** Replit's component metadata instrumentation inserted attributes between a JSX component name and its type arguments, producing invalid JSX during the production-style preview build. Type checks and component tests did not exercise that transform.

**How to apply:** When a generic component passes TypeScript but the Vite build reports `Expected ">" but found "<"` beside injected metadata, remove explicit JSX type arguments without weakening the prop types.
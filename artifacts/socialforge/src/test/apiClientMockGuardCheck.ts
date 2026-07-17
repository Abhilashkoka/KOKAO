import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";

/**
 * Guard: every test that mocks `@workspace/api-client-react` must build the
 * mock through the shared resilient helper (`createApiClientMock` from
 * `src/test/apiClientMock.ts`).
 *
 * Hand-written object factories hand-list generated hooks, so they silently
 * go stale whenever a page imports a new hook and unrelated tests then fail
 * with "No <hook> export is defined".
 *
 * This module holds the actual check so it can run from BOTH:
 * - the guard test file (nice reporting inside a full suite run), and
 * - vitest globalSetup (always executes, even when tests run selectively
 *   via `vitest related` or path filters).
 */

export const MOCK_TARGET = "@workspace/api-client-react";

const SRC_ROOT = path.resolve(import.meta.dirname, "..");
const GUARD_TEST_PATH = path.resolve(import.meta.dirname, "apiClientMockGuard.test.ts");

function collectTestFiles(dir: string): string[] {
  const results: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    const stats = statSync(full);
    if (stats.isDirectory()) {
      if (entry === "node_modules") continue;
      results.push(...collectTestFiles(full));
    } else if (/\.test\.(ts|tsx)$/.test(entry)) {
      results.push(full);
    }
  }
  return results;
}

/**
 * Extract each `vi.mock("@workspace/api-client-react", ...)` call (including
 * its factory body) by balancing parentheses from the call site.
 */
function extractMockCalls(source: string): string[] {
  const calls: string[] = [];
  const pattern = /vi\.mock\(\s*["'`]@workspace\/api-client-react["'`]/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(source)) !== null) {
    const start = match.index;
    let depth = 0;
    let end = source.length;
    for (let i = source.indexOf("(", start); i < source.length; i++) {
      const ch = source[i];
      if (ch === "(") depth++;
      else if (ch === ")") {
        depth--;
        if (depth === 0) {
          end = i + 1;
          break;
        }
      }
    }
    calls.push(source.slice(start, end));
  }
  return calls;
}

export function findMockGuardOffenders(): string[] {
  const offenders: string[] = [];
  for (const file of collectTestFiles(SRC_ROOT)) {
    if (file === GUARD_TEST_PATH) continue;
    const source = readFileSync(file, "utf8");
    if (!source.includes(MOCK_TARGET)) continue;

    for (const call of extractMockCalls(source)) {
      if (!call.includes("createApiClientMock")) {
        offenders.push(path.relative(SRC_ROOT, file));
      }
    }
  }
  return offenders;
}

export function buildOffenderMessage(offenders: string[]): string {
  return (
    `These test files mock "${MOCK_TARGET}" without the shared resilient helper:\n` +
    offenders.map((f) => `  - ${f}`).join("\n") +
    `\nHand-listed hook mocks go stale and break unrelated tests when pages import new hooks.\n` +
    `Fix: inside the vi.mock factory, lazily import and return createApiClientMock(overrides):\n\n` +
    `  vi.mock("${MOCK_TARGET}", async () => {\n` +
    `    const { createApiClientMock } = await import("../test/apiClientMock");\n` +
    `    return createApiClientMock({ /* per-test overrides */ });\n` +
    `  });\n\n` +
    `See artifacts/socialforge/src/test/apiClientMock.ts.`
  );
}

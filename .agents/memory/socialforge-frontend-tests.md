---
name: SocialForge frontend component tests
description: How to write React component/rendering tests for the socialforge web artifact (vitest + Testing Library + jsdom).
---

# SocialForge frontend component tests

The socialforge web artifact has a component-test harness (first use: the Accounts
page reconnect-prompt regression guard). Setup + conventions that aren't obvious:

- **Separate vitest config.** `vite.config.ts` THROWS when `PORT`/`BASE_PATH` are
  unset (workflow-injected), so a plain `vitest run` cannot reuse it. There is a
  standalone `vitest.config.ts` (react plugin + the `@`/`@assets` aliases +
  `environment: "jsdom"`). Run with `pnpm --filter @workspace/socialforge run test`.
- **Test files are typechecked.** They live under `src/**/*.test.tsx` and are
  included by the app `tsconfig` (only `**/*.test.ts` is excluded, not `.tsx`), so
  they must compile. Import `describe/it/expect/vi` from `"vitest"` explicitly.
- **Mock the generated API module wholesale.** `vi.mock("@workspace/api-client-react", ...)`
  returns fake hooks reading from a mutable `mockState` object (name must start with
  `mock` to satisfy vitest hoisting). This drives status-based UI (verified/failed/
  expired) without any network or real react-query fetching. Also mock
  `@/hooks/use-toast`. Still wrap render in a real `QueryClientProvider` because
  components call `useQueryClient()` at top level.
- **Scope assertions per platform card via the `.flex-1` wrapper.** The shadcn
  `Card` is a plain div (no `data-slot`); each card's heading + status pill +
  reconnect callout share one `.flex-1` ancestor, so `heading.closest(".flex-1")`
  isolates a single platform's UI. Assert on the distinctive callout sentence
  (e.g. "Enter a fresh Page access token below to reconnect") rather than the
  shared "Reconnect needed" label.

**Why:** the Accounts page reconnect prompts are pure functions of the status
hooks; a UI refactor could silently drop them. A mocked-hook rendering test is the
faithful, fast guard (proven by mutation: disabling the callouts fails the tests).

- **Wholesale api-client mock rots as pages grow.** Any new platform hook used
  by a page (e.g. YouTube/Threads on Accounts) breaks existing tests with
  "No X export is defined on the mock" — extend the `vi.mock` factory and
  `mockState` (seed new platforms `{ configured: false }` so they stay inert).
- **Char-limit warning tests derive expected values FROM `@workspace/social-limits`**
  (studio/library/campaign-card tests): assert displayed counts/over-by equal
  helper outputs and previews equal the trim helpers; verified by mutation.
  Radix menus/dialogs in jsdom need `hasPointerCapture`/`scrollIntoView`/
  `ResizeObserver` stubs + `@testing-library/user-event` to open dropdowns.

- No jest-dom matchers are installed: `toHaveValue`/`toBeInTheDocument` throw "Invalid Chai property". Use plain assertions on `(el as HTMLInputElement).value` / `toBeTruthy()`.

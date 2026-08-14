---
name: Merge-mangled test files
description: How parallel task-agent merges corrupt large shared test files and how to repair them.
---

Parallel task-agent merges can corrupt big shared test files (e.g. the studio page suite): whole `it` blocks get duplicated into the wrong `describe`, helpers end up referenced out of scope (typecheck breaks), and some merged tests arrive mis-authored (wrong testid/expected values) even though the merge "succeeded".

**Why:** many agents edit the same test file concurrently; the platform merge resolves conflicts block-by-block and can splice duplicates.

**How to apply:** when a shared test file suddenly fails typecheck or has duplicate test names after merges, don't hand-patch line by line. Diff `grep -n 'describe(\|  it('` output against the last-known-good pre-merge revision (`git show <rev>:path`), then splice whole describe blocks from the good revision while keeping legitimately new describes/tests. Verify each surviving new test's assertions against the actual component (testids, amounts) — merged tests can be wrong as authored.

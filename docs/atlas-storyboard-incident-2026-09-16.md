# Atlas storyboard incident — Job #84337

## Evidence (read-only)

- The development database contains Job #84337; the production read-only query returned no matching row.
- The job failed at `2026-09-16T11:37:06.743Z`, during “Animating your storyboard”. Its frozen model is `atlascloud / alibaba/wan-3.0-prime/reference-to-video`, 1080p with audio enabled, explicit duration policy, and three Guided Story scenes.
- Retained API workflow logs record a `VideoJobInputError` for this job at `11:37:06.737`: the Guided Atlas reference resolver rejected the first scene for lacking a frozen approved Atlas sheet/outfit. The stack points to the resolver before video provider dispatch. The generic customer `provider_error` was allow-listed replacement copy, not the underlying provider response.
- Both saved cast members have generated provenance, character/outfit IDs, nonempty approved sheet paths and SHA-256 hashes, outfit images, and matching character/outfit approval paths. Both explicitly have `requiresAtlasAsset:false` and null Atlas library/generation reference IDs.
- The saved job has no `options.providerTasks`, top-level prediction ID, or provider request ID. No rendered scene checkpoint was recorded. No Atlas status GET could be made without an accepted prediction identifier; none was invented.
- No deployment logs matched the incident window. The retained development API workflow log supplied the relevant stack.

## Confirmed defect

The enqueue path intentionally prepares Wan references without Seedance Asset Library IDs. The pre-fix storyboard resolver nevertheless required those IDs before reaching its Wan HTTPS-reference branch. A valid Wan snapshot therefore failed locally before submission. This is not evidence of an Atlas model rejection, account-credit problem, or polling timeout.

The correction separates Wan approved-image resolution from Seedance Asset Library checks. Wan still validates tenant ownership, generated provenance, approval paths, sheet/outfit hashes, and approved backdrops; it does not acquire or bypass provider assets. The adapter's model, HTTPS reference contract, explicit duration, polling deadline, submit fences, and accepted-task recovery remain intact.

## Safety and recovery

No historical job record was changed, no restart/retry was requested, and no paid prediction was created during this investigation. Existing accepted tasks on other jobs remain reusable through supported recovery rather than repeat POSTs. Correcting the defect does not automatically run Job #84337 or guarantee that historical references remain available.

New failures retain safe categories and available correlation while customer history excludes raw provider text, prompts, credentials, and signed media URLs. A prediction ID is not a request ID; an absent request ID remains absent.

## Verification

Regression coverage exercises a valid Wan cast with no Seedance IDs, failed reference validation, terminal prediction failure, absent request IDs, output handling, and accepted-task resume without another POST. Frontend history coverage asserts a visible job number, safe guidance, and “not recorded” for a missing request ID. All provider calls in these tests are mocked.

Final focused API run: 178 passed, 3 failed across the three requested files. Atlas adapter tests passed 28/28; clip storyboard tests passed 41/41; runner tests passed 109/112. The three failures concern Telugu cloned-speech metadata and two ElevenLabs localized-dub fixtures, not the Wan reference path. They were left outside this incident fix; the overall API regression baseline is not green.

The Video Studio frontend file passed 146 tests, and the frontend suite passed 1117 tests. API TypeScript checking and whitespace checks passed. The API workflow rebuilt and started successfully, public API requests returned 200, and the app preview rendered normally. The long-running configured test workflow also reported broader unrelated failures; it overlapped implementation and is not the final focused result above.

Three additional runner-only regressions passed after that run: terminal Atlas failure finalization, accepted-task polling failure finalization, and invalid Wan approved-reference evidence. They verify task retention, absent request IDs, safe history with job identifiers, and no paid render when reference validation fails.
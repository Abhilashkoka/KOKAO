# Character uniformity — one costume, one look, unless the user says otherwise

`character-uniformity.patch` · apply after `render-and-routing-fixes.patch` (`d325832`)

## Apply

```bash
git apply character-uniformity.patch
pnpm -w run typecheck
pnpm --filter @workspace/api-server run test src/lib/videoGen/topicVideo
```

The test line needs `DATABASE_URL` in the environment like every api-server run
does, because the suite's global setup checks the schema before any test
executes. This patch's own tests are fast — they mock the text-generation client
the way the neighbouring tests already do — but the two files it touches sit
beside the real-ffmpeg tests from the render patch, so scoping the run at
`topicVideo` still spawns an encoder and takes a couple of minutes.

**Apply this one on top of the render patch, not on `origin/main`.** Both patches
edit `topicVideo/aiBroll.ts`: the render patch pinned the still-image input to
30 fps and split out `buildStillToClipArgs`, and this patch edits the art
director a few dozen lines above that. Applied in order they are independent;
applied out of order you will be resolving a conflict for no reason.

**No `db:push` and no codegen.** Nothing here touches the database or the API
contract. Both changes live inside two files under
`artifacts/api-server/src/lib/videoGen/topicVideo/` — one LLM prompt, one JSON
parse, one clamp — and no schema column and no OpenAPI operation describes any
of it. `lib/db/src/schema/` and `lib/api-spec/openapi.yaml` come out of this
byte-for-byte unchanged, so the generated client is unchanged and a drift check
passes without being run. No new dependency, no new secret, and deliberately no
feature flag: the old behaviour is the bug, and a switch to turn the fix off
would only preserve it.

## What it does

**A character could change clothes without anyone asking.** The Video Scene
Director's third rule read `Default to <locked outfit> unless the story or the
wardrobe instructions call for a change at that moment`. That "or the story"
clause is the whole defect — it gave the model standing permission to redress the
character whenever a scene felt like a different moment, so a user who picked one
outfit and wrote nothing else could still watch their character walk through
their own thirty-second video in three costumes. Nothing downstream could catch
it either: the plan the director returned was taken at face value as long as the
outfit id existed in the wardrobe, and a costume change is a perfectly valid id.

Costume changes now require the user to have actually written wardrobe notes, and
that holds in two layers because one is not enough. The prompt layer states
plainly that the costume is fixed for the entire video and drops the
story-driven escape hatch, and it only mentions the wardrobe instructions
section when there is something to put in it — the two cases now produce visibly
different prompts rather than one ambiguous prompt trying to cover both.
The parser layer is the part that actually guarantees the outcome: when there are
no wardrobe notes the locked outfit is pinned onto every scene regardless of what
came back, so a model that ignores its instructions — which is the failure this
is really defending against — still cannot change the character's clothes.
Whitespace-only notes count as no notes. When the user *has* written notes,
nothing is clamped and the director plans changes as before.

Worth knowing what was already right and is untouched: character *identity* was
never the weak link. Every scene's keyframe is an image edit of the outfit's
reference photo, so the face in frame one comes from a real picture of the
tenant's character rather than a fresh guess. That mechanism is stronger than
anything a seed would give you and this patch does not go near it.

**AI b-roll drifted in look rather than in costume.** One level up from the
character path, topic videos using generated imagery planned every scene's image
prompt independently and generated them three at a time, with nothing tying them
together beyond a soft "keep a consistent visual mood" line the model was free to
interpret per scene. Palette, quality of light and colour grade wandered from
scene to scene and the finished video read as a stock-photo collage rather than
one film. The Art Director now returns a single style clause alongside the
per-scene prompts, and that one clause is appended to every prompt — so the look
is constant while each scene's subject stays free.

The obvious-looking alternative was rejected on purpose, and it is worth writing
down so nobody "improves" it later: b-roll scenes must **not** be anchored on the
first scene's image the way character keyframes are anchored on an outfit photo.
Character mode wants the same subject every time, which is exactly what image
anchoring gives you. B-roll wants *different* subjects — scene one is flour on a
table, scene two is hands kneading — and anchoring scene two on scene one's
picture would drag the flour back onto the table along with the palette. Style is
the only thing that can safely be held constant across deliberately different
subjects, so style is the only thing this holds constant. It also costs nothing:
no extra image generations, no change to ordering, no change to concurrency.

The existing fail-soft behaviour is preserved exactly, which mattered more than
the feature here. A response with no usable style — missing, blank, or the wrong
type — leaves the scene prompts byte-identical to what they were before this
patch. A response with a style but no prompts still falls back to narration text.
A planning call that throws outright still falls back to narration text and logs
the same warning. And the style clause is length-bounded, so a model that decides
to answer with an essay cannot paste it onto the front of every image request.

## Tests

The api-server suite goes from 1437 to 1444 across the same 114 files. The seven
new tests were each proved non-vacuous by mutation: removing the parser clamp,
making the locked prompt branch emit the unlocked rules, dropping the style
append, dropping the length bound, and loosening the style type check were all
applied one at a time, and each made exactly its intended test fail before being
reverted. A test that passes against broken code is worse than no test, and
prompt-string assertions are unusually good at looking meaningful while
asserting nothing.

## Left alone

Text-to-video with a character picked goes through `characterClip.ts`, which
produces a single clip from a single prompt. It has no scenes, so it has no
cross-scene uniformity problem to solve and it is not touched here. It gets the
same treatment when that engine becomes multi-scene as part of the storyboard
work, which is where the remaining uniformity question lives.

Nothing in this patch changes what a job costs, which provider is picked, how
clips are stitched, or how long anything runs. Those all belong to the storyboard
patch and are better argued about there.

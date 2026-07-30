# KOKAO — full image editor (patch 2)

Stacks on top of `kokao-layered-images.patch`. Adds a full-page compositor at
`/editor/:id` with masks, groups, adjustment layers, layer effects, selection
and paint tools, undo history, and six generative operations wired to your
existing image pipeline.

**9,055 lines across 38 files.** Verified end-to-end on a clean clone of
`origin/main`.

---

## Install

```bash
git checkout -b feat/image-editor origin/main

git apply kokao-layered-images.patch      # patch 1 first — patch 2 builds on it
git apply kokao-photoshop-editor.patch

pnpm install
pnpm --filter @workspace/api-spec run codegen   # REQUIRED, see below
```

Then the validations:

```bash
pnpm run typecheck
pnpm --filter @workspace/api-spec run lint:spec
pnpm test
```

### Why the codegen step is not optional

`lib/api-zod/src/generated/` is committed in your repo, so the patch carries it.
`lib/api-client-react/src/generated/` is **not** committed and has no postinstall
hook, so it only exists on a machine that has run codegen. The patch cannot
carry a file your repo does not track — without this step the web app will not
compile, and the `codegen-drift` validation in `.replit` will fail.

No database migration. The layer document is still `content_items.image_layers`,
still opaque JSON, still under the 200 KB cap that `routes/content.ts` enforces.

---

## What was verified

Run on a fresh clone of `origin/main` with both patches applied:

| Check | Result |
|---|---|
| `pnpm run typecheck` | passes — all five apps |
| `pnpm --filter @workspace/api-spec run lint:spec` | passes |
| `codegen-drift` (the `.replit` validation, reproduced) | no drift |
| api-server suite | 1721 passed |
| socialforge suite | 546 passed |
| New tests added by this patch | 124 passed (113 web, 11 server) |

Four test failures exist and are **pre-existing** — they fail identically on the
unmodified tree, confirmed by stashing the patch and re-running:

- `src/pages/library.test.tsx` — 3 failures, `Found multiple elements with the
  role "menuitem" and name /edit/i`
- `src/routes/ads.meta-reconnect.test.ts` — 1 failure, needs Meta OAuth env
  config

---

## Entry point

Library → open a post → **Full editor**. The existing quick dialog is untouched
and still handles small tweaks; both write the same document, so a post edited
in one opens correctly in the other.

A v1 layer document from the old editor migrates on open: the base image becomes
a real layer, v1's text `fill` colour moves to `color` (v2 uses `fill` for
opacity, as Photoshop does), and v1's `multiply` blend carries through. Nothing
is dropped. This is the most heavily tested path in the patch — a v1 document
that fails to migrate is a post the user silently cannot edit any more.

---

## What it does

**Compositing** — 17 blend modes, layer masks (brush-paintable, or converted
from a selection), clipping masks, groups, per-layer opacity *and* fill,
non-destructive adjustments, adjustment layers that grade everything below them
and can themselves be masked.

**Adjustments** — exposure, contrast, saturation, hue, luminance, sharpen, blur,
grain, pixelate, posterize, threshold, greyscale/sepia/invert, per-channel gain,
plus eight presets.

**Effects** — drop shadow, stroke, outer glow, colour overlay, gradient overlay.

**Tools** — move/transform (with skew and flip), rectangular and elliptical
marquee, freehand and polygon lasso, magic wand, crop, brush, eraser, mask
brush, text, six shape types, gradient, eyedropper, hand, zoom.

**Workflow** — undo/redo with a clickable history panel, edit coalescing so one
slider drag is one history entry, snapping with alignment guides, align and
distribute, zoom/pan, and the Photoshop keymap (V/M/L/W/B/E/T/U/G, ⌘Z, ⌘⇧Z, ⌘J,
⌘G, ⌘A, ⌘D, ⌘⇧I, ⌘[ / ⌘], arrows to nudge, brackets to resize the brush).

**Generative** — one new endpoint, `POST /ai/image-op`:

| Operation | Cost | Result |
|---|---|---|
| Generative fill | 1 image credit | new masked layer |
| Remove object | 1 image credit | new masked layer |
| Replace background | 1 image credit | new masked layer |
| Cut out subject | 1 image credit | new transparent layer |
| Expand canvas (outpaint) | 1 image credit | flattens |
| Enlarge | free | flattens |

Two design decisions worth knowing about:

- Every operation runs against a **freshly flattened snapshot** of what you are
  looking at, not the original file. Otherwise the model fills a hole in an
  image that has none of your layers, masks or adjustments in it — and the mask
  and source are guaranteed to be the same size, which is the mismatch the
  server rejects most often.
- Fill, remove and background-replace come back as a **new masked layer**, not
  as a replacement document. Your layers survive, and "I preferred it before" is
  an eye icon rather than a question of undo depth.

Billing reuses the existing reserve-before / settle-or-release-after rails in
`routes/ai.ts`. Source and mask are validated *before* funding is reserved, so a
bad path or a mismatched mask is a 400 rather than a spent credit.

---

## What it deliberately does not do

Each of these was a choice, not an oversight.

**17 blend modes, not 25.** The 2D canvas implements 17. Photoshop's other eight
(dissolve, linear-burn, vivid-light, linear-light, pin-light, hard-mix, subtract,
divide) have no canvas operator, so supporting them means reading the backdrop
back out of the layer canvas and blending in JavaScript on every redraw — a
per-frame `getImageData` over the whole document, reached through a Konva
internal. The alternative, listing them and mapping each to its nearest
neighbour, is worse than omitting them: preview and export would agree with each
other and disagree with the name on the menu, and you would find out after
publishing. A document arriving with an unsupported mode normalises to `normal`
rather than to a lookalike.

**No inner shadow or inner glow.** Both need an inverted-silhouette offscreen
pass per layer per redraw. The five effects that ship are all native Konva
properties or a single composite operation.

**Stroke is text and shapes only.** An outside stroke on a raster layer needs a
silhouette rendered a dozen times around a circle; on text and shapes it is one
native property. The control hides itself with a note on other layer types.

**One shadow per layer.** Konva gives a node one shadow, and a glow *is* a
shadow with no offset. Ask for both and the drop shadow wins — the panel tells
you rather than quietly blending them into something that is neither.

**"Enlarge" is not AI upscaling.** It is Lanczos plus a light unsharp pass. It
invents no detail; it gets you a clean 2× without a browser's soft edges, and it
costs nothing because no provider is involved. Real super-resolution needs a new
provider capability. Calling this "AI upscale" in the meantime would be a
promise the pixels do not keep — hence the name.

**Cut-out returns one subject**, not multi-object segmentation. Nothing in your
provider set does true instance segmentation today.

**Expand and enlarge flatten the document.** Both change the canvas, and the
frame that comes back already contains everything that was flattened into it;
keeping the old layers would draw them twice. The panel says so before it runs,
and undo restores your layers.

**Layer reordering is keyboard-only between parents.** ⌘[ and ⌘] move within a
parent; there is no drag-and-drop in the panel and no layer thumbnails.

**No clone stamp, healing brush, pen tool, or paths.**

---

## Architecture notes

Worth knowing before you extend it:

**Raster data stays out of the document.** A 1024² mask inlined as base64 is
~100 KB of JSON per layer, and `content_items.image_layers` is read on every
library page load and capped at 200 KB. So masks and paint layers live in object
storage and the document holds the path; the editor keeps live canvases in
memory and uploads only the ones that changed on save.

**Masks are alpha, not greyscale.** The renderer composites them with
`destination-in`, which reads alpha and ignores colour. A greyscale-in-RGB mask
would be fully opaque everywhere and hide nothing.

**The maths is separated from Konva on purpose.** Blend mapping, selection
rasterising, the flood fill, feathering, the filter plan, history coalescing,
geometry and the keymap are all pure functions over plain arrays, in
`src/lib/imageEditor/`. jsdom has no 2D context, so anything written directly
against Konva is code that ships unverified — that separation is what the 113
web tests actually exercise. Rasterising an ellipse is exactly the kind of code
that is off by one pixel for a year if nothing checks it.

**Layers cache only when they must.** Caching is what makes a mask, a filter or
an overlay isolate correctly, and it is also the expensive thing — an untouched
layer skips it and draws straight through. The tree operations return the *same*
array when they change nothing, so a delete that misses or a nudge that runs off
the end of the stack does not cost a full document redraw.

**New UI primitives.** `slider.tsx`, `scroll-area.tsx` and `separator.tsx` were
missing from `components/ui/`. The Radix packages were already in
`package.json`, so these are standard shadcn copy-ins — no new dependencies.
Nothing in this patch adds a dependency.

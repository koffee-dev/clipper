# Clipper — plan + build log

## Every idea so far (checked off as built or queued)
- [x] Non-destructive multiple box selections per image → zip of PNGs
- [x] Infinite board, multi-image upload + paste (Figma-like)
- [x] Decorations: radius, border, shadow, sat/value/contrast + copy/paste style + presets
- [x] Paste-style respects ref locks (locked groups are skipped)
- [x] Focus mode (one box, transparent, no source) vs All-cuts mode (every render, no source)
- [x] Same-selection multiple designs → export grouped in folder
- [x] Transparent padding
- [x] Transform + crop, non-destructive
- [x] Parent/child nesting + child refs with independent transform (menu → item × N)
- [x] NEW: ref duplication locks ALL values; per-property blue link icon toggles linked/unlinked
- [x] NEW: undo/redo first-class (snapshot history ×100, Ctrl+Z / Ctrl+Shift+Z, buttons)
- [x] NEW: render order crop → radius → padding(transparent) → transform (contract in render.js)
- [~] NEW: local AI upscale for UI/text — researched, stubbed, model not bundled (see below)
- [x] NEW: export splash animation (sources left → boxes fly → cuts scatter right, repulsion layout) — shipped in export modal with sequential pulse + pop-in
- [x] Box resize via 8 handles (corner + edge), clamped to image, ref-lock aware, single undo step per drag
- [x] Layers panel (left): tree of groups + boxes, drag-to-nest, double-click rename, collapse, REF/×n badges; groups export as folders; nesting boxes replaces child tool (removed)
- [x] Canvas shows only the selection's bounds; click any box to select via hit-test
- [x] Tools moved to bottom-center pill; empty-state card truly centered
- [x] Variants fully unified (refs + designs merged): every variant links per-property to the box original; one + Variant button; variant sub-rows in layers; multi-variant boxes export as folders
- [x] Slicer (box-level, off by default): rows/cols + row/col gaps; cells inherit the active variant's style; live grid overlay on canvas; cell grids in focus/all previews; r1c1-named files on export
- [x] Feather edge: blurred-mask falloff to transparent, slider 0–80, linkable + undoable like any property
- [x] Mask mode (per variant, linkable): inverts to full image with transparent cutout; Fill Hole plugs it with a color; radius/feather shape the hole, border strokes it; `-mask` suffix on export, overrides slicer
- [x] Image-level styling: click any image (card, layers) for radius/border/shadow/adjust/feather/padding on the source itself; mask cutouts composite onto it (rounded base + hole); Export styled PNG; live radius/border/shadow/adjust on canvas
- [x] Shared style variables per property (+ menu: save named, apply, delete; works across boxes + images); presets removed
- [x] Overflow fixes: image border ring inset (no card spill), slicer grid hard-clipped to box, new boxes clamped to image bounds
- [x] Image panel placement fixed (was rendered outside the layout row); middle-mouse pans only, never selects/drags
- [x] Mask base = parent box (nested) else main image; base frame/shadow/pad/transform come from the parent original; adjust triple-stacks
- [x] Padding auto mode: full-image-size exports preserving x/y placement for AE stacking (works per slicer cell too)
- [x] Headless suites green: store 40/40 (Bun), render 40/40 (headless Chrome, pixel-level)
- [x] ESRGAN missing-model path: content-aware probe (rejects SPA-fallback HTML) + plain guidance naming the file and README, never the raw protobuf error
- [x] Focus stage is a fixed 1:1 square sized to viewport height — never resizes with content; cuts fit inside it
- [x] Mask fill + feather: fill spreads opaque color, zero transparency fringe (pixel-verified)
- [x] Animation-prep batch: manifest.json in zip (per-file source rects, canvas dims, holes, cells — Cavalry-ready, no plugin yet), export selected-only, position readout on selection, snap guides on draw/move/resize, multi-select + align/distribute bar, drawing loupe, coalesced undo for typing/sliders, layer hover ghost previews
- [x] Bun + Vite + React + Tailwind, light mode, icon-first minimal text

## Upscaler research (UI + text)
- General photos: Real-ESRGAN x4 is the standard. Runs locally as ONNX via onnxruntime-web — no server, no upload.
- UI/text specifically: no small local model beats ESRGAN cleanly; tiny text + 1px lines often do best with 2x hi-quality canvas + light unsharp mask (ships as "UI text 2x" mode). Full ESRGAN tends to soften pixel-crisp edges.
- Plan: `/public/models/realesrgan-x4-general.onnx` (user-downloaded, cached in IndexedDB) → `bun add onnxruntime-web` → tile inference in worker. Until then export falls back honestly to canvas scaling.
- Export options: 1x/2x/3x × {Standard, UI text 2x, Real-ESRGAN x4 local}.

## Ref lock semantics
- `duplicateAsRef` (Ctrl+D): new box with `sourceId`, all `links.* = true` except `transform: false` (so menu-item repositioning works immediately).
- Locked value: editing from the ref is ignored; UI shows blue link + "locked to source". Click link → unlink → editable.
- Master edit propagates to refs where that group is still linked (matched by design name for multi-design boxes).
- Copy/paste style + presets skip locked groups on refs.

## Undo/redo
- Snapshot-based (images/boxes/designs), 100 deep. Pushes on: add/move-commit, rect/design edits, link toggles, renames, deletes, presets. Drag pans/moves commit on mouse-up so a drag = one step.

## Export splash (queued, not skipped)
- Left: source images. Right: cuts scattered via repulsion-random (`scatterLayout` in render.js — random candidates, keep max-min-distance).
- Animation: box outlines draw on left, fly to right slots, resolve into thumbnails sequentially. Current modal shows the sequential "✂ path" reveal as placeholder.

## Run
```
cd ~/Desktop/clipper
bun install
bun dev
```

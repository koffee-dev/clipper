import { create } from 'zustand';

const uid = () => Math.random().toString(36).slice(2, 9);
const snap = (s) => JSON.parse(JSON.stringify({
  images: s.images, boxes: s.boxes, variants: s.variants, groups: s.groups || [],
}));

export const LINK_GROUPS = ['rect', 'crop', 'pad', 'radius', 'border', 'shadow', 'adjust', 'transform', 'feather', 'mask', 'isolate'];

// A variant references the box's original (first variant). Every value is
// linked by default except transform, so e.g. menu-item copies can reposition
// freely. Click a link icon to unlink a single property.
export const defaultVariant = (boxId, rect, name = 'v1') => ({
  id: uid(), boxId, name,
  rect: { ...rect },
  crop: { t: 0, r: 0, b: 0, l: 0 },
  pad: { t: 0, r: 0, b: 0, l: 0, auto: false },
  radius: 0,
  border: { w: 0, color: '#111827' },
  shadow: { enabled: false, x: 0, y: 12, blur: 24, spread: 0, color: 'rgba(0,0,0,0.30)' },
  adjust: { sat: 1, bright: 1, contrast: 1 },
  transform: { dx: 0, dy: 0, scale: 1, rot: 0, flipH: false },
  feather: 0,
  upscale: 'auto', // auto = global export setting; a custom choice wins at export
  mask: { enabled: false, fill: null },
  isolate: { enabled: false, model: 'u2netp', upscaleMask: false },
  links: { rect: true, crop: true, pad: true, radius: true, border: true, shadow: true, adjust: true, transform: true, feather: true, mask: true, isolate: true },
});

export const defaultSlicer = () => ({ enabled: false, rows: 3, cols: 3, rowGap: 12, colGap: 12 });

// Style applied to the source image itself (independent of boxes).
// Mask exports composite onto this: rounded/adjusted base + hole punched out.
export const defaultImageStyle = () => ({
  radius: 0,
  border: { w: 0, color: '#111827' },
  shadow: { enabled: false, x: 0, y: 12, blur: 24, spread: 0, color: 'rgba(0,0,0,0.30)' },
  adjust: { sat: 1, bright: 1, contrast: 1 },
  feather: 0,
  pad: { t: 0, r: 0, b: 0, l: 0, auto: false },
});

// Select a box (clears any image selection).
export const selectBox = (boxId, variantId) =>
  useStore.getState().setSel({ boxId, variantId, imageId: null });

// Ancestor folder names for a box (groups + parent boxes), root-first.
// Pure — used by export and covered by headless tests.
export function ancestorPath(box, boxes, groups) {
  const names = [];
  let pid = box.parentId, pk = box.parentKind || (box.parentId ? 'box' : null);
  const seen = new Set();
  while (pid && !seen.has(pid)) {
    seen.add(pid);
    const g = groups.find((x) => x.id === pid);
    if (g && pk !== 'box') { names.unshift(g.name); pid = g.parentId; pk = 'group'; continue; }
    const p = boxes.find((x) => x.id === pid);
    if (!p) break;
    names.unshift(p.name); pid = p.parentId; pk = p.parentKind || 'box';
  }
  return names;
}

const firstVariant = (variants, boxId) => variants.find((v) => v.boxId === boxId);

export const useStore = create((set, get) => ({
  images: [], boxes: [], variants: [], groups: [],
  sel: { boxId: null, variantId: null, imageId: null, multi: [] },
  mode: 'board', tool: 'select',
  cam: { x: 40, y: 40, zoom: 1 },
  styleClipboard: null,
  styleVars: [],
  past: [], future: [],
  histKey: null, histTime: 0,
  exportOpen: false,
  exportScale: 2, upscaleModel: 'canvas',

  _pushHistory() {
    const s = get();
    const past = [...s.past, snap(s)].slice(-100);
    set({ past, future: [], histKey: null, histTime: 0 });
  },
  // Call once at drag-start; live moves during the drag push nothing,
  // so a whole drag undoes in one step.
  beginHistory() {
    const s = get();
    const past = [...s.past, snap(s)].slice(-100);
    set({ past, future: [], histKey: null, histTime: 0 });
  },
  // Coalescing pushes for high-frequency edits (typing, sliders): rapid edits
  // with the same key extend the current undo step instead of spamming history.
  _pushKeyed(key, windowMs = 1000) {
    const s = get();
    const now = Date.now();
    if (s.histKey === key && now - s.histTime < windowMs) {
      set({ histTime: now });
      return;
    }
    const past = [...s.past, snap(s)].slice(-100);
    set({ past, future: [], histKey: key, histTime: now });
  },
  undo() {
    const s = get();
    if (!s.past.length) return;
    const prev = s.past[s.past.length - 1];
    set({ past: s.past.slice(0, -1), future: [snap(s), ...s.future].slice(0, 100),
      images: prev.images, boxes: prev.boxes, variants: prev.variants, groups: prev.groups || [], histKey: null, histTime: 0 });
  },
  redo() {
    const s = get();
    if (!s.future.length) return;
    const [next, ...rest] = s.future;
    set({ past: [...s.past, snap(s)].slice(-100), future: rest,
      images: next.images, boxes: next.boxes, variants: next.variants, groups: next.groups || [], histKey: null, histTime: 0 });
  },

  setCam(cam) { set({ cam }); },
  setTool(tool) { set({ tool }); },
  setMode(mode) { set({ mode }); },
  setSel(sel) { set({ sel }); },
  setExportOpen(v) { set({ exportOpen: v }); },
  setExportScale(v) { set({ exportScale: v }); },
  setUpscaleModel(v) { set({ upscaleModel: v }); },

  addImages(files) {
    const s = get();
    s._pushHistory();
    const start = s.images.length;
    const items = files.map((f, i) => ({
      id: uid(), url: URL.createObjectURL(f), name: (f.name || 'pasted').replace(/\.\w+$/, ''),
      w: 0, h: 0, x: 120 + (start + i) * 60, y: 120 + (start + i) * 60,
      style: defaultImageStyle(),
    }));
    set({ images: [...s.images, ...items] });
    items.forEach((it) => {
      const im = new Image();
      im.onload = () => {
        const cur = get();
        set({ images: cur.images.map((m) => m.id === it.id ? { ...m, w: im.naturalWidth, h: im.naturalHeight } : m) });
      };
      im.src = it.url;
    });
  },
  moveImage(id, x, y) {
    const s = get();
    set({ images: s.images.map((m) => m.id === id ? { ...m, x, y } : m) });
  },
  commitMove() { /* history is pushed at drag-start via beginHistory; noop for compat */ },
  removeImage(id) {
    const s = get();
    s._pushHistory();
    const boxIds = s.boxes.filter((b) => b.imageId === id).map((b) => b.id);
    set({
      images: s.images.filter((m) => m.id !== id),
      boxes: s.boxes.filter((b) => b.imageId !== id),
      variants: s.variants.filter((v) => !boxIds.includes(v.boxId)),
      sel: { boxId: null, variantId: null, imageId: null, multi: [] },
    });
  },

  addBox(imageId, rect, parentId = null, parentKind = null) {
    const s = get();
    s._pushHistory();
    const n = s.boxes.filter((b) => b.imageId === imageId).length + 1;
    const box = { id: uid(), imageId, parentId, parentKind, name: `box-${n}`, slicer: defaultSlicer() };
    const v = defaultVariant(box.id, rect);
    v.links = {}; // the original links to nothing
    set({ boxes: [...s.boxes, box], variants: [...s.variants, v], sel: { boxId: box.id, variantId: v.id, imageId: null }, tool: 'select' });
  },

  // The one way to multiply a selection: a linked variant of the same box.
  // Geometry + style locked to the original; transform free for repositioning.
  addVariant(boxId) {
    const s = get();
    s._pushHistory();
    const vs = s.variants.filter((v) => v.boxId === boxId);
    const base = vs.find((v) => v.id === s.sel.variantId) || vs[0];
    const nv = base
      ? { ...structuredClone(base), id: uid(), boxId, name: `v${vs.length + 1}`,
          links: { rect: true, crop: true, pad: true, radius: true, border: true, shadow: true, adjust: true, transform: false, feather: true, mask: true, isolate: true } }
      : { ...defaultVariant(boxId, { x: 0, y: 0, w: 10, h: 10 }), links: {} };
    set({ variants: [...s.variants, nv], sel: { boxId, variantId: nv.id } });
  },
  renameVariant(id, name) {
    const s = get(); s._pushKeyed(`rn:var:${id}`);
    set({ variants: s.variants.map((v) => v.id === id ? { ...v, name } : v) });
  },
  deleteVariant(boxId, id) {
    const s = get();
    const vs = s.variants.filter((v) => v.boxId === boxId);
    if (vs.length <= 1) return;
    s._pushHistory();
    const wasFirst = vs[0]?.id === id;
    let variants = s.variants.filter((v) => v.id !== id);
    if (wasFirst) {
      const nf = firstVariant(variants, boxId);
      if (nf) variants = variants.map((v) => v.id === nf.id ? { ...v, links: {} } : v);
    }
    const rest = variants.filter((v) => v.boxId === boxId);
    set({ variants, sel: { boxId, variantId: rest[0]?.id || null } });
  },

  toggleLink(variantId, group) {
    const s = get();
    const v = s.variants.find((x) => x.id === variantId);
    if (!v) return;
    s._pushKeyed(`lk:${variantId}:${group}`);
    const turningOn = !v.links?.[group];
    let variants = s.variants;
    // re-linking snaps the value back to the original — linked always equals source
    if (turningOn) {
      const orig = firstVariant(s.variants, v.boxId);
      if (orig && orig.id !== v.id && orig[group] !== undefined) {
        variants = variants.map((x) => x.id === v.id ? { ...x, [group]: structuredClone(orig[group]) } : x);
      }
    }
    variants = variants.map((x) => x.id === variantId
      ? { ...x, links: { ...x.links, [group]: turningOn } } : x);
    set({ variants });
  },

  _applyRect(boxId, variantId, rect, push) {
    const s = get();
    const v = s.variants.find((x) => x.id === variantId);
    if (!v || v.boxId !== boxId) return;
    if (v.links?.rect) return; // locked — unlink first
    if (push) s._pushKeyed(`rv:${boxId}:${variantId}`);
    let variants = s.variants.map((x) => x.id === variantId ? { ...x, rect } : x);
    const orig = firstVariant(s.variants, boxId);
    if (orig && orig.id === variantId) {
      variants = variants.map((x) => (x.boxId === boxId && x.links?.rect)
        ? { ...x, rect: { ...rect } } : x);
    }
    set({ variants });
  },
  updateVariantRect(boxId, variantId, rect) { get()._applyRect(boxId, variantId, rect, true); },
  // Live rect write for drags — pushes NO history (call beginHistory once at drag-start).
  setVariantRectLive(boxId, variantId, rect) { get()._applyRect(boxId, variantId, rect, false); },

  // group = crop|pad|radius|border|shadow|adjust|transform|feather
  updateVariant(variantId, group, value) {
    const s = get();
    const v = s.variants.find((x) => x.id === variantId);
    if (!v) return;
    if (v.links?.[group]) return; // locked — unlink first
    s._pushKeyed(`dv:${variantId}:${group}`);
    let variants = s.variants.map((x) => x.id === variantId ? { ...x, [group]: value } : x);
    const orig = firstVariant(s.variants, v.boxId);
    if (orig && orig.id === variantId) {
      variants = variants.map((x) => (x.boxId === v.boxId && x.links?.[group])
        ? { ...x, [group]: structuredClone(value) } : x);
    }
    set({ variants });
  },

  updateSlicer(boxId, patch) {
    const s = get(); s._pushKeyed(`sl:${boxId}`);
    set({ boxes: s.boxes.map((b) => b.id === boxId ? { ...b, slicer: { ...b.slicer, ...patch } } : b) });
  },

  renameImage(id, name) {
    const s = get(); s._pushKeyed(`rn:img:${id}`);
    set({ images: s.images.map((m) => m.id === id ? { ...m, name } : m) });
  },
  updateImageStyle(id, group, value) {
    const s = get(); s._pushKeyed(`im:${id}:${group}`);
    set({ images: s.images.map((m) => m.id === id ? { ...m, style: { ...(m.style || defaultImageStyle()), [group]: value } } : m) });
  },
  renameBox(boxId, name) {
    const s = get(); s._pushKeyed(`rn:box:${boxId}`);
    set({ boxes: s.boxes.map((b) => b.id === boxId ? { ...b, name } : b) });
  },
  deleteBox(boxId) {
    const s = get(); s._pushHistory();
    set({
      boxes: s.boxes.filter((b) => b.id !== boxId && !(b.parentId === boxId && b.parentKind !== 'group')),
      variants: s.variants.filter((v) => v.boxId !== boxId),
      sel: { boxId: null, variantId: null, imageId: null, multi: [] },
    });
  },

  deleteBoxes(ids) {
    const s = get();
    if (!ids?.length) return;
    s._pushHistory();
    const gone = new Set(ids);
    set({
      boxes: s.boxes.filter((b) => !gone.has(b.id) && !(b.parentId && gone.has(b.parentId) && b.parentKind !== 'group')),
      variants: s.variants.filter((v) => !gone.has(v.boxId)),
      sel: { boxId: null, variantId: null, imageId: null, multi: [] },
    });
  },

  // Align/distribute original-variant rects across boxes in ONE undo step
  // (selection bounding box is the reference). Unlinked variants are left alone.
  alignBoxes(boxIds, mode) {
    const s = get();
    const items = (boxIds || [])
      .map((id) => ({ id, orig: s.variants.filter((v) => v.boxId === id)[0] }))
      .filter((r) => r.orig);
    if (items.length < 2) return;
    s._pushHistory();
    const R = (r) => ({ ...r.rect });
    const rects = items.map((r) => R(r.orig));
    const minX = Math.min(...rects.map((r) => r.x)), maxX = Math.max(...rects.map((r) => r.x + r.w));
    const minY = Math.min(...rects.map((r) => r.y)), maxY = Math.max(...rects.map((r) => r.y + r.h));
    const round2 = (v) => Math.round(v * 100) / 100;
    const out = new Map();
    const cxAll = (minX + maxX) / 2, cyAll = (minY + maxY) / 2;
    if (mode === 'distH' || mode === 'distV') {
      const ax = mode === 'distH' ? 'x' : 'y', aw = mode === 'distH' ? 'w' : 'h';
      const sorted = [...items].sort((a, b) => (a.orig.rect[ax] + a.orig.rect[aw] / 2) - (b.orig.rect[ax] + b.orig.rect[aw] / 2));
      const firstC = sorted[0].orig.rect[ax] + sorted[0].orig.rect[aw] / 2;
      const lastC = sorted[sorted.length - 1].orig.rect[ax] + sorted[sorted.length - 1].orig.rect[aw] / 2;
      const step = sorted.length > 1 ? (lastC - firstC) / (sorted.length - 1) : 0;
      sorted.forEach((it, i) => {
        const nr = { ...it.orig.rect };
        nr[ax] = round2(firstC + step * i - it.orig.rect[aw] / 2);
        out.set(it.id, nr);
      });
    } else {
      for (const it of items) {
        const nr = { ...it.orig.rect };
        if (mode === 'left') nr.x = round2(minX);
        if (mode === 'right') nr.x = round2(maxX - nr.w);
        if (mode === 'centerX') nr.x = round2(cxAll - nr.w / 2);
        if (mode === 'top') nr.y = round2(minY);
        if (mode === 'bottom') nr.y = round2(maxY - nr.h);
        if (mode === 'centerY') nr.y = round2(cyAll - nr.h / 2);
        out.set(it.id, nr);
      }
    }
    let variants = s.variants;
    for (const it of items) {
      const nr = out.get(it.id);
      variants = variants.map((x) => x.id === it.orig.id ? { ...x, rect: nr } : x);
      variants = variants.map((x) => (x.boxId === it.id && x.links?.rect) ? { ...x, rect: { ...nr } } : x);
    }
    set({ variants });
  },

  addGroup(name) {
    const s = get(); s._pushHistory();
    const g = { id: uid(), name: name || `group-${s.groups.length + 1}`, parentId: null };
    set({ groups: [...s.groups, g] });
    return g.id;
  },
  renameGroup(id, name) {
    const s = get(); s._pushKeyed(`rn:grp:${id}`);
    set({ groups: s.groups.map((g) => g.id === id ? { ...g, name } : g) });
  },
  // deleting a group keeps its contents — children move up to the group's parent
  deleteGroup(id) {
    const s = get(); s._pushHistory();
    const g = s.groups.find((x) => x.id === id);
    const up = g?.parentId || null;
    set({
      groups: s.groups.filter((x) => x.id !== id).map((x) => x.parentId === id ? { ...x, parentId: up } : x),
      boxes: s.boxes.map((b) => (b.parentId === id && b.parentKind === 'group')
        ? { ...b, parentId: up, parentKind: up ? 'group' : null } : b),
    });
  },
  // move a box or group under a new parent (group, box, or root). Guards cycles.
  setParent(kind, id, parentId, parentKind) {
    const s = get();
    if (kind === 'group' && parentId && parentKind !== 'group') return false;
    if (parentId) {
      let pid = parentId, pk = parentKind || 'box';
      const seen = new Set();
      while (pid && !seen.has(pk + pid)) {
        seen.add(pk + pid);
        if (pid === id && (kind === 'group' ? pk === 'group' : true)) return false;
        if (pk === 'group') { const g = s.groups.find((x) => x.id === pid); pid = g?.parentId || null; pk = 'group'; }
        else { const b = s.boxes.find((x) => x.id === pid); pid = b?.parentId || null; pk = b?.parentKind || 'box'; }
      }
    }
    s._pushHistory();
    if (kind === 'group') set({ groups: s.groups.map((g) => g.id === id ? { ...g, parentId } : g) });
    else set({ boxes: s.boxes.map((b) => b.id === id ? { ...b, parentId, parentKind } : b) });
    return true;
  },

  copyStyle() {
    const s = get();
    const v = s.variants.find((x) => x.id === s.sel.variantId);
    if (v) {
      const { id, boxId, name, rect, links, ...style } = v;
      set({ styleClipboard: structuredClone(style) });
    }
  },
  pasteStyle() {
    const s = get();
    const target = s.variants.find((x) => x.id === s.sel.variantId);
    if (!target || !s.styleClipboard) return;
    // respect locks: only paste groups that are unlinked (original takes all)
    const locked = (g) => !!target.links?.[g];
    s._pushHistory();
    const c = s.styleClipboard;
    set({ variants: s.variants.map((x) => x.id === target.id ? {
      ...x,
      crop: locked('crop') ? x.crop : structuredClone(c.crop),
      pad: locked('pad') ? x.pad : structuredClone(c.pad),
      radius: locked('radius') ? x.radius : c.radius,
      border: locked('border') ? x.border : structuredClone(c.border),
      shadow: locked('shadow') ? x.shadow : structuredClone(c.shadow),
      adjust: locked('adjust') ? x.adjust : structuredClone(c.adjust),
      transform: locked('transform') ? x.transform : structuredClone(c.transform),
      feather: locked('feather') ? x.feather : (c.feather ?? 0),
      mask: locked('mask') ? x.mask : structuredClone(c.mask ?? { enabled: false, fill: null }),
      isolate: locked('isolate') ? x.isolate : structuredClone(c.isolate ?? { enabled: false, model: 'u2netp' }),
    } : x) });
  },
  // Shared style variables: named value sets per property group (Figma-variables-like).
  // Save once on any box/image, reuse from any other via the + menu. Library
  // data — intentionally outside undo history.
  saveStyleVar(group, name, value) {
    const s = get();
    set({ styleVars: [...s.styleVars, { id: uid(), group, name, value: structuredClone(value) }] });
  },
  deleteStyleVar(id) {
    const s = get();
    set({ styleVars: s.styleVars.filter((v) => v.id !== id) });
  },
}));

export { LINK_GROUPS as LINK_GROUPS_LIST };

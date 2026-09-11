// Render pipeline — order is contractual:
// 1. source rect crop → 2. inner crop inset → 3. color filters
// 4. border-radius clip → 5. border → 6. shadow → 7. transparent padding → 8. transform
// (radius before padding so corners never get cut; padding expands transparently)

export function cssFilterString(adjust) {
  if (!adjust) return 'none';
  return `saturate(${adjust.sat}) brightness(${adjust.bright}) contrast(${adjust.contrast})`;
}

function loadImage(url) {
  return new Promise((res, rej) => {
    const im = new Image();
    im.onload = () => res(im);
    im.onerror = rej;
    im.src = url;
  });
}

function roundRectPath(ctx, x, y, w, h, r) {
  ctx.beginPath();
  traceRoundRect(ctx, x, y, w, h, r);
}

// Same path without beginPath, so callers can combine subpaths (evenodd).
function traceRoundRect(ctx, x, y, w, h, r) {
  r = Math.max(0, Math.min(r, w / 2, h / 2));
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

function hardenMatte(src, spread) {
  const w = src.width, h = src.height;
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  const ctx = c.getContext('2d');
  if (spread > 0) {
    ctx.filter = `blur(${spread}px)`;
    ctx.drawImage(src, 0, 0);
    ctx.filter = 'none';
  } else ctx.drawImage(src, 0, 0);
  const img = ctx.getImageData(0, 0, w, h);
  for (let i = 3; i < img.data.length; i += 4) {
    img.data[i] = img.data[i] > 20 ? 255 : 0;
    img.data[i - 1] = img.data[i - 2] = img.data[i - 3] = 255;
  }
  ctx.putImageData(img, 0, 0);
  return c;
}

async function prepareIso(src, rect, design, imageId) {
  if (!design.isolate?.enabled) return { canvas: null };
  const { isolateSubject } = await import('./isolate.js');
  let iso = await isolateSubject(src, rect, { model: design.isolate.model || 'u2netp', imageId });
  if (!iso.canvas || !design.isolate.upscaleMask) return iso;
  try {
    const { upscaleCanvas } = await import('./upscale.js');
    const m = design.upscale && design.upscale !== 'auto' && design.upscale !== 'canvas'
      ? design.upscale : 'waifu2x-x2';
    const r = await upscaleCanvas(iso.canvas, m);
    const back = document.createElement('canvas');
    back.width = iso.canvas.width; back.height = iso.canvas.height;
    const b = back.getContext('2d');
    b.imageSmoothingEnabled = true; b.imageSmoothingQuality = 'high';
    b.drawImage(r.canvas, 0, 0, back.width, back.height);
    return { ...iso, canvas: back };
  } catch { return iso; }
}

// Renders a single box design to a canvas. imageEl can be an <img> already loaded.
// maskBase (from resolveMaskBase): { rect, style } of the parent box's original
// cut — nested masks composite onto the parent instead of the full image.
export async function renderCut({ img, imageUrl, box, design, scale = 1, hiQ = true, imageStyle = null, maskBase = null, imageId = '' }) {
  const src = img || await loadImage(imageUrl);
  const { x, y, w, h } = box.rect;
  const c = design.crop || { t: 0, r: 0, b: 0, l: 0 };
  let p = design.pad || { t: 0, r: 0, b: 0, l: 0 };

  // 1+2: rect + inner crop
  const sx = Math.max(0, x + c.l), sy = Math.max(0, y + c.t);
  let sw = Math.max(1, w - c.l - c.r), sh = Math.max(1, h - c.t - c.b);

  // mask mode: invert — base region (parent box, else full image) with a
  // cutout where this box is. Radius + feather shape the hole edge; border
  // strokes it; fill plugs it. Downstream style (frame/shadow/pad/transform)
  // comes from the base, not the hole.
  const isMask = !!design.mask?.enabled;
  const ist = imageStyle || {};
  const holeRadius = design.radius ?? 0;
  const holeBW = design.border?.w ?? 0;
  const holeColor = design.border?.color || '#111827';
  const noPad = { t: 0, r: 0, b: 0, l: 0 };
  const noCrop = { t: 0, r: 0, b: 0, l: 0 };
  const noTransform = { dx: 0, dy: 0, scale: 1, rot: 0, flipH: false };
  // resolved base: parent box's original style, else the main image style
  const base = isMask
    ? (maskBase?.style
        ? { ...maskBase.style, crop: maskBase.style.crop || noCrop, pad: maskBase.style.pad || noPad, transform: maskBase.style.transform || noTransform }
        : { radius: ist.radius ?? 0, border: ist.border || { w: 0 }, shadow: ist.shadow || {},
            adjust: { sat: 1, bright: 1, contrast: 1 }, feather: 0, pad: noPad, transform: noTransform, crop: noCrop })
    : null;
  const baseRect = isMask
    ? (maskBase?.rect || { x: 0, y: 0, w: src.naturalWidth || src.width, h: src.naturalHeight || src.height })
    : null;
  const radius = isMask ? (base.radius ?? 0) : holeRadius;
  const bw = isMask ? (base.border?.w ?? 0) : holeBW;
  const shadow = isMask ? (base.shadow?.enabled ? base.shadow : null) : design.shadow;
  const effTransform = isMask ? (base.transform || noTransform) : (design.transform || {});
  if (isMask) {
    // downstream padding: hole's pad + base pad (+ image pad at root)
    const bp = base.pad || noPad;
    const q = maskBase ? null : imageStyle?.pad;
    p = { t: (p.t || 0) + (bp.t || 0) + (q?.t || 0), r: (p.r || 0) + (bp.r || 0) + (q?.r || 0),
          b: (p.b || 0) + (bp.b || 0) + (q?.b || 0), l: (p.l || 0) + (bp.l || 0) + (q?.l || 0) };
  }
  const featherAmt = Math.max(0, Math.min(120, design.feather || 0));
  // room for the blur kernel; inset feather lives inside the content rect
  const padExtra = Math.max(40, Math.ceil(featherAmt) + 8);
  let holeGeom = null; // mask hole in tmp coords (for evenodd fills downstream)

  const tmp = document.createElement('canvas');
  if (!isMask) {
    tmp.width = Math.ceil(sw + padExtra * 2);
    tmp.height = Math.ceil(sh + padExtra * 2);
    const t = tmp.getContext('2d');
    t.imageSmoothingEnabled = hiQ;
    t.imageSmoothingQuality = 'high';
    t.filter = cssFilterString(design.adjust);
    t.drawImage(src, sx, sy, sw, sh, padExtra, padExtra, sw, sh);
    t.filter = 'none';

    if (design.isolate?.enabled) {
      const iso = await prepareIso(src, { x: sx, y: sy, w: sw, h: sh }, design, imageId);
      if (iso.canvas) {
        t.globalCompositeOperation = 'destination-in';
        t.drawImage(iso.canvas, padExtra, padExtra, sw, sh);
        t.globalCompositeOperation = 'source-over';
      }
    }

    // Feather on a plain cut must eat INTO the pixels: inset the mask by f
    // then blur by f so the 0→opaque ramp sits inside the box. Expanding the
    // mask puts the fade in the discarded margin — looks like feather is a
    // no-op unless Use as Mask is on (holes keep the fade in-frame).
    if (featherAmt > 0) {
      const inset = Math.min(featherAmt, Math.max(0, (Math.min(sw, sh) - 1) / 2));
      const m = document.createElement('canvas');
      m.width = tmp.width; m.height = tmp.height;
      const mc = m.getContext('2d');
      mc.filter = `blur(${featherAmt}px)`;
      mc.fillStyle = '#fff';
      roundRectPath(mc, padExtra + inset, padExtra + inset,
        Math.max(1, sw - inset * 2), Math.max(1, sh - inset * 2),
        Math.max(0, radius - inset));
      mc.fill();
      t.globalCompositeOperation = 'destination-in';
      t.drawImage(m, 0, 0);
      t.globalCompositeOperation = 'source-over';
    }
  } else {
    const bc = base.crop;
    const bx = Math.max(0, baseRect.x + bc.l), by = Math.max(0, baseRect.y + bc.t);
    const bW = Math.max(1, baseRect.w - bc.l - bc.r), bH = Math.max(1, baseRect.h - bc.t - bc.b);
    const holeW = Math.max(1, w - c.l - c.r), holeH = Math.max(1, h - c.t - c.b);
    sw = bW; sh = bH;
    tmp.width = Math.ceil(bW + padExtra * 2);
    tmp.height = Math.ceil(bH + padExtra * 2);
    const t = tmp.getContext('2d');
    t.imageSmoothingEnabled = hiQ;
    t.imageSmoothingQuality = 'high';
    // image × base × hole adjustments compose multiplicatively
    const ia = ist.adjust || {}, ba2 = base.adjust || {}, va = design.adjust || {};
    const mul = (k) => (ia[k] ?? 1) * (ba2[k] ?? 1) * (va[k] ?? 1);
    t.filter = `saturate(${mul('sat')}) brightness(${mul('bright')}) contrast(${mul('contrast')})`;
    t.drawImage(src, bx, by, bW, bH, padExtra, padExtra, bW, bH);
    t.filter = 'none';

    // base outer shape: radius + feather fade
    const bRad = base.radius ?? 0;
    const bF = Math.max(0, Math.min(120, base.feather || 0));
    if (bRad > 0 || bF > 0) {
      const om = document.createElement('canvas');
      om.width = tmp.width; om.height = tmp.height;
      const oc = om.getContext('2d');
      if (bF > 0) oc.filter = `blur(${bF}px)`;
      oc.fillStyle = '#fff';
      roundRectPath(oc, padExtra - bF, padExtra - bF, bW + bF * 2, bH + bF * 2, bRad + bF);
      oc.fill();
      t.globalCompositeOperation = 'destination-in';
      t.drawImage(om, 0, 0);
      t.globalCompositeOperation = 'source-over';
    }

    // punch the hole in base-local coords (feather softens its edge)
    const hf = Math.max(0, Math.min(120, design.feather || 0));
    const hx = padExtra + (sx - bx), hy = padExtra + (sy - by);
    holeGeom = { hx, hy, holeW, holeH, holeRadius };
    const iso = await prepareIso(src, { x: sx, y: sy, w: holeW, h: holeH }, design, imageId);
    // hole: isolate uses the subject matte. Fill + isolate hardens/dilates the
    // matte so the fill covers the fringe (blur-feather made that outline worse).
    if (design.mask.fill) {
      const fc = document.createElement('canvas');
      fc.width = tmp.width; fc.height = tmp.height;
      const fx = fc.getContext('2d');
      fx.fillStyle = design.mask.fill;
      if (iso.canvas) {
        const solid = hardenMatte(iso.canvas, Math.max(2, hf));
        t.globalCompositeOperation = 'destination-out';
        t.drawImage(solid, hx, hy, holeW, holeH);
        t.globalCompositeOperation = 'source-over';
        fx.drawImage(solid, hx, hy, holeW, holeH);
        fx.globalCompositeOperation = 'source-in';
        fx.fillRect(hx, hy, holeW, holeH);
      } else {
        if (hf > 0) fx.filter = `blur(${hf}px)`;
        roundRectPath(fx, hx - hf, hy - hf, holeW + hf * 2, holeH + hf * 2, holeRadius + hf);
        fx.fill();
      }
      t.drawImage(fc, 0, 0);
    } else if (iso.canvas) {
      const solid = hardenMatte(iso.canvas, Math.max(1, hf));
      const m = document.createElement('canvas');
      m.width = tmp.width; m.height = tmp.height;
      const mc = m.getContext('2d');
      mc.fillStyle = '#fff';
      mc.fillRect(0, 0, m.width, m.height);
      mc.globalCompositeOperation = 'destination-out';
      mc.drawImage(solid, hx, hy, holeW, holeH);
      t.globalCompositeOperation = 'destination-in';
      t.drawImage(m, 0, 0);
      t.globalCompositeOperation = 'source-over';
    } else {
      const m = document.createElement('canvas');
      m.width = tmp.width; m.height = tmp.height;
      const mc = m.getContext('2d');
      mc.fillStyle = '#fff';
      mc.fillRect(0, 0, m.width, m.height);
      mc.globalCompositeOperation = 'destination-out';
      if (hf > 0) mc.filter = `blur(${hf}px)`;
      mc.fillStyle = '#000';
      roundRectPath(mc, hx - hf, hy - hf, holeW + hf * 2, holeH + hf * 2, holeRadius + hf);
      mc.fill();
      t.globalCompositeOperation = 'destination-in';
      t.drawImage(m, 0, 0);
      t.globalCompositeOperation = 'source-over';
    }

    // border strokes the hole edge
    if (holeBW > 0) {
      t.strokeStyle = holeColor;
      t.lineWidth = holeBW * 2;
      roundRectPath(t, hx, hy, holeW, holeH, holeRadius);
      t.stroke();
    }
  }

  // auto padding: expand to full-image size, preserving x/y placement.
  // Each cut stays registered for AE-style stacking. Ignored in mask mode
  // (already full-base) and only exact with identity transform.
  if (!isMask && design.pad?.auto) {
    const iw2 = src.naturalWidth || src.width, ih2 = src.naturalHeight || src.height;
    p = { t: sy, l: sx, r: Math.max(0, iw2 - (sx + sw)), b: Math.max(0, ih2 - (sy + sh)) };
  }

  // content size incl border, before padding
  const cw = sw + bw * 2, ch = sh + bw * 2;

  // 7: padding expands the canvas transparently
  const outW = Math.ceil(cw + p.l + p.r);
  const outH = Math.ceil(ch + p.t + p.b);

  // 8: transform scale/rot expands bounds (base transform in mask mode)
  const rot = ((effTransform.rot || 0) * Math.PI) / 180;
  const tScale = effTransform.scale || 1;
  const cos = Math.abs(Math.cos(rot)), sin = Math.abs(Math.sin(rot));
  const rotW = outW * tScale * cos + outH * tScale * sin;
  const rotH = outW * tScale * sin + outH * tScale * cos;
  const margin = (shadow?.enabled
    ? (shadow.blur || 0) * 2 + (shadow.spread || 0) + Math.abs(shadow.x || 0) + Math.abs(shadow.y || 0) + 20 : 8);

  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.ceil(rotW * scale + margin * 2 * scale));
  canvas.height = Math.max(1, Math.ceil(rotH * scale + margin * 2 * scale));
  const ctx = canvas.getContext('2d');
  ctx.imageSmoothingEnabled = hiQ;
  ctx.imageSmoothingQuality = 'high';
  ctx.translate(canvas.width / 2, canvas.height / 2);
  if (rot) ctx.rotate(rot);
  ctx.scale(scale * tScale * (effTransform.flipH ? -1 : 1), scale * tScale);
  ctx.translate(effTransform.dx || 0, effTransform.dy || 0);

  const ox = -outW / 2, oy = -outH / 2; // top-left of padded box
  const ix = ox + p.l + bw, iy = oy + p.t + bw; // top-left of image content

  // 6: shadow (drawn under, follows radius shape; spread inflates it)
  if (shadow?.enabled) {
    const ssp = shadow.spread || 0;
    ctx.save();
    ctx.shadowColor = shadow.color || 'rgba(0,0,0,0.35)';
    ctx.shadowBlur = shadow.blur || 24;
    ctx.shadowOffsetX = shadow.x || 0;
    ctx.shadowOffsetY = shadow.y || 12;
    ctx.fillStyle = '#fff';
    if (isMask && holeGeom) {
      // ring + hole contour: shadow follows both, hole itself stays unfilled
      ctx.beginPath();
      traceRoundRect(ctx, ox + p.l - ssp, oy + p.t - ssp, cw + ssp * 2, ch + ssp * 2, radius + bw + ssp);
      traceRoundRect(ctx, ix + (holeGeom.hx - padExtra), iy + (holeGeom.hy - padExtra), holeGeom.holeW, holeGeom.holeH, holeGeom.holeRadius);
      ctx.fill('evenodd');
    } else {
      roundRectPath(ctx, ox + p.l - ssp, oy + p.t - ssp, cw + ssp * 2, ch + ssp * 2, radius + bw + ssp);
      ctx.fill();
    }
    ctx.restore();
  }

  // 4+5: radius clip → image → border
  ctx.save();
  if (bw > 0) {
    ctx.fillStyle = (isMask ? base.border?.color : design.border?.color) || '#111';
    if (isMask && holeGeom) {
      // ring only — a plain fill would back the hole with border color
      ctx.beginPath();
      traceRoundRect(ctx, ix - bw, iy - bw, cw, ch, radius + bw);
      traceRoundRect(ctx, ix + (holeGeom.hx - padExtra), iy + (holeGeom.hy - padExtra), holeGeom.holeW, holeGeom.holeH, holeGeom.holeRadius);
      ctx.fill('evenodd');
    } else {
      roundRectPath(ctx, ix - bw, iy - bw, cw, ch, radius + bw);
      ctx.fill();
    }
  }
  // A hard clip after feather squares the fade off. Mask already shaped the
  // edge (incl. radius); only clip when the edge is meant to be a hard radius.
  if (!(!isMask && featherAmt > 0)) {
    roundRectPath(ctx, ix, iy, sw, sh, radius);
    ctx.clip();
  }
  ctx.drawImage(tmp, padExtra, padExtra, sw, sh, ix, iy, sw, sh);
  ctx.restore();

  return canvas;
}

export function canvasToBlob(canvas, type = 'image/png') {
  return new Promise((res) => canvas.toBlob(res, type));
}

// Mask base resolution: a masked box nested in a parent box composites onto
// the parent's original cut; top-level boxes use the main image (null).
// Parent flags that don't apply to a base (its own mask/slicer) are ignored.
export function resolveMaskBase(box, boxes, variants) {
  if (!box || !box.parentId || box.parentKind === 'group') return null;
  const parent = boxes.find((b) => b.id === box.parentId);
  if (!parent) return null;
  const pstyle = variants.find((v) => v.boxId === parent.id);
  if (!pstyle) return null;
  return { rect: { ...pstyle.rect }, style: pstyle };
}

// Slicer: subdivide a variant's (cropped) rect into a rows×cols grid with gaps.
// Returns [{row, col, rect}] in image px, or null when disabled.
export function slicerCells(rect, crop, slicer) {
  if (!slicer?.enabled) return null;
  const R = Math.max(1, Math.min(24, slicer.rows | 0 || 1));
  const C = Math.max(1, Math.min(24, slicer.cols | 0 || 1));
  const gr = Math.max(0, slicer.rowGap || 0), gc = Math.max(0, slicer.colGap || 0);
  const c = crop || { t: 0, r: 0, b: 0, l: 0 };
  const x0 = rect.x + c.l, y0 = rect.y + c.t;
  const w = rect.w - c.l - c.r, h = rect.h - c.t - c.b;
  const cw = (w - gc * (C - 1)) / C, ch = (h - gr * (R - 1)) / R;
  if (cw < 1 || ch < 1) return [];
  const cells = [];
  for (let r = 0; r < R; r++)
    for (let cI = 0; cI < C; cI++)
      cells.push({ row: r, col: cI, rect: { x: x0 + cI * (cw + gc), y: y0 + r * (ch + gr), w: cw, h: ch } });
  return cells;
}

// Render one slicer cell through the variant's style (crop already consumed
// by the grid; transform reset so cells stay on the grid).
export async function renderSlicerCell({ img, imageUrl, cellRect, variant, scale = 1, hiQ = true }) {
  return renderCut({
    img, imageUrl,
    box: { rect: cellRect },
    design: { ...variant, crop: { t: 0, r: 0, b: 0, l: 0 }, transform: { dx: 0, dy: 0, scale: 1, rot: 0, flipH: false }, mask: { enabled: false } },
    scale, hiQ,
  });
}

// Randomized scatter layout for the (planned) export splash animation:
// left = sources, right = cuts placed randomly but repelled from each other.
export function scatterLayout(n, areaW, areaH, itemW = 120, itemH = 90, tries = 40) {
  const placed = [];
  for (let i = 0; i < n; i++) {
    let best = null, bestScore = -1;
    for (let k = 0; k < tries; k++) {
      const cx = Math.random() * Math.max(1, areaW - itemW);
      const cy = Math.random() * Math.max(1, areaH - itemH);
      let minD = Infinity;
      for (const q of placed) {
        const d = Math.hypot(cx - q.x, cy - q.y);
        if (d < minD) minD = d;
      }
      const score = placed.length === 0 ? Math.random() : minD + Math.random() * 20;
      if (score > bestScore) { bestScore = score; best = { x: cx, y: cy }; }
    }
    placed.push(best);
  }
  return placed;
}

// Snap guides: candidate lines from image bounds/center + sibling rects.
// rects: [{x,y,w,h}] in image px. Returns { v: [...x positions], h: [...y] }.
export function guideCandidates(w, h, rects) {
  const v = [0, w / 2, w], hh = [0, h / 2, h];
  for (const r of rects || []) {
    v.push(r.x, r.x + r.w, r.x + r.w / 2);
    hh.push(r.y, r.y + r.h, r.y + r.h / 2);
  }
  return { v, h: hh };
}

function bestSnap(edges, cands, t, guides, o) {
  let best = null, bestPos = 0;
  for (const e of edges) for (const c of cands) {
    const d = c - e;
    if (Math.abs(d) <= t && (best === null || Math.abs(d) < Math.abs(best))) { best = d; bestPos = c; }
  }
  if (best !== null) guides.push({ o, pos: bestPos });
  return best || 0;
}

// Snap a moving rect by its edges/center (single delta per axis).
export function snapMoveRect(rect, cands, t) {
  const guides = [];
  const dx = bestSnap([rect.x, rect.x + rect.w, rect.x + rect.w / 2], cands.v, t, guides, 'v');
  const dy = bestSnap([rect.y, rect.y + rect.h, rect.y + rect.h / 2], cands.h, t, guides, 'h');
  return { rect: { ...rect, x: rect.x + dx, y: rect.y + dy }, guides };
}

// Snap a dragged point (draw corner, resize handle) to candidate lines.
export function snapPoint(pt, cands, t) {
  const guides = [];
  const dx = bestSnap([pt.x], cands.v, t, guides, 'v');
  const dy = bestSnap([pt.y], cands.h, t, guides, 'h');
  return { x: pt.x + dx, y: pt.y + dy, guides };
}

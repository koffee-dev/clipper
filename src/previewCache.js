// LRU of finished preview blob URLs (isolate + upscale pipeline).

const MAX = 32;
const map = new Map(); // key -> { url }

export function previewFingerprint({ imageId, variant, model, exportScale, imageStyle, maskBase }) {
  const v = variant || {};
  return JSON.stringify({
    imageId, model: model || 'canvas', exportScale: exportScale || 1,
    r: v.rect, c: v.crop, p: v.pad, rad: v.radius, b: v.border, sh: v.shadow,
    a: v.adjust, t: v.transform, f: v.feather, m: v.mask, i: v.isolate, u: v.upscale,
    is: imageStyle || null,
    mb: maskBase ? { r: maskBase.rect, id: maskBase.style?.id } : null,
  });
}

export function getPreview(key) {
  const hit = map.get(key);
  if (!hit) return null;
  map.delete(key); map.set(key, hit); // refresh LRU
  return hit;
}

export function setPreview(key, url) {
  if (map.has(key)) {
    const old = map.get(key);
    if (old.url && old.url !== url) URL.revokeObjectURL(old.url);
    map.delete(key);
  }
  map.set(key, { url });
  while (map.size > MAX) {
    const k = map.keys().next().value;
    const v = map.get(k);
    if (v?.url) URL.revokeObjectURL(v.url);
    map.delete(k);
  }
}

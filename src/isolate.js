// Local subject isolation (U²-NetP). Worker first, main-thread WASM fallback.
// 320×320 — small enough that a missed worker must not freeze the preview.

export const ISOLATE_MODELS = [
  { id: 'u2netp', label: 'U²-NetP (fast)', url: `${import.meta.env.BASE_URL}models/u2netp.onnx`, size: 320, minBytes: 50_000,
    missing: 'Isolate needs public/models/u2netp.onnx' },
  { id: 'silueta', label: 'Silueta (sharper)', url: `${import.meta.env.BASE_URL}models/silueta.onnx`, size: 320, minBytes: 50_000,
    missing: 'Silueta needs public/models/silueta.onnx' },
];

const SIZE = 320;
const MEAN = [0.485, 0.456, 0.406];
const STD = [0.229, 0.224, 0.225];
const WORKER_MS = 20000;

const _matte = new Map();
const MATTE_MAX = 48;
let _worker = null;
let _workerBroken = false;
let _jobSeq = 0;
const _pending = new Map();
const _missing = new Set();
let _mainPacked = new Map();

export function isolateSpec(id = 'u2netp') {
  return ISOLATE_MODELS.find((m) => m.id === id) || ISOLATE_MODELS[0];
}

export async function isolateAvailable(id = 'u2netp') {
  const spec = isolateSpec(id);
  if (_missing.has(spec.id)) return false;
  try {
    const r = await fetch(spec.url, { method: 'HEAD' });
    if (!r.ok) return false;
    const ct = (r.headers.get('content-type') || '').toLowerCase();
    if (ct.includes('html')) return false;
    const len = Number(r.headers.get('content-length') || 0);
    if (len && len < spec.minBytes) return false;
    return true;
  } catch { return true; }
}

function matteKey(imageId, rect, model) {
  return `${imageId}|${Math.round(rect.x)}|${Math.round(rect.y)}|${Math.round(rect.w)}|${Math.round(rect.h)}|${model}`;
}

function remember(key, img) {
  if (_matte.has(key)) _matte.delete(key);
  _matte.set(key, img);
  while (_matte.size > MATTE_MAX) {
    const k = _matte.keys().next().value;
    _matte.delete(k);
  }
}

function failAll(err) {
  for (const [, p] of _pending) p.reject(err);
  _pending.clear();
}

function getWorker() {
  if (_workerBroken) return null;
  if (_worker) return _worker;
  try {
    _worker = new Worker(new URL('./isolate.worker.js', import.meta.url), { type: 'module' });
  } catch { _workerBroken = true; return null; }
  _worker.onmessage = (e) => {
    const msg = e.data;
    const p = _pending.get(msg.id);
    if (!p) return;
    _pending.delete(msg.id);
    if (msg.type === 'done') p.resolve(msg);
    else p.reject(new Error(msg.message || 'isolate worker error'));
  };
  _worker.onerror = (e) => {
    _workerBroken = true;
    failAll(new Error(e.message || 'isolate worker crashed'));
  };
  _worker.onmessageerror = () => {
    _workerBroken = true;
    failAll(new Error('isolate worker message error'));
  };
  return _worker;
}

function cropRgba(srcCanvas, rect) {
  const x = Math.max(0, Math.round(rect.x));
  const y = Math.max(0, Math.round(rect.y));
  const w = Math.max(1, Math.round(rect.w));
  const h = Math.max(1, Math.round(rect.h));
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  c.getContext('2d').drawImage(srcCanvas, x, y, w, h, 0, 0, w, h);
  return { w, h, data: new Uint8ClampedArray(c.getContext('2d').getImageData(0, 0, w, h).data) };
}

function resizeRgba(src, sw, sh, dw, dh) {
  const out = new Uint8ClampedArray(dw * dh * 4);
  for (let y = 0; y < dh; y++) {
    const sy = Math.min(sh - 1, (y + 0.5) * sh / dh - 0.5);
    const y0 = Math.max(0, Math.floor(sy)), y1 = Math.min(sh - 1, y0 + 1), fy = sy - y0;
    for (let x = 0; x < dw; x++) {
      const sx = Math.min(sw - 1, (x + 0.5) * sw / dw - 0.5);
      const x0 = Math.max(0, Math.floor(sx)), x1 = Math.min(sw - 1, x0 + 1), fx = sx - x0;
      const i00 = (y0 * sw + x0) * 4, i10 = (y0 * sw + x1) * 4;
      const i01 = (y1 * sw + x0) * 4, i11 = (y1 * sw + x1) * 4;
      const o = (y * dw + x) * 4;
      for (let c = 0; c < 4; c++) {
        out[o + c] = src[i00 + c] * (1 - fx) * (1 - fy) + src[i10 + c] * fx * (1 - fy)
          + src[i01 + c] * (1 - fx) * fy + src[i11 + c] * fx * fy;
      }
    }
  }
  return out;
}

function matteFromTensor(data, dims, W, H) {
  const oh = dims.length >= 2 ? dims[dims.length - 2] : SIZE;
  const ow = dims.length >= 1 ? dims[dims.length - 1] : SIZE;
  const plane = ow * oh;
  let mi = Infinity, ma = -Infinity;
  for (let i = 0; i < plane; i++) {
    const x = data[i];
    if (x < mi) mi = x;
    if (x > ma) ma = x;
  }
  const span = (ma - mi) || 1;
  const out = new Uint8ClampedArray(W * H * 4);
  for (let y = 0; y < H; y++) {
    const sy = Math.min(oh - 1, (y + 0.5) * oh / H - 0.5);
    const y0 = Math.max(0, Math.floor(sy)), y1 = Math.min(oh - 1, y0 + 1), fy = sy - y0;
    for (let x = 0; x < W; x++) {
      const sx = Math.min(ow - 1, (x + 0.5) * ow / W - 0.5);
      const x0 = Math.max(0, Math.floor(sx)), x1 = Math.min(ow - 1, x0 + 1), fx = sx - x0;
      const v = ((data[y0 * ow + x0] * (1 - fx) * (1 - fy) + data[y0 * ow + x1] * fx * (1 - fy)
        + data[y1 * ow + x0] * (1 - fx) * fy + data[y1 * ow + x1] * fx * fy) - mi) / span;
      const a = Math.max(0, Math.min(255, v * 255));
      const i = (y * W + x) * 4;
      out[i] = out[i + 1] = out[i + 2] = 255;
      out[i + 3] = a;
    }
  }
  return out;
}

async function runMain(rgba, w, h, url, size = SIZE) {
  let packed = _mainPacked.get(url);
  if (!packed) {
    const ort = await import('onnxruntime-web');
    try { ort.env.wasm.numThreads = 1; ort.env.wasm.proxy = false; } catch { /* */ }
    const session = await ort.InferenceSession.create(url, { executionProviders: ['wasm'] });
    packed = { ort, session };
    _mainPacked.set(url, packed);
  }
  const { ort, session } = packed;
  const small = (w === size && h === size) ? rgba : resizeRgba(rgba, w, h, size, size);
  const chw = new Float32Array(3 * size * size);
  const plane = size * size;
  for (let i = 0; i < plane; i++) {
    chw[i] = (small[i * 4] / 255 - MEAN[0]) / STD[0];
    chw[plane + i] = (small[i * 4 + 1] / 255 - MEAN[1]) / STD[1];
    chw[2 * plane + i] = (small[i * 4 + 2] / 255 - MEAN[2]) / STD[2];
  }
  const input = new ort.Tensor('float32', chw, [1, 3, size, size]);
  const result = await session.run({ [session.inputNames[0]]: input });
  const tensor = result[session.outputNames[0]];
  return { width: w, height: h, pixels: matteFromTensor(tensor.data, tensor.dims, w, h), ep: 'wasm' };
}

async function runWorker(rgba, w, h, url, signal, size = SIZE) {
  if (typeof location !== 'undefined' && /\/test\//.test(location.pathname)) throw new Error('no-worker');
  const wk = getWorker();
  if (!wk) throw new Error('no-worker');
  if (signal?.aborted) throw new Error('aborted');
  const id = ++_jobSeq;
  const pixels = new Uint8ClampedArray(rgba);
  return new Promise((resolve, reject) => {
    const onAbort = () => { _pending.delete(id); reject(new Error('aborted')); };
    const timer = setTimeout(() => {
      _pending.delete(id);
      _workerBroken = true;
      reject(new Error('isolate timed out'));
    }, WORKER_MS);
    signal?.addEventListener('abort', onAbort, { once: true });
    _pending.set(id, {
      resolve: (msg) => { clearTimeout(timer); signal?.removeEventListener('abort', onAbort); resolve(msg); },
      reject: (err) => { clearTimeout(timer); signal?.removeEventListener('abort', onAbort); reject(err); },
    });
    wk.postMessage({ id, url, width: w, height: h, pixels, size }, [pixels.buffer]);
  });
}

export async function isolateSubject(src, rect, { model = 'u2netp', imageId = '', signal } = {}) {
  const spec = isolateSpec(model);
  const key = matteKey(imageId || src.src || '', rect, spec.id);
  const hit = _matte.get(key);
  if (hit) {
    const c = document.createElement('canvas');
    c.width = hit.width; c.height = hit.height;
    c.getContext('2d').putImageData(hit, 0, 0);
    return { canvas: c, via: 'cache' };
  }
  if (!(await isolateAvailable(spec.id))) {
    _missing.add(spec.id);
    return { canvas: null, via: 'missing', note: spec.missing };
  }
  const srcC = src instanceof HTMLCanvasElement ? src : (() => {
    const c = document.createElement('canvas');
    c.width = src.naturalWidth || src.width; c.height = src.naturalHeight || src.height;
    c.getContext('2d').drawImage(src, 0, 0);
    return c;
  })();
  const crop = cropRgba(srcC, rect);
  const finish = (msg) => {
    const img = new ImageData(msg.pixels, msg.width, msg.height);
    remember(key, img);
    const c = document.createElement('canvas');
    c.width = img.width; c.height = img.height;
    c.getContext('2d').putImageData(img, 0, 0);
    return { canvas: c, via: msg.ep || 'onnx' };
  };
  try {
    const msg = await runWorker(crop.data, crop.w, crop.h, spec.url, signal, spec.size || SIZE);
    return finish(msg);
  } catch (e) {
    if (e && e.message === 'aborted') throw e;
    try {
      const copy = cropRgba(srcC, rect); // buffer may have been transferred
      const msg = await runMain(copy.data, copy.w, copy.h, spec.url, spec.size || SIZE);
      return finish(msg);
    } catch (e2) {
      return { canvas: null, via: 'error', note: String(e2?.message || e?.message || e2) };
    }
  }
}

export function isolateCacheSize() { return _matte.size; }

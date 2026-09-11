// Upscale — local-first. ONNX inference runs in a Web Worker so the tab
// stays interactive; canvas modes stay on the main thread (they're cheap).

export const UPSCALE_MODELS = [
  { id: 'canvas', label: 'Standard', desc: 'High-quality canvas. Best for drafts.' },
  { id: 'ui-text', label: 'UI text 2x', desc: '2x canvas + unsharp. Crisp 1px lines / type.' },
  { id: 'waifu2x-x2', label: 'Waifu2x 2x CUNet', desc: 'Fast local. Sharp UI, icons, line art.' },
  { id: 'waifu2x-art-x2', label: 'Waifu2x 2x Art', desc: 'SwinUNet art. Best for UI / illustration.' },
  { id: 'waifu2x-photo-x2', label: 'Waifu2x 2x Photo', desc: 'SwinUNet photo. Natural screenshots.' },
  { id: 'waifu2x-art-x4', label: 'Waifu2x 4x Art', desc: 'SwinUNet art x4. Heavier, sharper.' },
  { id: 'realesrgan-x4', label: 'Real-ESRGAN x4', desc: 'x4v3 general. Photos + UI.' },
];

const ONNX = {
  'waifu2x-x2': {
    url: `${import.meta.env.BASE_URL}models/waifu2x-cunet-x2.onnx`,
    scale: 2, tile: 128, overlap: 16, minBytes: 50_000,
    missing: 'Waifu2x CUNet needs public/models/waifu2x-cunet-x2.onnx',
  },
  'waifu2x-art-x2': {
    url: `${import.meta.env.BASE_URL}models/waifu2x-swin-art-x2.onnx`,
    scale: 2, tile: 96, overlap: 16, minBytes: 50_000,
    missing: 'Waifu2x Art 2x needs public/models/waifu2x-swin-art-x2.onnx',
  },
  'waifu2x-photo-x2': {
    url: `${import.meta.env.BASE_URL}models/waifu2x-swin-photo-x2.onnx`,
    scale: 2, tile: 96, overlap: 16, minBytes: 50_000,
    missing: 'Waifu2x Photo 2x needs public/models/waifu2x-swin-photo-x2.onnx',
  },
  'waifu2x-art-x4': {
    url: `${import.meta.env.BASE_URL}models/waifu2x-swin-art-x4.onnx`,
    scale: 4, tile: 80, overlap: 12, minBytes: 50_000,
    missing: 'Waifu2x Art 4x needs public/models/waifu2x-swin-art-x4.onnx',
  },
  'realesrgan-x4': {
    url: `${import.meta.env.BASE_URL}models/realesrgan-x4v3.onnx`,
    scale: 4, tile: 128, overlap: 12, minBytes: 50_000,
    missing: 'Real-ESRGAN x4 needs public/models/realesrgan-x4v3.onnx',
  },
};

const _missing = new Set();
let _worker = null;
let _workerBroken = false;
let _jobSeq = 0;
const _pending = new Map(); // id -> { resolve, reject, onTile, signal }

export function onnxSpec(modelId) { return ONNX[modelId] || null; }

export async function modelAvailable(modelId = 'realesrgan-x4') {
  const spec = ONNX[modelId];
  if (!spec) return false;
  if (_missing.has(modelId)) return false;
  try {
    const r = await fetch(spec.url, { method: 'HEAD' });
    if (!r.ok) return false;
    const ct = (r.headers.get('content-type') || '').toLowerCase();
    if (ct.includes('html')) return false;
    const len = Number(r.headers.get('content-length') || 0);
    if (len && len < (spec.minBytes || 50_000)) return false;
    return true;
  } catch {
    return true;
  }
}

export async function ensureUpscaler(modelId) {
  if (!ONNX[modelId]) return { ready: true, local: modelId !== 'canvas' };
  if (_missing.has(modelId)) return { ready: false, reason: 'model-missing' };
  try {
    if (!(await modelAvailable(modelId))) {
      _missing.add(modelId);
      return { ready: false, reason: 'model-missing' };
    }
    getWorker(); // warm the worker (model loads on first run)
    return { ready: true, local: true };
  } catch (e) {
    return { ready: false, reason: String(e?.message || e) };
  }
}

function getWorker() {
  if (_workerBroken) return null;
  if (_worker) return _worker;
  try {
    _worker = new Worker(new URL('./upscale.worker.js', import.meta.url), { type: 'module' });
  } catch (e) {
    _workerBroken = true;
    return null;
  }
  _worker.onmessage = (e) => {
    const msg = e.data;
    const p = _pending.get(msg.id);
    if (!p) return;
    if (msg.type === 'progress') { p.onTile?.(msg.done, msg.total, msg.ep); return; }
    _pending.delete(msg.id);
    if (msg.type === 'done') p.resolve(msg);
    else p.reject(new Error(msg.message || 'worker error'));
  };
  _worker.onerror = () => { _workerBroken = true; };
  return _worker;
}

function yieldUI() {
  return new Promise((r) => setTimeout(r, 0));
}

function canvasScale(src, scale) {
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(src.width * scale));
  c.height = Math.max(1, Math.round(src.height * scale));
  const ctx = c.getContext('2d');
  ctx.imageSmoothingEnabled = true; ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(src, 0, 0, c.width, c.height);
  return c;
}

function imageDataToCanvas(width, height, pixels) {
  const c = document.createElement('canvas');
  c.width = width; c.height = height;
  c.getContext('2d').putImageData(new ImageData(pixels, width, height), 0, 0);
  return c;
}

async function runInWorker(sourceCanvas, modelId, { onTile, signal } = {}) {
  // Headless/webdriver (our pixel suite) doesn't pump worker time reliably —
  // stay on the yielding main-thread path there. Real tabs use the worker.
  if (typeof location !== 'undefined' && /\/test\//.test(location.pathname)) throw new Error('no-worker');
  const w = getWorker();
  if (!w) throw new Error('no-worker');
  if (signal?.aborted) throw new Error('aborted');
  const ctx = sourceCanvas.getContext('2d');
  const img = ctx.getImageData(0, 0, sourceCanvas.width, sourceCanvas.height);
  const id = ++_jobSeq;
  const pixels = new Uint8ClampedArray(img.data); // own copy — never transfer the live canvas buffer
  const result = await new Promise((resolve, reject) => {
    const onAbort = () => { _pending.delete(id); reject(new Error('aborted')); };
    signal?.addEventListener('abort', onAbort, { once: true });
    _pending.set(id, {
      resolve: (msg) => { signal?.removeEventListener('abort', onAbort); resolve(msg); },
      reject: (err) => { signal?.removeEventListener('abort', onAbort); reject(err); },
      onTile,
    });
    try {
      w.postMessage(
        { id, modelId, spec: { url: onnxSpec(modelId).url, scale: onnxSpec(modelId).scale, tile: onnxSpec(modelId).tile, overlap: onnxSpec(modelId).overlap },
          width: sourceCanvas.width, height: sourceCanvas.height, pixels },
        [pixels.buffer],
      );
    } catch (e) {
      // transfer failed (buffer already detached / old browser) — copy instead
      const copy = new Uint8ClampedArray(img.data);
      const spec = onnxSpec(modelId);
      w.postMessage({ id, modelId, spec: { url: spec.url, scale: spec.scale, tile: spec.tile, overlap: spec.overlap },
        width: sourceCanvas.width, height: sourceCanvas.height, pixels: copy });
    }
  });
  if (signal?.aborted) throw new Error('aborted');
  return imageDataToCanvas(result.width, result.height, result.pixels);
}

// Main-thread fallback: same tiling, but we yield between tiles so the tab
// can paint. Also turns on ORT's wasm proxy worker when available.
const _sessions = new Map();

async function getSession(modelId) {
  if (_sessions.has(modelId)) return _sessions.get(modelId);
  const spec = ONNX[modelId];
  const p = (async () => {
    const ort = await import('onnxruntime-web');
    // proxy = extra nested worker; we already have upscale.worker.js for real tabs
    try { ort.env.wasm.numThreads = 1; } catch { /* ignore */ }
    const session = await ort.InferenceSession.create(spec.url, { executionProviders: ['wasm'] });
    return { ort, session };
  })().catch((e) => { _sessions.delete(modelId); throw e; });
  _sessions.set(modelId, p);
  return p;
}

function canvasToNCHW(canvas) {
  const { data, width: w, height: h } = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height);
  const chw = new Float32Array(3 * w * h);
  const plane = w * h;
  for (let i = 0; i < plane; i++) {
    chw[i] = data[i * 4] / 255;
    chw[plane + i] = data[i * 4 + 1] / 255;
    chw[2 * plane + i] = data[i * 4 + 2] / 255;
  }
  return chw;
}

function nchwToCanvas(output, outW, outH) {
  const c = document.createElement('canvas');
  c.width = outW; c.height = outH;
  const ctx = c.getContext('2d');
  const img = ctx.createImageData(outW, outH);
  const d = output.data, plane = outW * outH;
  for (let i = 0; i < plane; i++) {
    img.data[i * 4] = Math.max(0, Math.min(255, d[i] * 255));
    img.data[i * 4 + 1] = Math.max(0, Math.min(255, d[plane + i] * 255));
    img.data[i * 4 + 2] = Math.max(0, Math.min(255, d[2 * plane + i] * 255));
    img.data[i * 4 + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);
  return c;
}

function restoreAlpha(rgbCanvas, src, scale) {
  const a = canvasScale(src, scale);
  const rgb = rgbCanvas.getContext('2d').getImageData(0, 0, rgbCanvas.width, rgbCanvas.height);
  const ad = a.getContext('2d').getImageData(0, 0, a.width, a.height);
  for (let i = 3; i < rgb.data.length; i += 4) rgb.data[i] = ad.data[i];
  rgbCanvas.getContext('2d').putImageData(rgb, 0, 0);
  return rgbCanvas;
}

export async function onnxUpscale(sourceCanvas, modelId, { onTile, signal } = {}) {
  try {
    return await runInWorker(sourceCanvas, modelId, { onTile, signal });
  } catch (e) {
    if (e && e.message === 'aborted') throw e;
    // worker unavailable — fall through to yielding main-thread path
  }
  const spec = ONNX[modelId];
  const { ort, session } = await getSession(modelId);
  const scale = spec.scale, tile = spec.tile, overlap = spec.overlap;
  const inName = session.inputNames[0];
  const W = sourceCanvas.width, H = sourceCanvas.height;
  const out = document.createElement('canvas');
  out.width = W * scale; out.height = H * scale;
  const octx = out.getContext('2d');
  const step = Math.max(1, tile - overlap * 2);
  let done = 0;
  const total = Math.ceil(W / step) * Math.ceil(H / step);
  for (let ty = 0; ty < H; ty += step) {
    for (let tx = 0; tx < W; tx += step) {
      if (signal?.aborted) throw new Error('aborted');
      const x0 = Math.max(0, tx - (tx > 0 ? overlap : 0));
      const y0 = Math.max(0, ty - (ty > 0 ? overlap : 0));
      const x1 = Math.min(W, tx + step + (tx + step < W ? overlap : 0));
      const y1 = Math.min(H, ty + step + (ty + step < H ? overlap : 0));
      const tw = x1 - x0, th = y1 - y0;
      const tc = document.createElement('canvas');
      tc.width = tw; tc.height = th;
      tc.getContext('2d').drawImage(sourceCanvas, x0, y0, tw, th, 0, 0, tw, th);
      const chw = canvasToNCHW(tc);
      const input = new ort.Tensor('float32', chw, [1, 3, th, tw]);
      const result = await session.run({ [inName]: input });
      const tensor = result[session.outputNames[0]];
      const tileOut = nchwToCanvas(tensor, tensor.dims[3], tensor.dims[2]);
      const trimL = (x0 === tx ? 0 : overlap * scale);
      const trimT = (y0 === ty ? 0 : overlap * scale);
      const keepW = Math.max(1, (x1 - tx) * scale - (x1 < W ? overlap * scale : 0));
      const keepH = Math.max(1, (y1 - ty) * scale - (y1 < H ? overlap * scale : 0));
      octx.drawImage(tileOut, trimL, trimT, keepW, keepH, tx * scale, ty * scale, keepW, keepH);
      done++;
      onTile?.(done, total);
      if (typeof location === 'undefined' || !/\/test\//.test(location.pathname)) await yieldUI();
    }
  }
  return restoreAlpha(out, sourceCanvas, scale);
}

export async function upscaleCanvas(canvas, modelId, { onTile, signal } = {}) {
  if (modelId === 'ui-text') {
    return { canvas: sharpenCanvas(canvasScale(canvas, 2)), via: 'ui-text-2x' };
  }
  const spec = ONNX[modelId];
  if (spec) {
    try {
      if (!(await modelAvailable(modelId))) throw new Error('model-missing');
      const out = await onnxUpscale(canvas, modelId, { onTile, signal });
      return { canvas: out, via: modelId };
    } catch (e) {
      if (e && e.message === 'aborted') throw e;
      const missing = e && e.message === 'model-missing';
      return {
        canvas: canvasScale(canvas, spec.scale),
        via: `canvas-${spec.scale}x-fallback`,
        note: missing ? `${spec.missing} — used hi-q canvas instead.` : String(e?.message || e),
      };
    }
  }
  return { canvas, via: 'canvas' };
}

export function sharpenCanvas(canvas, amount = 0.35) {
  const ctx = canvas.getContext('2d');
  const { width: w, height: h } = canvas;
  const src = ctx.getImageData(0, 0, w, h);
  const blurred = document.createElement('canvas');
  blurred.width = w; blurred.height = h;
  const b = blurred.getContext('2d');
  b.filter = 'blur(1px)';
  b.drawImage(canvas, 0, 0);
  const bl = b.getImageData(0, 0, w, h);
  const out = ctx.createImageData(w, h);
  for (let i = 0; i < src.data.length; i += 4) {
    for (let c = 0; c < 3; c++) {
      out.data[i + c] = Math.max(0, Math.min(255, src.data[i + c] + (src.data[i + c] - bl.data[i + c]) * amount));
    }
    out.data[i + 3] = src.data[i + 3];
  }
  ctx.putImageData(out, 0, 0);
  return canvas;
}

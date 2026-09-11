// Runs ONNX super-resolution off the UI thread.
// Tries WebGPU first, then WASM. Spec comes from the main thread.

let ortMod = null;
const sessions = new Map(); // modelId -> { ort, session, ep }

async function loadOrt(wantGpu) {
  if (ortMod) return ortMod;
  if (wantGpu) {
    try {
      ortMod = await import('onnxruntime-web/webgpu');
      return ortMod;
    } catch { /* bundle missing / no GPU */ }
  }
  ortMod = await import('onnxruntime-web');
  try { ortMod.env.wasm.numThreads = 1; ortMod.env.wasm.proxy = false; } catch { /* ignore */ }
  return ortMod;
}

async function sessionFor(modelId, spec) {
  if (sessions.has(modelId)) return sessions.get(modelId);
  const wantGpu = typeof navigator !== 'undefined' && !!navigator.gpu;
  const o = await loadOrt(wantGpu);
  let session, ep;
  if (wantGpu) {
    try {
      session = await o.InferenceSession.create(spec.url, { executionProviders: ['webgpu'] });
      ep = 'webgpu';
    } catch { /* ops/adapter */ }
  }
  if (!session) {
    session = await o.InferenceSession.create(spec.url, { executionProviders: ['wasm'] });
    ep = 'wasm';
  }
  const packed = { ort: o, session, ep };
  sessions.set(modelId, packed);
  return packed;
}

function rgbaToNCHW(rgba, w, h) {
  const plane = w * h;
  const chw = new Float32Array(3 * plane);
  for (let i = 0; i < plane; i++) {
    chw[i] = rgba[i * 4] / 255;
    chw[plane + i] = rgba[i * 4 + 1] / 255;
    chw[2 * plane + i] = rgba[i * 4 + 2] / 255;
  }
  return chw;
}

function nchwToRgb(data, w, h) {
  const plane = w * h;
  const rgb = new Uint8ClampedArray(plane * 4);
  for (let i = 0; i < plane; i++) {
    rgb[i * 4] = Math.max(0, Math.min(255, data[i] * 255));
    rgb[i * 4 + 1] = Math.max(0, Math.min(255, data[plane + i] * 255));
    rgb[i * 4 + 2] = Math.max(0, Math.min(255, data[2 * plane + i] * 255));
    rgb[i * 4 + 3] = 255;
  }
  return rgb;
}

function extractTile(rgba, W, H, x0, y0, tw, th) {
  const out = new Uint8ClampedArray(tw * th * 4);
  for (let y = 0; y < th; y++) {
    const src = ((y0 + y) * W + x0) * 4;
    out.set(rgba.subarray(src, src + tw * 4), y * tw * 4);
  }
  return out;
}

function blit(dst, dW, src, sW, sH, dx, dy, sx, sy, w, h) {
  for (let y = 0; y < h; y++) {
    const si = ((sy + y) * sW + sx) * 4;
    const di = ((dy + y) * dW + dx) * 4;
    dst.set(src.subarray(si, si + w * 4), di);
  }
}

function scaleAlpha(src, sw, sh, dw, dh) {
  const out = new Uint8ClampedArray(dw * dh);
  for (let y = 0; y < dh; y++) {
    const sy = Math.min(sh - 1, (y + 0.5) * sh / dh - 0.5);
    const y0 = Math.max(0, Math.floor(sy)), y1 = Math.min(sh - 1, y0 + 1), fy = sy - y0;
    for (let x = 0; x < dw; x++) {
      const sx = Math.min(sw - 1, (x + 0.5) * sw / dw - 0.5);
      const x0 = Math.max(0, Math.floor(sx)), x1 = Math.min(sw - 1, x0 + 1), fx = sx - x0;
      const a00 = src[(y0 * sw + x0) * 4 + 3];
      const a10 = src[(y0 * sw + x1) * 4 + 3];
      const a01 = src[(y1 * sw + x0) * 4 + 3];
      const a11 = src[(y1 * sw + x1) * 4 + 3];
      out[y * dw + x] = a00 * (1 - fx) * (1 - fy) + a10 * fx * (1 - fy) + a01 * (1 - fx) * fy + a11 * fx * fy;
    }
  }
  return out;
}

async function run(job) {
  const { id, modelId, spec, width: W, height: H, pixels } = job;
  if (!spec) throw new Error(`unknown model ${modelId}`);
  const { ort: o, session, ep } = await sessionFor(modelId, spec);
  const scale = spec.scale, tile = spec.tile, overlap = spec.overlap;
  const inName = session.inputNames[0];
  const outW = W * scale, outH = H * scale;
  const out = new Uint8ClampedArray(outW * outH * 4);
  const step = Math.max(1, tile - overlap * 2);
  const total = Math.ceil(W / step) * Math.ceil(H / step);
  let done = 0;
  for (let ty = 0; ty < H; ty += step) {
    for (let tx = 0; tx < W; tx += step) {
      const x0 = Math.max(0, tx - (tx > 0 ? overlap : 0));
      const y0 = Math.max(0, ty - (ty > 0 ? overlap : 0));
      const x1 = Math.min(W, tx + step + (tx + step < W ? overlap : 0));
      const y1 = Math.min(H, ty + step + (ty + step < H ? overlap : 0));
      const tw = x1 - x0, th = y1 - y0;
      const tileRgba = extractTile(pixels, W, H, x0, y0, tw, th);
      const chw = rgbaToNCHW(tileRgba, tw, th);
      const input = new o.Tensor('float32', chw, [1, 3, th, tw]);
      const result = await session.run({ [inName]: input });
      const tensor = result[session.outputNames[0]];
      const ow = tensor.dims[3], oh = tensor.dims[2];
      const tileOut = nchwToRgb(tensor.data, ow, oh);
      const trimL = (x0 === tx ? 0 : overlap * scale);
      const trimT = (y0 === ty ? 0 : overlap * scale);
      const keepW = Math.max(1, (x1 - tx) * scale - (x1 < W ? overlap * scale : 0));
      const keepH = Math.max(1, (y1 - ty) * scale - (y1 < H ? overlap * scale : 0));
      blit(out, outW, tileOut, ow, oh, tx * scale, ty * scale, trimL, trimT, keepW, keepH);
      done++;
      self.postMessage({ id, type: 'progress', done, total, ep });
    }
  }
  const a = scaleAlpha(pixels, W, H, outW, outH);
  for (let i = 0; i < a.length; i++) out[i * 4 + 3] = a[i];
  return { width: outW, height: outH, pixels: out, ep };
}

let chain = Promise.resolve();
self.onmessage = (e) => {
  const job = e.data;
  chain = chain.then(async () => {
    try {
      const out = await run(job);
      self.postMessage({ id: job.id, type: 'done', width: out.width, height: out.height, pixels: out.pixels, ep: out.ep }, [out.pixels.buffer]);
    } catch (err) {
      self.postMessage({ id: job.id, type: 'error', message: String(err?.message || err) });
    }
  });
};

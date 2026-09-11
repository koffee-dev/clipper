// U²-NetP / Silueta subject matte — WASM. Job carries {url, size}.

const MEAN = [0.485, 0.456, 0.406];
const STD = [0.229, 0.224, 0.225];

const sessions = new Map();

async function sessionFor(url) {
  if (sessions.has(url)) return sessions.get(url);
  const o = await import('onnxruntime-web');
  try { o.env.wasm.numThreads = 1; o.env.wasm.proxy = false; } catch { /* */ }
  const session = await o.InferenceSession.create(url, { executionProviders: ['wasm'] });
  const packed = { ort: o, session, ep: 'wasm' };
  sessions.set(url, packed);
  return packed;
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

self.onmessage = async (e) => {
  const { id, url, width: W, height: H, pixels, size = 320 } = e.data;
  try {
    const { ort: o, session, ep } = await sessionFor(url);
    const small = (W === size && H === size) ? pixels : resizeRgba(pixels, W, H, size, size);
    const chw = new Float32Array(3 * size * size);
    const plane = size * size;
    for (let i = 0; i < plane; i++) {
      chw[i] = (small[i * 4] / 255 - MEAN[0]) / STD[0];
      chw[plane + i] = (small[i * 4 + 1] / 255 - MEAN[1]) / STD[1];
      chw[2 * plane + i] = (small[i * 4 + 2] / 255 - MEAN[2]) / STD[2];
    }
    const input = new o.Tensor('float32', chw, [1, 3, size, size]);
    const result = await session.run({ [session.inputNames[0]]: input });
    const tensor = result[session.outputNames[0]];
    const d = tensor.data;
    const dims = tensor.dims || [];
    const oh = dims.length >= 2 ? dims[dims.length - 2] : size;
    const ow = dims.length >= 1 ? dims[dims.length - 1] : size;
    const n = ow * oh;
    let mi = Infinity, ma = -Infinity;
    for (let i = 0; i < n; i++) { if (d[i] < mi) mi = d[i]; if (d[i] > ma) ma = d[i]; }
    const span = (ma - mi) || 1;
    const out = new Uint8ClampedArray(W * H * 4);
    for (let y = 0; y < H; y++) {
      const sy = Math.min(oh - 1, (y + 0.5) * oh / H - 0.5);
      const y0 = Math.max(0, Math.floor(sy)), y1 = Math.min(oh - 1, y0 + 1), fy = sy - y0;
      for (let x = 0; x < W; x++) {
        const sx = Math.min(ow - 1, (x + 0.5) * ow / W - 0.5);
        const x0 = Math.max(0, Math.floor(sx)), x1 = Math.min(ow - 1, x0 + 1), fx = sx - x0;
        const v = ((d[y0 * ow + x0] * (1 - fx) * (1 - fy) + d[y0 * ow + x1] * fx * (1 - fy)
          + d[y1 * ow + x0] * (1 - fx) * fy + d[y1 * ow + x1] * fx * fy) - mi) / span;
        const a = Math.max(0, Math.min(255, v * 255));
        const i = (y * W + x) * 4;
        out[i] = out[i + 1] = out[i + 2] = 255;
        out[i + 3] = a;
      }
    }
    self.postMessage({ id, type: 'done', width: W, height: H, pixels: out, ep }, [out.buffer]);
  } catch (err) {
    self.postMessage({ id, type: 'error', message: String(err?.message || err) });
  }
};

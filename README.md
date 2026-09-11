# Clipper

Local-first non-destructive cut board. Drop screenshots, slice boxes, isolate subjects, upscale in-browser (WASM/WebGPU), export a PNG zip + `clipper-manifest.json` for Cavalry.

**Live:** https://koffee-dev.github.io/clipper/

Nothing leaves the browser. ONNX weights live in `public/models/` and are fetched at runtime.

```bash
bun install
bun run dev
```

Build: `bun run build`. Models are not bundled into JS — they copy from `public/models/`.

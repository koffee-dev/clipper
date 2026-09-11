import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import JSZip from 'jszip';
import {
  MousePointer2, BoxSelect, Undo2, Redo2, Plus, ImagePlus,
  Link2, Link2Off, ClipboardPaste, Download, Focus, LayoutGrid,
  Layers, Trash2, X, Scan, Copy, ChevronRight, ChevronDown,
  Folder, FolderPlus, Box as BoxIcon, CornerDownRight, Grid3x3, Image as ImageIcon,
  AlignLeft, AlignCenterHorizontal, AlignRight, AlignStartVertical, AlignCenterVertical, AlignEndVertical,
  MoveHorizontal, MoveVertical, Magnet,
} from 'lucide-react';
import { useStore, defaultVariant, defaultSlicer, defaultImageStyle, selectBox, ancestorPath } from './store';
import { renderCut, renderSlicerCell, slicerCells, resolveMaskBase, guideCandidates, snapMoveRect, snapPoint, cssFilterString, scatterLayout, parseCssColor, colorToHex, cssBoxShadow } from './render';
import { UPSCALE_MODELS, ensureUpscaler, upscaleCanvas, onnxSpec } from './upscale';
import { getPreview, setPreview, previewFingerprint } from './previewCache';

const DISP_MAX = 520;
const HEADER = 28; // image card header height (board px) — image pixels start below it
const dispScale = (img) => (!img.w ? 1 : Math.min(1, DISP_MAX / img.w));

function LinkDot({ linked, onClick, title }) {
  return (
    <button title={title || (linked ? 'Linked — click to unlink' : 'Unlinked — click to re-link')}
      onClick={onClick}
      className={`p-1 rounded-md ${linked ? 'text-blue-600 bg-blue-50' : 'text-zinc-300 hover:text-zinc-500'}`}>
      {linked ? <Link2 size={13} /> : <Link2Off size={13} />}
    </button>
  );
}

// + menu per property: save the current value as a named set, apply or delete sets.
function VarPlus({ group, getValue, onApply, menuOpen, setMenuOpen }) {
  // NOTE: never derive (filter/map) inside the selector — a fresh array ref
  // each call retriggers render and React unmounts the app in a max-depth loop.
  const styleVars = useStore((st) => st.styleVars);
  const sets = styleVars.filter((v) => v.group === group);
  const open = menuOpen === group;
  return (
    <div className="relative">
      <button title={`Shared ${group} values`} onClick={() => setMenuOpen(open ? null : group)}
        className={`p-1 rounded-md ${open ? 'bg-zinc-900 text-white' : 'text-zinc-400 hover:text-zinc-700 hover:bg-zinc-100'}`}>
        <Plus size={13} />
      </button>
      {open && (
        <>
          <div className="fixed inset-0 z-40" onClick={() => setMenuOpen(null)} />
          <div className="absolute right-0 top-7 z-50 w-48 bg-white border border-zinc-200 rounded-xl shadow-xl p-1">
            {sets.length === 0 && <p className="text-[11px] text-zinc-400 px-2 py-1.5">No saved {group} yet</p>}
            {sets.map((sv) => (
              <div key={sv.id} className="flex items-center gap-0.5 rounded-lg hover:bg-zinc-100">
                <button title={`Apply ${sv.name}`} onClick={() => { onApply(structuredClone(sv.value)); setMenuOpen(null); }}
                  className="flex-1 text-left text-xs px-2 py-1.5 truncate">{sv.name}</button>
                <button title="Delete" onClick={() => useStore.getState().deleteStyleVar(sv.id)}
                  className="p-1.5 rounded-md text-zinc-300 hover:text-red-500"><X size={11} /></button>
              </div>
            ))}
            <button
              onClick={() => { const n = prompt(`Name this ${group}`); if (n?.trim()) useStore.getState().saveStyleVar(group, n.trim(), getValue()); setMenuOpen(null); }}
              className="w-full text-left text-[11px] font-medium px-2 py-1.5 rounded-lg mt-0.5 bg-zinc-100 hover:bg-zinc-200">+ Save current</button>
          </div>
        </>
      )}
    </div>
  );
}

function Row({ label, linked, onToggleLink, children, locked, onReset, varGroup, getVarValue, onApplyVar, menuOpen, setMenuOpen }) {
  return (
    <div className={`py-2 border-b border-zinc-100 ${locked ? 'opacity-60' : ''}`}>
      <div className="flex items-center justify-between mb-1">
        <span
          onDoubleClick={onReset}
          title={onReset ? 'Double-click to reset' : undefined}
          className={`text-[11px] font-medium text-zinc-500 uppercase tracking-wide ${onReset && !locked ? 'cursor-pointer hover:text-zinc-800' : ''}`}>{label}</span>
        <div className="flex items-center gap-0.5">
          {varGroup && !locked && getVarValue && onApplyVar && (
            <VarPlus group={varGroup} getValue={getVarValue} onApply={onApplyVar} menuOpen={menuOpen} setMenuOpen={setMenuOpen} />
          )}
          {onToggleLink && <LinkDot linked={linked} onClick={onToggleLink} />}
        </div>
      </div>
      {locked
        ? <div className="text-[11px] text-blue-600 flex items-center gap-1"><Link2 size={11} /> locked to original</div>
        : children}
    </div>
  );
}

const TweakCtx = createContext(null);

function formatNum(v, step) {
  if (step >= 1) return String(Math.round(v));
  const n = Math.round(v * 100) / 100;
  return String(n);
}

function Num({ value, onChange, min = 0, max = 999, step = 1, width = 'w-14' }) {
  const ref = useRef(null);
  const tweak = useContext(TweakCtx);
  const drag = useRef(null);
  const [draft, setDraft] = useState(null);
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  const tweakRef = useRef(tweak);
  tweakRef.current = tweak;
  const emit = (n) => {
    if (Number.isNaN(n)) return;
    let v = n;
    if (v < min) v = min;
    if (v > max) v = max;
    if (step >= 1) v = Math.round(v);
    else v = Math.round(v / step) * step;
    onChangeRef.current(v);
  };
  useEffect(() => {
    const move = (e) => {
      const d = drag.current;
      if (!d) return;
      const dx = e.clientX - d.x;
      if (!d.active && Math.abs(dx) < 4) return;
      if (!d.active) {
        d.active = true;
        document.body.style.cursor = 'ew-resize';
        document.body.style.userSelect = 'none';
        try { ref.current?.blur(); } catch { /* */ }
      }
      const mul = e.shiftKey ? 10 : e.altKey ? 0.1 : 1;
      emit(d.origin + dx * (step / 3) * mul);
      tweakRef.current?.begin();
    };
    const up = () => {
      const d = drag.current;
      if (!d) return;
      drag.current = null;
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      if (!d.active) {
        ref.current?.focus();
        ref.current?.select();
      }
      tweakRef.current?.endSoon();
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', up);
    return () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', up);
    };
  }, [min, max, step]);
  return (
    <input ref={ref} type="text" inputMode="decimal" spellCheck={false}
      value={draft !== null ? draft : formatNum(value, step)}
      onPointerDown={(e) => {
        if (e.button !== 0) return;
        if (document.activeElement === ref.current) return;
        e.preventDefault();
        drag.current = { x: e.clientX, origin: Number(value) || 0, active: false };
        tweak?.begin();
      }}
      onFocus={() => { setDraft(formatNum(value, step)); tweak?.begin(); }}
      onBlur={() => {
        const n = parseFloat(draft);
        setDraft(null);
        if (!Number.isNaN(n)) emit(n);
        tweak?.endSoon();
      }}
      onChange={(e) => {
        setDraft(e.target.value);
        const n = parseFloat(e.target.value);
        if (!Number.isNaN(n)) emit(n);
        tweak?.begin();
      }}
      onKeyDown={(e) => {
        if (e.key === 'Enter') e.currentTarget.blur();
        if (e.key === 'ArrowUp') { e.preventDefault(); emit((Number(value) || 0) + (e.shiftKey ? step * 10 : step)); }
        if (e.key === 'ArrowDown') { e.preventDefault(); emit((Number(value) || 0) - (e.shiftKey ? step * 10 : step)); }
      }}
      title="Drag to scrub · click to type · Shift faster · Alt finer"
      className={`${width} text-xs border border-zinc-200 rounded-md px-1.5 py-1 bg-white cursor-ew-resize focus:cursor-text`} />
  );
}
function Slider({ value, onChange, min = 0, max = 2, step = 0.01 }) {
  const tweak = useContext(TweakCtx);
  return <input type="range" value={value} min={min} max={max} step={step}
    onPointerDown={() => tweak?.begin()}
    onPointerUp={() => tweak?.endSoon()}
    onChange={(e) => { tweak?.begin(); onChange(parseFloat(e.target.value)); }}
    className="w-full" />;
}

function ShadowControls({ shadow, onChange }) {
  const hex = colorToHex(shadow.color);
  const op = shadow.opacity != null ? shadow.opacity : parseCssColor(shadow.color).a;
  return (
    <>
      <Slider value={shadow.blur} min={0} max={80} step={1}
        onChange={(v) => onChange({ ...shadow, blur: v })} />
      <div className="flex items-center gap-2 mt-1">
        <label className="text-[10px] text-zinc-400 flex items-center gap-1">spread
          <Num value={shadow.spread || 0} min={0}
            onChange={(v) => onChange({ ...shadow, spread: v })} /></label>
        <input type="color" value={hex}
          onChange={(e) => onChange({ ...shadow, color: e.target.value, opacity: op })}
          className="w-8 h-7 rounded cursor-pointer" title="Shadow color" />
        <label className="text-[10px] text-zinc-400 flex items-center gap-1" title="Opacity">
          α<Num value={Math.round(op * 100)} min={0} max={100} width="w-10"
            onChange={(v) => onChange({ ...shadow, color: hex, opacity: v / 100 })} /></label>
      </div>
      <div className="grid grid-cols-2 gap-1 mt-1">
        <label className="text-[10px] text-zinc-400">x<Num value={shadow.x} min={-100}
          onChange={(v) => onChange({ ...shadow, x: v })} width="w-full" /></label>
        <label className="text-[10px] text-zinc-400">y<Num value={shadow.y} min={-100}
          onChange={(v) => onChange({ ...shadow, y: v })} width="w-full" /></label>
      </div>
    </>
  );
}

// Thumbnail of one variant through the real pipeline. Transparent — parent supplies backdrop.
function CutThumb({ image, box, variant, maskBase, className = '' }) {
  const [url, setUrl] = useState('');
  useEffect(() => {
    let live = true;
    const el = document.querySelector(`img[data-img="${image.id}"]`);
    const h = requestAnimationFrame(() => {
      (async () => {
        try {
          const c = await renderCut({ img: el?.complete && el.naturalWidth ? el : undefined, imageUrl: image.url, box: { rect: variant.rect }, design: variant, scale: 0.5, imageStyle: image.style, maskBase, imageId: image.id });
          if (live) setUrl(c.toDataURL());
        } catch { /* noop */ }
      })();
    });
    return () => { live = false; cancelAnimationFrame(h); };
  }, [image, box, variant, maskBase]);
  if (!url) return <div className={`rounded-lg bg-zinc-100 animate-pulse min-h-[60px] min-w-[60px] ${className}`} />;
  return <img src={url} className={`${className}`} alt="" draggable={false} />;
}

function LiveCrop({ image, rect, maxW = 176, maxH = 240, className = '' }) {
  const ref = useRef(null);
  useEffect(() => {
    const c = ref.current;
    if (!c || !image || !rect) return;
    const w = Math.max(1, Math.round(rect.w)), h = Math.max(1, Math.round(rect.h));
    if (w < 2 || h < 2) return;
    const el = document.querySelector(`img[data-img="${image.id}"]`);
    if (!el?.complete || !el.naturalWidth) return;
    c.width = w; c.height = h;
    const ctx = c.getContext('2d');
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(el, rect.x, rect.y, rect.w, rect.h, 0, 0, w, h);
    const s = Math.min(maxW / w, maxH / h);
    c.style.width = `${Math.max(1, Math.round(w * s))}px`;
    c.style.height = `${Math.max(1, Math.round(h * s))}px`;
  }, [image, rect.x, rect.y, rect.w, rect.h, maxW, maxH]);
  return <canvas ref={ref} className={className} />;
}

// Thumbnail of one slicer cell.
function CellThumb({ image, cellRect, variant, className = '' }) {
  const [url, setUrl] = useState('');
  useEffect(() => {
    let live = true;
    (async () => {
      try {
        const c = await renderSlicerCell({ imageUrl: image.url, cellRect, variant, scale: 0.4 });
        if (live) setUrl(c.toDataURL());
      } catch { /* noop */ }
    })();
    return () => { live = false; };
  }, [image, cellRect, variant]);
  if (!url) return <div className={`rounded-md bg-zinc-100 animate-pulse min-h-[40px] min-w-[40px] ${className}`} />;
  return <img src={url} className={`${className}`} alt="" draggable={false} />;
}

// Preview backdrop: checker | white | dark | custom color
function bgStyle(bg, custom) {
  if (bg === 'white') return { className: 'bg-white', style: undefined };
  if (bg === 'dark') return { className: 'bg-zinc-900', style: undefined };
  if (bg === 'custom') return { className: '', style: { background: custom } };
  return { className: 'checker', style: undefined };
}
function BgSwitch({ bg, setBg, custom, setCustom }) {
  return (
    <div className="flex items-center gap-1 bg-white border border-zinc-200 rounded-lg p-0.5">
      {[
        { id: 'checker', t: 'Transparency', sw: 'checker' },
        { id: 'white', t: 'White', sw: 'bg-white border border-zinc-300' },
        { id: 'dark', t: 'Dark', sw: 'bg-zinc-900' },
      ].map((o) => (
        <button key={o.id} title={o.t} onClick={() => setBg(o.id)}
          className={`w-6 h-6 rounded-md ${o.sw} ${bg === o.id ? 'ring-2 ring-blue-500' : ''}`} />
      ))}
      <input type="color" title="Custom background" value={custom}
        onChange={(e) => { setCustom(e.target.value); setBg('custom'); }}
        className={`w-6 h-6 rounded-md cursor-pointer p-0 border-0 ${bg === 'custom' ? 'ring-2 ring-blue-500' : ''}`} />
    </div>
  );
}

const HANDLES = [
  { id: 'nw', cls: '-left-[5px] -top-[5px]', cur: 'nwse-resize', dx: -1, dy: -1 },
  { id: 'ne', cls: '-right-[5px] -top-[5px]', cur: 'nesw-resize', dx: 1, dy: -1 },
  { id: 'sw', cls: '-left-[5px] -bottom-[5px]', cur: 'nesw-resize', dx: -1, dy: 1 },
  { id: 'se', cls: '-right-[5px] -bottom-[5px]', cur: 'nwse-resize', dx: 1, dy: 1 },
  { id: 'n', cls: 'left-1/2 -translate-x-1/2 -top-[5px]', cur: 'ns-resize', dx: 0, dy: -1 },
  { id: 's', cls: 'left-1/2 -translate-x-1/2 -bottom-[5px]', cur: 'ns-resize', dx: 0, dy: 1 },
  { id: 'w', cls: '-left-[5px] top-1/2 -translate-y-1/2', cur: 'ew-resize', dx: -1, dy: 0 },
  { id: 'e', cls: '-right-[5px] top-1/2 -translate-y-1/2', cur: 'ew-resize', dx: 1, dy: 0 },
];

function applyResize(start, dx, dy, dir, img) {
  let { x, y, w, h } = start;
  if (dir.dx === 1) w = start.w + dx;
  if (dir.dx === -1) { x = start.x + dx; w = start.w - dx; }
  if (dir.dy === 1) h = start.h + dy;
  if (dir.dy === -1) { y = start.y + dy; h = start.h - dy; }
  if (w < 4) { if (dir.dx === -1) x -= 4 - w; w = 4; }
  if (h < 4) { if (dir.dy === -1) y -= 4 - h; h = 4; }
  x = Math.max(0, x); y = Math.max(0, y);
  if (img?.w) { w = Math.min(w, img.w - x); h = Math.min(h, img.h - y); }
  return { x, y, w: Math.max(4, w), h: Math.max(4, h) };
}

/* ---------------- Layers panel ---------------- */

function LayersPanel() {
  const s = useStore();
  const [renaming, setRenaming] = useState(null); // {kind, id}
  const [name, setName] = useState('');
  const [drop, setDrop] = useState(null);
  const [collapsed, setCollapsed] = useState({});
  const [hover, setHover] = useState(null); // {boxId, variantId, x, y} ghost preview

  const childGroups = (pid) => s.groups.filter((g) => (g.parentId || null) === (pid || null));
  const childBoxes = (pid, pkind) => s.boxes.filter((b) => (b.parentId || null) === (pid || null) && (b.parentKind || null) === (pkind || null));
  const variantsOf = (boxId) => s.variants.filter((v) => v.boxId === boxId);

  const startRename = (kind, id, cur) => { setRenaming({ kind, id }); setName(cur); };
  const commitRename = () => {
    if (renaming && name.trim()) {
      if (renaming.kind === 'group') s.renameGroup(renaming.id, name.trim());
      else if (renaming.kind === 'variant') s.renameVariant(renaming.id, name.trim());
      else if (renaming.kind === 'image') s.renameImage(renaming.id, name.trim());
      else s.renameBox(renaming.id, name.trim());
    }
    setRenaming(null);
  };

  const readDrop = (e) => {
    try { return JSON.parse(e.dataTransfer.getData('text/clipper')); } catch { return null; }
  };

  const rowBase = (active, isDrop) =>
    `flex items-center gap-1.5 pr-1.5 py-1 rounded-lg cursor-pointer group/row ${active ? 'bg-blue-50' : 'hover:bg-zinc-100'} ${isDrop ? 'ring-2 ring-blue-400' : ''}`;

  const renderVariant = (v, depth, boxId) => {
    const active = v.id === s.sel.variantId;
    const linked = v.links && Object.values(v.links).some(Boolean);
    const isRen = renaming?.kind === 'variant' && renaming.id === v.id;
    const vs = variantsOf(boxId);
    return (
      <div key={v.id}
        onClick={(e) => { e.stopPropagation(); selectBox(boxId, v.id); }}
        onMouseEnter={(e) => { e.stopPropagation(); setHover({ boxId, variantId: v.id, x: e.clientX, y: e.clientY }); }}
        onMouseLeave={() => setHover(null)}
        onDoubleClick={(e) => { e.stopPropagation(); startRename('variant', v.id, v.name); }}
        className={rowBase(active, false)} style={{ paddingLeft: depth * 12 + 6 }}>
        <CornerDownRight size={12} className="text-zinc-300 shrink-0" />
        {isRen ? (
          <input autoFocus value={name} onChange={(e) => setName(e.target.value)}
            onBlur={commitRename} onClick={(e) => e.stopPropagation()}
            onKeyDown={(e) => { if (e.key === 'Enter') commitRename(); if (e.key === 'Escape') setRenaming(null); e.stopPropagation(); }}
            className="text-xs bg-white border border-blue-400 rounded px-1 py-0.5 flex-1 min-w-0 outline-none" />
        ) : (
          <span className="text-xs truncate flex-1 min-w-0">{v.name}</span>
        )}
        {linked && <span className="text-blue-500" title="Linked to original"><Link2 size={11} /></span>}
        {v.mask?.enabled && <span title="Mask — inverts selection" className="text-[11px] text-purple-500">◐</span>}
        {vs.length > 1 && (
          <button title="Delete variant" onClick={(e) => { e.stopPropagation(); s.deleteVariant(boxId, v.id); }}
            className="hidden group-hover/row:block p-0.5 rounded text-zinc-300 hover:text-red-500"><X size={11} /></button>
        )}
      </div>
    );
  };

  const renderBox = (b, depth) => {
    const active = b.id === s.sel.boxId;
    const vs = variantsOf(b.id);
    const img = s.images.find((m) => m.id === b.imageId);
    const kids = childBoxes(b.id, 'box');
    const isCollapsed = collapsed[b.id];
    const isRen = renaming?.kind === 'box' && renaming.id === b.id;
    const showVariants = vs.length > 1 || active;
    return (
      <div key={b.id}>
        <div draggable={!isRen}
          onDragStart={(e) => { e.dataTransfer.setData('text/clipper', JSON.stringify({ kind: 'box', id: b.id })); e.dataTransfer.effectAllowed = 'move'; }}
          onDragOver={(e) => { e.preventDefault(); setDrop(b.id); }}
          onDragLeave={() => setDrop((d) => d === b.id ? null : d)}
          onDrop={(e) => { e.preventDefault(); e.stopPropagation(); setDrop(null); const d = readDrop(e); if (d && !(d.kind === 'box' && d.id === b.id)) s.setParent(d.kind, d.id, b.id, 'box'); }}
          onMouseEnter={(e) => setHover({ boxId: b.id, variantId: vs[0]?.id, x: e.clientX, y: e.clientY })}
          onMouseLeave={() => setHover(null)}
          onClick={(e) => {
            if (e.shiftKey && s.sel.boxId && s.sel.boxId !== b.id) {
              const cur = s.sel.multi || [];
              s.setSel({ boxId: s.sel.boxId, variantId: s.sel.variantId, imageId: null,
                multi: cur.includes(b.id) ? cur.filter((id) => id !== b.id) : [...cur, b.id] });
            } else selectBox(b.id, vs[0]?.id);
          }}
          onDoubleClick={() => startRename('box', b.id, b.name)}
          className={rowBase(active, drop === b.id) + ((s.sel.multi || []).includes(b.id) ? ' ring-1 ring-violet-300 bg-violet-50/50' : '')} style={{ paddingLeft: depth * 12 + 6 }}>
          {(kids.length > 0 || showVariants) ? (
            <span onClick={(e) => { e.stopPropagation(); setCollapsed((c) => ({ ...c, [b.id]: !c[b.id] })); }}
              className="text-zinc-400 hover:text-zinc-700">{isCollapsed ? <ChevronRight size={13} /> : <ChevronDown size={13} />}</span>
          ) : <span className="w-[13px]" />}
          <BoxIcon size={13} className="shrink-0 text-zinc-400" />
          {isRen ? (
            <input autoFocus value={name} onChange={(e) => setName(e.target.value)}
              onBlur={commitRename} onClick={(e) => e.stopPropagation()}
              onKeyDown={(e) => { if (e.key === 'Enter') commitRename(); if (e.key === 'Escape') setRenaming(null); e.stopPropagation(); }}
              className="text-xs bg-white border border-blue-400 rounded px-1 py-0.5 flex-1 min-w-0 outline-none" />
          ) : (
            <span className="text-xs truncate flex-1 min-w-0" title={`${b.name} · ${img?.name || ''}`}>{b.name}</span>
          )}
          {vs.length > 1 && <span className="text-[9px] font-mono text-zinc-400">×{vs.length}</span>}
          {b.slicer?.enabled && <Grid3x3 size={11} className="text-emerald-500" />}
          {s.variants.some((v) => v.boxId === b.id && v.mask?.enabled) && <span title="Has mask variant" className="text-[11px] text-purple-500">◐</span>}
          <span className="hidden group-hover/row:flex items-center" onClick={(e) => e.stopPropagation()}>
            <button title="Duplicate variant (Ctrl+D)" onClick={() => s.addVariant(b.id)}
              className="p-1 rounded text-zinc-400 hover:text-zinc-700 hover:bg-zinc-200"><Copy size={12} /></button>
            <button title="Delete" onClick={() => s.deleteBox(b.id)}
              className="p-1 rounded text-zinc-400 hover:text-red-500 hover:bg-red-50"><Trash2 size={12} /></button>
          </span>
        </div>
        {!isCollapsed && showVariants && vs.map((v) => renderVariant(v, depth + 1, b.id))}
        {!isCollapsed && kids.map((k) => renderBox(k, depth + 1))}
      </div>
    );
  };

  const renderGroup = (g, depth) => {
    const gkids = childGroups(g.id);
    const bkids = childBoxes(g.id, 'group');
    const isCollapsed = collapsed[g.id];
    const isRen = renaming?.kind === 'group' && renaming.id === g.id;
    return (
      <div key={g.id}>
        <div draggable={!isRen}
          onDragStart={(e) => { e.dataTransfer.setData('text/clipper', JSON.stringify({ kind: 'group', id: g.id })); e.dataTransfer.effectAllowed = 'move'; }}
          onDragOver={(e) => { e.preventDefault(); setDrop(g.id); }}
          onDragLeave={() => setDrop((d) => d === g.id ? null : d)}
          onDrop={(e) => { e.preventDefault(); e.stopPropagation(); setDrop(null); const d = readDrop(e); if (d) s.setParent(d.kind, d.id, g.id, 'group'); }}
          onDoubleClick={() => startRename('group', g.id, g.name)}
          className={rowBase(false, drop === g.id)} style={{ paddingLeft: depth * 12 + 6 }}>
          <span onClick={() => setCollapsed((c) => ({ ...c, [g.id]: !c[g.id] }))}
            className="text-zinc-400 hover:text-zinc-700">{isCollapsed ? <ChevronRight size={13} /> : <ChevronDown size={13} />}</span>
          <Folder size={13} className="text-zinc-400 shrink-0" />
          {isRen ? (
            <input autoFocus value={name} onChange={(e) => setName(e.target.value)}
              onBlur={commitRename}
              onKeyDown={(e) => { if (e.key === 'Enter') commitRename(); if (e.key === 'Escape') setRenaming(null); e.stopPropagation(); }}
              className="text-xs bg-white border border-blue-400 rounded px-1 py-0.5 flex-1 min-w-0 outline-none" />
          ) : (
            <span className="text-xs font-medium truncate flex-1 min-w-0">{g.name}</span>
          )}
          <span className="text-[9px] font-mono text-zinc-300">{gkids.length + bkids.length}</span>
          <span className="hidden group-hover/row:flex items-center" onClick={(e) => e.stopPropagation()}>
            <button title="Delete group (keeps contents)" onClick={() => s.deleteGroup(g.id)}
              className="p-1 rounded text-zinc-400 hover:text-red-500 hover:bg-red-50"><Trash2 size={12} /></button>
          </span>
        </div>
        {!isCollapsed && gkids.map((k) => renderGroup(k, depth + 1))}
        {!isCollapsed && bkids.map((k) => renderBox(k, depth + 1))}
      </div>
    );
  };

  return (
    <aside className="w-60 border-r border-zinc-200 bg-white flex flex-col shrink-0 min-h-0">
      <div className="h-10 flex items-center gap-1 px-2.5 border-b border-zinc-100 shrink-0">
        <Layers size={13} className="text-zinc-400" />
        <span className="text-xs font-semibold">Layers</span>
        <span className="text-[10px] text-zinc-300 font-mono">{s.boxes.length}</span>
        <div className="flex-1" />
        <button title="New group (exports as folder)" onClick={() => { const id = s.addGroup(); const g = useStore.getState().groups.find((x) => x.id === id); startRename('group', id, g?.name || ''); }}
          className="p-1.5 rounded-lg text-zinc-400 hover:text-zinc-700 hover:bg-zinc-100"><FolderPlus size={14} /></button>
      </div>
      <div className="flex-1 overflow-y-auto p-1.5"
        onDragOver={(e) => { e.preventDefault(); }}
        onDrop={(e) => { e.preventDefault(); setDrop(null); const d = readDrop(e); if (d) s.setParent(d.kind, d.id, null, null); }}>
        {s.images.map((im) => {
          const active = im.id === s.sel.imageId && !s.sel.boxId;
          const isRen = renaming?.kind === 'image' && renaming.id === im.id;
          const n = s.boxes.filter((b) => b.imageId === im.id).length;
          return (
            <div key={im.id}
              onClick={() => s.setSel({ boxId: null, variantId: null, imageId: im.id })}
              onDoubleClick={() => startRename('image', im.id, im.name)}
              className={rowBase(active, false)}>
              <ImageIcon size={13} className="text-zinc-400 shrink-0" />
              {isRen ? (
                <input autoFocus value={name} onChange={(e) => setName(e.target.value)}
                  onBlur={commitRename} onClick={(e) => e.stopPropagation()}
                  onKeyDown={(e) => { if (e.key === 'Enter') commitRename(); if (e.key === 'Escape') setRenaming(null); e.stopPropagation(); }}
                  className="text-xs bg-white border border-blue-400 rounded px-1 py-0.5 flex-1 min-w-0 outline-none" />
              ) : (
                <span className="text-xs truncate flex-1 min-w-0" title={im.name}>{im.name}</span>
              )}
              <span className="text-[9px] font-mono text-zinc-300">{n}</span>
            </div>
          );
        })}
        {s.images.length > 0 && (s.groups.length > 0 || s.boxes.length > 0) && (
          <div className="px-2 pt-2 pb-0.5 text-[10px] font-semibold text-zinc-300 uppercase tracking-wide">Cuts</div>
        )}
        {childGroups(null).map((g) => renderGroup(g, 0))}
        {childBoxes(null, null).map((b) => renderBox(b, 0))}
        {!s.groups.length && !s.boxes.length && (
          <p className="text-[11px] text-zinc-400 text-center mt-8 px-4">Press B, drag on an image.<br />Drag rows here to nest.</p>
        )}
      </div>
      {/* hover ghost: live cut preview without leaving layers */}
      {hover && (() => {
        const hb = s.boxes.find((x) => x.id === hover.boxId);
        const hv = s.variants.find((x) => x.id === hover.variantId);
        const hi = hb && s.images.find((m) => m.id === hb.imageId);
        if (!hb || !hv || !hi) return null;
        const flip = hover.x > window.innerWidth - 240;
        return (
          <div className="fixed z-[60] pointer-events-none"
            style={{ left: (flip ? hover.x - 208 : hover.x + 14) + 'px', top: Math.min(hover.y + 14, window.innerHeight - 190) + 'px' }}>
            <div className="checker rounded-xl border border-zinc-200 p-2 bg-white shadow-2xl w-[192px]">
              <CutThumb image={hi} box={hb} variant={hv} maskBase={resolveMaskBase(hb, s.boxes, s.variants)} className="max-w-full max-h-[140px] rounded-md mx-auto" />
              <div className="text-[10px] font-mono text-zinc-500 mt-1 truncate">{hb.name}/{hv.name}</div>
            </div>
          </div>
        );
      })()}
      <div className="px-2.5 py-1.5 border-t border-zinc-100 shrink-0">
        <p className="text-[10px] text-zinc-300">drop onto a row to nest · groups = folders</p>
      </div>
    </aside>
  );
}

/* ---------------- Focus viewer: zoomable stage + true export-fidelity render ---------------- */

// Hi-res cut rendered through the real pipeline at export scale, then the
// effective upscale model — exactly what the zip will contain.
function HiResCut({ image, box, variant, maskBase, model, exportScale, className = '' }) {
  const [url, setUrl] = useState('');
  const [busy, setBusy] = useState(false);
  const [prog, setProg] = useState('');
  const [note, setNote] = useState('');
  const urlRef = useRef('');
  useEffect(() => {
    let live = true;
    const ctrl = new AbortController();
    setBusy(true); setNote(''); setProg('');
    const key = previewFingerprint({ imageId: image.id, variant, model, exportScale, imageStyle: image.style, maskBase });
    const hit = getPreview(key);
    if (hit?.url) {
      setUrl(hit.url);
      setBusy(false);
      return () => { live = false; ctrl.abort(); };
    }
    (async () => {
      try {
        const el = document.querySelector(`img[data-img="${image.id}"]`);
        if (variant.isolate?.enabled) setProg('isolating…');
        let canvas = await renderCut({ img: el?.complete && el.naturalWidth ? el : undefined,
          imageUrl: image.url, box: { rect: variant.rect }, design: variant,
          scale: exportScale, imageStyle: image.style, maskBase, imageId: image.id });
        if (!live) return;
        const skipFull = variant.mask?.enabled && variant.isolate?.upscaleMask;
        if (model && model !== 'canvas' && !skipFull) {
          const r = await upscaleCanvas(canvas, model, {
            signal: ctrl.signal,
            onTile: (d, t, ep) => { if (live) setProg(`${d}/${t}${ep === 'webgpu' ? ' · GPU' : ''}`); },
          });
          canvas = r.canvas;
          if (live && r.note) setNote(r.note);
        }
        if (!live) return;
        const blob = await new Promise((res) => canvas.toBlob(res, 'image/png'));
        if (!live || !blob) return;
        const u = URL.createObjectURL(blob);
        urlRef.current = u;
        setPreview(key, u);
        setUrl(u);
      } catch (e) {
        if (live && e?.message !== 'aborted') setNote(String(e?.message || e));
      }
      if (live) { setBusy(false); setProg(''); }
    })();
    return () => {
      live = false;
      ctrl.abort();
    };
  }, [image, box, variant, maskBase, model, exportScale]);
  useEffect(() => () => { /* cached blob URLs are owned by previewCache */ }, []);
  return (
    <div className="relative grid place-items-center">
      {!url && <div className="rounded-lg bg-zinc-100 animate-pulse min-h-[200px] min-w-[260px]" />}
      {url && <img src={url} className={className} alt="" draggable={false} />}
      {busy && (
        <div className="absolute top-2 right-2 text-[10px] font-mono bg-zinc-900/80 text-white px-1.5 py-0.5 rounded">
          {prog ? `upscaling ${prog}` : 'rendering…'}
        </div>
      )}
      {note && <div className="absolute bottom-2 left-2 right-2 text-[10px] bg-amber-50 text-amber-700 px-2 py-1 rounded-lg">{note}</div>}
    </div>
  );
}

function FocusViewer({ bgClass, bgStyle, badge, children }) {
  // zoom/pan live in a ref so the wheel handler (registered once) never goes
  // stale — and no setState-inside-updater, which StrictMode double-fires.
  const [view, setView] = useState({ z: 1, x: 0, y: 0 });
  const [grabbing, setGrabbing] = useState(false);
  const viewRef = useRef({ z: 1, x: 0, y: 0 });
  const dragRef = useRef(null);
  const contentRef = useRef(null);
  const touched = useRef(false); // user took over the view — stop auto-fitting
  const ref = useRef(null);
  const setBoth = (v) => { viewRef.current = v; setView(v); };
  // fit: fixed frame, content zooms to fill it — upscaled previews zoom OUT
  const fit = () => {
    const stage = ref.current, content = contentRef.current;
    if (!stage || !content) return setBoth({ z: 1, x: 0, y: 0 });
    const cw = content.scrollWidth || 1, ch = content.scrollHeight || 1;
    const z = Math.min(8, Math.max(0.05, Math.min(stage.clientWidth / cw, stage.clientHeight / ch)));
    setBoth({ z, x: (stage.clientWidth - cw * z) / 2, y: (stage.clientHeight - ch * z) / 2 });
  };
  useEffect(() => {
    touched.current = false;
    const id = requestAnimationFrame(fit);
    return () => cancelAnimationFrame(id);
  }, [badge]);
  useEffect(() => {
    const c = contentRef.current;
    if (!c || typeof ResizeObserver === 'undefined') return;
    // async cuts change size as they finish rendering — keep fitting until touched
    const ro = new ResizeObserver(() => { if (!touched.current) fit(); });
    ro.observe(c);
    return () => ro.disconnect();
  }, []);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const h = (e) => {
      e.preventDefault();
      const r = el.getBoundingClientRect();
      const mx = e.clientX - r.left, my = e.clientY - r.top;
      const v = viewRef.current;
      const nz = Math.min(8, Math.max(0.05, v.z * Math.exp(-e.deltaY * 0.0018)));
      const k = nz / v.z;
      touched.current = true;
      setBoth({ z: nz, x: mx - (mx - v.x) * k, y: my - (my - v.y) * k });
    };
    el.addEventListener('wheel', h, { passive: false });
    return () => el.removeEventListener('wheel', h);
  }, []);
  return (
    <div ref={ref} className={`rounded-2xl border border-zinc-200 overflow-hidden relative mx-auto shrink-0 ${bgClass}`}
      style={{ ...bgStyle, cursor: grabbing ? 'grabbing' : 'grab', width: 'min(calc(100vh - 280px), 100%)', aspectRatio: '1 / 1' }}
      onMouseDown={(e) => { if (e.button !== 0) return; touched.current = true; dragRef.current = { x: e.clientX - viewRef.current.x, y: e.clientY - viewRef.current.y }; setGrabbing(true); }}
      onMouseMove={(e) => { const d = dragRef.current; if (d) setBoth({ ...viewRef.current, x: e.clientX - d.x, y: e.clientY - d.y }); }}
      onMouseUp={() => { dragRef.current = null; setGrabbing(false); }}
      onMouseLeave={() => { dragRef.current = null; setGrabbing(false); }}
      onDoubleClick={() => { fit(); touched.current = true; }} title="Scroll to zoom at cursor · drag to pan · double-click to fit">
      <div ref={contentRef} style={{ transform: `translate(${view.x}px,${view.y}px) scale(${view.z})`, transformOrigin: '0 0' }} className="w-max">
        {children}
      </div>
      <button onClick={() => { fit(); touched.current = true; }} title="Fit to view"
        className="absolute bottom-2 right-2 text-[10px] font-mono bg-zinc-900/80 text-white px-2 py-0.5 rounded-md">{Math.round(view.z * 100)}%</button>
    </div>
  );
}

/* ---------------- App ---------------- */

export default function App() {
  const s = useStore();
  const boardRef = useRef(null);
  const [drag, setDrag] = useState(null); // {kind, pushed}
  const [draw, setDraw] = useState(null);
  const drawRef = useRef(null); // atomic guard — exactly one box per drag
  const fileRef = useRef(null);
  const [previewBg, setPreviewBg] = useState('checker');
  const [previewCustom, setPreviewCustom] = useState('#e8f0fe');
  const [previewModel, setPreviewModel] = useState('auto'); // focus lens: auto = what export would use

  const setDrawBoth = (d) => { drawRef.current = d; setDraw(d); };

  const ensurePushed = (d) => {
    if (!d?.pushed && d?.kind !== 'pan') { useStore.getState().beginHistory(); return { ...d, pushed: true }; }
    return d;
  };

  // keyboard
  useEffect(() => {
    const h = (e) => {
      const typing = ['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement?.tagName);
      const mod = e.metaKey || e.ctrlKey;
      const st = useStore.getState();
      if (mod && e.key.toLowerCase() === 'z' && !e.shiftKey) { e.preventDefault(); st.undo(); return; }
      if (mod && (e.key.toLowerCase() === 'y' || (e.key.toLowerCase() === 'z' && e.shiftKey))) { e.preventDefault(); st.redo(); return; }
      if (typing) return;
      if (mod && e.key.toLowerCase() === 'd' && st.sel.boxId) { e.preventDefault(); st.addVariant(st.sel.boxId); }
      else if (mod && e.altKey && e.key.toLowerCase() === 'c') { st.copyStyle(); }
      else if (mod && e.altKey && e.key.toLowerCase() === 'v') { st.pasteStyle(); }
      else if (e.key === '1') st.setMode('board');
      else if (e.key === '2') st.setMode('focus');
      else if (e.key === '3') st.setMode('all');
      else if (e.key.toLowerCase() === 'v' && !mod) st.setTool('select');
      else if (e.key.toLowerCase() === 'b' && !mod) st.setTool(st.tool === 'box' ? 'select' : 'box');
      else if (e.key.startsWith('Arrow') && st.sel.boxId && st.sel.variantId) {
        e.preventDefault();
        const v = st.variants.find((x) => x.id === st.sel.variantId);
        if (!v) return;
        const step = e.shiftKey ? 10 : 1;
        let { x, y } = v.rect;
        if (e.key === 'ArrowLeft') x -= step;
        if (e.key === 'ArrowRight') x += step;
        if (e.key === 'ArrowUp') y -= step;
        if (e.key === 'ArrowDown') y += step;
        st.updateVariantRect(v.boxId, v.id, { ...v.rect, x, y });
      }
      else if ((e.key === 'Delete' || e.key === 'Backspace') && (st.sel.boxId || (st.sel.multi || []).length)) {
        st.deleteBoxes([st.sel.boxId, ...(st.sel.multi || [])].filter(Boolean));
      }
      else if (e.key === 'Escape') st.setSel({ boxId: null, variantId: null, imageId: null, multi: [] });
    };
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, []);

  // paste images
  useEffect(() => {
    const h = (e) => {
      const files = [...(e.clipboardData?.files || [])].filter((f) => f.type.startsWith('image/'));
      if (files.length) { e.preventDefault(); useStore.getState().addImages(files); }
    };
    window.addEventListener('paste', h);
    return () => window.removeEventListener('paste', h);
  }, []);

  // global release — dropping over panels or outside the window never sticks
  const endAllRef = useRef(null);
  useEffect(() => {
    const h = () => endAllRef.current?.();
    window.addEventListener('mouseup', h);
    window.addEventListener('blur', h);
    return () => { window.removeEventListener('mouseup', h); window.removeEventListener('blur', h); };
  }, []);

  // wheel-to-zoom at cursor (non-passive so preventDefault works)
  useEffect(() => {
    const el = boardRef.current;
    if (!el) return;
    const h = (e) => {
      e.preventDefault();
      const st = useStore.getState();
      const r = el.getBoundingClientRect();
      const mx = e.clientX - r.left, my = e.clientY - r.top;
      const zoom = st.cam.zoom;
      const nz = Math.min(4, Math.max(0.2, zoom * Math.exp(-e.deltaY * 0.0018)));
      st.setCam({ x: mx - ((mx - st.cam.x) * nz) / zoom, y: my - ((my - st.cam.y) * nz) / zoom, zoom: nz });
    };
    el.addEventListener('wheel', h, { passive: false });
    return () => el.removeEventListener('wheel', h);
  }, [s.mode]);

  const selBox = s.boxes.find((b) => b.id === s.sel.boxId);
  const selVariant = s.variants.find((v) => v.id === s.sel.variantId) || s.variants.find((v) => v.boxId === s.sel.boxId);
  const isLinkedVariant = selVariant && selVariant.links && Object.keys(selVariant.links).length > 0;
  const boxVariants = useMemo(() => s.variants.filter((v) => v.boxId === s.sel.boxId), [s.variants, s.sel.boxId]);
  const selImage = s.images.find((i) => i.id === selBox?.imageId);
  const selImg = s.images.find((i) => i.id === s.sel.imageId);
  const imgSt = selImg ? (selImg.style || defaultImageStyle()) : null;
  const freshImg = useMemo(() => defaultImageStyle(), []);

  const [varMenu, setVarMenu] = useState(null);
  const [snapOn, setSnapOn] = useState(true);
  const [tweakOn, setTweakOn] = useState(false);
  const hideTweak = useRef(null);
  const tweakApi = useMemo(() => ({
    begin() { clearTimeout(hideTweak.current); setTweakOn(true); },
    endSoon() {
      clearTimeout(hideTweak.current);
      hideTweak.current = setTimeout(() => setTweakOn(false), 700);
    },
  }), []);
  // shared-value menu wiring: box variants and image styles share group keys
  const vp = (group) => ({ varGroup: group,
    getVarValue: () => structuredClone(selVariant[group]),
    onApplyVar: (v) => s.updateVariant(selVariant.id, group, v),
    menuOpen: varMenu, setMenuOpen: setVarMenu });
  const ivp = (group) => ({ varGroup: group,
    getVarValue: () => structuredClone(imgSt[group]),
    onApplyVar: (v) => s.updateImageStyle(selImg.id, group, v),
    menuOpen: varMenu, setMenuOpen: setVarMenu });

  const fresh = useMemo(() => defaultVariant('tmp', { x: 0, y: 0, w: 10, h: 10 }), []);
  const resetGroup = (group) => {
    if (!selVariant || !selBox) return;
    if (group === 'rect') {
      if (selImage?.w) s.updateVariantRect(selBox.id, selVariant.id, { x: 0, y: 0, w: selImage.w, h: selImage.h });
      return;
    }
    s.updateVariant(selVariant.id, group, structuredClone(fresh[group]));
  };

  // ---- coordinate helpers (all account for header offset) ----
  const boardPos = (e) => {
    const r = boardRef.current.getBoundingClientRect();
    const cam = useStore.getState().cam;
    return { x: (e.clientX - r.left - cam.x) / cam.zoom, y: (e.clientY - r.top - cam.y) / cam.zoom };
  };
  const imgPt = (e, image) => {
    const p = boardPos(e);
    const ds = dispScale(image);
    return { x: (p.x - image.x) / ds, y: (p.y - image.y - HEADER) / ds };
  };
  const hitVariant = (pt, imageId) => {
    const st = useStore.getState();
    for (let i = st.boxes.length - 1; i >= 0; i--) {
      const b = st.boxes[i];
      if (b.imageId !== imageId) continue;
      const vs = st.variants.filter((v) => v.boxId === b.id);
      for (let j = vs.length - 1; j >= 0; j--) {
        const v = vs[j], r = v.rect;
        if (pt.x >= r.x && pt.x <= r.x + r.w && pt.y >= r.y && pt.y <= r.y + r.h) return { box: b, variant: v };
      }
    }
    return null;
  };
  const beginVariantMove = (e, box, variant, image) => {
    const r = boardRef.current.getBoundingClientRect();
    const cam = useStore.getState().cam;
    const px = (e.clientX - r.left - cam.x) / cam.zoom, py = (e.clientY - r.top - cam.y) / cam.zoom;
    const dsc = dispScale(image);
    setDrag({ kind: 'boxmove', boxId: box.id, variantId: variant.id, imageId: image.id, pushed: false,
      startRect: { ...variant.rect }, offX: variant.rect.x - (px - image.x) / dsc, offY: variant.rect.y - (py - image.y - HEADER) / dsc });
  };

  // snap guides + loupe state (loupe paints imperatively to avoid re-renders)
  const [guides, setGuides] = useState({ imageId: null, list: [] });
  const loupeRef = useRef(null), loupeCanvasRef = useRef(null), loupeLabelRef = useRef(null);
  const siblingRects = (imageId, excludeVariantId) => {
    const st = useStore.getState();
    const out = [];
    for (const b of st.boxes) {
      if (b.imageId !== imageId) continue;
      for (const v of st.variants.filter((x) => x.boxId === b.id)) {
        if (v.id !== excludeVariantId) out.push(v.rect);
      }
    }
    return out;
  };
  const snapT = (img) => {
    const st = useStore.getState();
    return 6 / (st.cam.zoom * dispScale(img));
  };
  const paintLoupe = (clientX, clientY, image, pt) => {
    const wrap = loupeRef.current, cv = loupeCanvasRef.current, lab = loupeLabelRef.current;
    if (!wrap || !cv) return;
    const S2 = 132, WIN = 44;
    cv.width = S2; cv.height = S2;
    const g = cv.getContext('2d');
    g.imageSmoothingEnabled = false;
    g.clearRect(0, 0, S2, S2);
    const el = document.querySelector(`img[data-img="${image.id}"]`);
    if (el?.complete && el.naturalWidth) {
      g.drawImage(el, pt.x - WIN / 2, pt.y - WIN / 2, WIN, WIN, 0, 0, S2, S2);
    }
    g.strokeStyle = 'rgba(59,130,246,.9)'; g.lineWidth = 1;
    g.beginPath(); g.moveTo(S2 / 2, 0); g.lineTo(S2 / 2, S2); g.moveTo(0, S2 / 2); g.lineTo(S2, S2 / 2); g.stroke();
    g.strokeStyle = '#3b82f6'; g.lineWidth = 2; g.strokeRect(1, 1, S2 - 2, S2 - 2);
    if (lab) lab.textContent = `${Math.round(pt.x)}, ${Math.round(pt.y)}`;
    wrap.style.display = 'block';
    wrap.style.left = Math.min(clientX + 18, window.innerWidth - 170) + 'px';
    wrap.style.top = Math.min(clientY + 18, window.innerHeight - 200) + 'px';
  };
  const hideLoupe = () => { if (loupeRef.current) loupeRef.current.style.display = 'none'; };

  const startDraw = (e, image) => {
    if (e.button !== 0) return;
    if (useStore.getState().tool !== 'box') return;
    e.stopPropagation();
    const pt = imgPt(e, image);
    setDrawBoth({ imageId: image.id, startX: pt.x, startY: pt.y, curX: pt.x, curY: pt.y });
  };
  // single commit point — ref guard means bubbled mouseups can't double-create
  const endDraw = () => {
    const d = drawRef.current;
    if (!d) return;
    setDrawBoth(null);
    const x = Math.min(d.startX, d.curX), y = Math.min(d.startY, d.curY);
    const w = Math.abs(d.curX - d.startX), h = Math.abs(d.curY - d.startY);
    if (w > 8 && h > 8) {
      // clamp to the image so boxes can never hang off the card
      const st = useStore.getState();
      const im = st.images.find((m) => m.id === d.imageId);
      const cx = Math.max(0, x), cy = Math.max(0, y);
      let cw = w - (cx - x), ch = h - (cy - y);
      if (im?.w) { cw = Math.min(cw, im.w - cx); ch = Math.min(ch, im.h - cy); }
      if (cw > 8 && ch > 8) st.addBox(d.imageId, { x: cx, y: cy, w: cw, h: ch });
    }
  };
  endAllRef.current = () => { endDraw(); setDrag(null); setGuides({ imageId: null, list: [] }); hideLoupe(); };

  // ---- export + splash ----
  const [exporting, setExporting] = useState(false);
  const [done, setDone] = useState(false);
  const [splash, setSplash] = useState([]); // [{path, thumb}]
  const [activeCut, setActiveCut] = useState(null);
  const [upscaleNote, setUpscaleNote] = useState('');
  const [exportScope, setExportScope] = useState('all');
  const jobs = useMemo(() => {
    const out = [];
    const boxes = exportScope === 'selected' && s.sel.boxId
      ? s.boxes.filter((b) => b.id === s.sel.boxId) : s.boxes;
    for (const b of boxes)
      for (const v of s.variants.filter((x) => x.boxId === b.id)) out.push({ box: b, variant: v });
    return out;
  }, [s.boxes, s.variants, exportScope, s.sel.boxId]);
  const scatter = useMemo(() => scatterLayout(Math.max(1, (s.exportOpen ? jobs.length : s.variants.length) || 1), 100, 100, 22, 18, 40), [s.exportOpen, jobs.length, s.variants.length]);
  const safe = (n) => String(n).replace(/[^\w\-]+/g, '-');

  const doExport = useCallback(async () => {
    const st = useStore.getState();
    const list = jobs;
    if (!list.length) return;
    const r2 = (v) => Math.round(v * 100) / 100;
    const manifest = [];
    setExporting(true); setDone(false); setSplash([]); setUpscaleNote('');
    const upModels = new Set(list.map(({ variant }) => variant.upscale && variant.upscale !== 'auto' ? variant.upscale : st.upscaleModel));
    const effOf = (variant) => (variant.upscale && variant.upscale !== 'auto' ? variant.upscale : st.upscaleModel);
    for (const id of [...upModels].filter((id) => onnxSpec(id))) {
      const up = await ensureUpscaler(id);
      if (!up.ready) setUpscaleNote(`${id} weights missing — fell back to hi-q canvas. See public/models/README.md`);
    }
    const zip = new JSZip();
    const storeCell = async (canvas, path, thumbOf, entry, model) => {
      let out = canvas;
      let via = 'canvas';
      if (model !== 'canvas') {
        const r = await upscaleCanvas(canvas, model);
        out = r.canvas; via = r.via || model;
        if (r.note) setUpscaleNote(`ESRGAN note: ${r.note}`);
      }
      const blob = await new Promise((r) => out.toBlob(r, 'image/png'));
      zip.file(path, blob);
      manifest.push({ ...entry, file: path, canvasW: out.width, canvasH: out.height, scale: st.exportScale, upscale: via });
      if (thumbOf && splashCount.current < 14) {
        splashCount.current++;
        setSplash((p) => [...p, { path, thumb: thumbOf }]);
      } else if (!thumbOf) {
        setSplash((p) => [...p, { path, thumb: canvas.toDataURL() }]);
      }
    };
    const splashCount = { current: 0 };
    for (let i = 0; i < list.length; i++) {
      const { box, variant } = list[i];
      const img = st.images.find((m) => m.id === box.imageId);
      if (!img) continue;
      setActiveCut({ boxId: box.id, variantId: variant.id });
      const multi = st.variants.filter((v) => v.boxId === box.id).length > 1;
      const dir = ancestorPath(box, st.boxes, st.groups).map(safe);
      const mb = resolveMaskBase(box, st.boxes, st.variants);
      const cells = !variant.mask?.enabled && slicerCells(variant.rect, variant.crop, box.slicer);
      if (cells && cells.length) {
        const base = [...dir, safe(box.name), ...(multi ? [safe(variant.name)] : [])];
        for (const c of cells.slice(0, 400)) {
          const canvas = await renderSlicerCell({ imageUrl: img.url, cellRect: c.rect, variant, scale: st.exportScale });
          const small = c.row + c.col < 3 || splashCount.current < 6
            ? (await renderSlicerCell({ imageUrl: img.url, cellRect: c.rect, variant, scale: 0.3 })).toDataURL() : null;
          await storeCell(canvas, [...base, `r${c.row + 1}c${c.col + 1}.png`].join('/'), small,
            { box: box.name, variant: variant.name, image: img.name, path: [...dir, box.name].join('/'), kind: 'slicer-cell',
              row: c.row + 1, col: c.col + 1, x: r2(c.rect.x), y: r2(c.rect.y), w: r2(c.rect.w), h: r2(c.rect.h),
              ...(variant.pad?.auto ? { autoPad: true } : {}) }, effOf(variant));
        }
      } else {
        const file = multi ? `${safe(box.name)}/${safe(variant.name)}.png`
          : variant.mask?.enabled ? `${safe(box.name)}-mask.png` : `${safe(box.name)}.png`;
        const path = [...dir, file].join('/');
        try {
          const mini = await renderCut({ imageUrl: img.url, box: { rect: variant.rect }, design: variant, imageStyle: img.style, maskBase: mb, scale: 0.35, imageId: img.id });
          setSplash((p) => [...p, { path, thumb: mini.toDataURL() }]);
        } catch { /* thumb optional */ }
        const canvas = await renderCut({ imageUrl: img.url, box: { rect: variant.rect }, design: variant, imageStyle: img.style, maskBase: mb, scale: st.exportScale, imageId: img.id });
        const isM = !!variant.mask?.enabled;
        const baseR = mb?.rect || { x: 0, y: 0, w: img.w, h: img.h };
        await storeCell(canvas, path, null,
          { box: box.name, variant: variant.name, image: img.name, path: dir.join('/'), kind: isM ? 'mask' : 'cut',
            x: r2(isM ? baseR.x : variant.rect.x), y: r2(isM ? baseR.y : variant.rect.y),
            w: r2(isM ? baseR.w : variant.rect.w), h: r2(isM ? baseR.h : variant.rect.h),
            ...(isM ? { hole: { x: r2(variant.rect.x), y: r2(variant.rect.y), w: r2(variant.rect.w), h: r2(variant.rect.h) } } : {}),
            ...(variant.pad?.auto && !isM ? { autoPad: true } : {}) }, (isM && variant.isolate?.upscaleMask) ? 'canvas' : effOf(variant));
      }
      await new Promise((r) => setTimeout(r, 300)); // fly-across beat
    }
    setActiveCut(null);
    zip.file('clipper-manifest.json', JSON.stringify({
      app: 'clipper', version: 1, exportedAt: new Date().toISOString(),
      scope: exportScope, exportScale: st.exportScale,
      images: st.images.map((m) => ({ name: m.name, w: m.w, h: m.h })),
      files: manifest,
    }, null, 2));
    const out = await zip.generateAsync({ type: 'blob' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(out);
    a.download = 'clipper-export.zip';
    a.click();
    setExporting(false); setDone(true);
  }, [jobs, exportScope]);

  const focusBg = bgStyle(previewBg, previewCustom);
  const selPath = selBox ? [...ancestorPath(selBox, s.boxes, s.groups), selBox.name].join(' / ') : '';
  const selMaskBase = useMemo(() => selBox ? resolveMaskBase(selBox, s.boxes, s.variants) : null, [selBox, s.boxes, s.variants]);
  const selCells = selBox?.slicer?.enabled && selVariant ? slicerCells(selVariant.rect, selVariant.crop, selBox.slicer) : null;
  // focus preview resolves exactly like export: lens override > variant custom > global
  const effPreviewModel = previewModel === 'auto'
    ? (selVariant?.upscale && selVariant.upscale !== 'auto' ? selVariant.upscale : s.upscaleModel)
    : previewModel;

  return (
    <TweakCtx.Provider value={tweakApi}>
    <div className="h-full flex flex-col no-select">
      <style>{`@keyframes pop { 0% { transform: scale(.4); opacity: 0; } 60% { transform: scale(1.08); opacity: 1; } 100% { transform: scale(1); opacity: 1; } }
      .pop { animation: pop .38s ease-out both; }
      @keyframes pulsebox { 0%,100% { box-shadow: 0 0 0 3px rgba(59,130,246,.55);} 50% { box-shadow: 0 0 0 7px rgba(59,130,246,.18);} }
      .pulsebox { animation: pulsebox 1s ease-in-out infinite; }`}</style>

      {/* top bar */}
      <header className="h-12 flex items-center gap-1.5 px-3 border-b border-zinc-200 bg-white shrink-0">
        <div className="w-6 h-6 rounded-lg bg-zinc-900 text-white grid place-items-center mr-1"><Scan size={14} /></div>
        <button onClick={() => fileRef.current?.click()} title="Add images"
          className="flex items-center gap-1.5 text-xs font-medium px-2.5 py-1.5 rounded-lg hover:bg-zinc-100">
          <ImagePlus size={15} /> <span className="hidden sm:inline">Add</span>
        </button>
        <input ref={fileRef} type="file" accept="image/*" multiple className="hidden"
          onChange={(e) => e.target.files?.length && s.addImages([...e.target.files])} />
        <span className="text-[11px] text-zinc-400 hidden md:inline">drop / paste images anywhere</span>
        <div className="flex-1" />
        <div className="flex bg-zinc-100 rounded-lg p-0.5">
          {[
            { id: 'board', icon: <Layers size={14} />, t: 'Board (1)' },
            { id: 'focus', icon: <Focus size={14} />, t: 'Focus (2)' },
            { id: 'all', icon: <LayoutGrid size={14} />, t: 'All cuts (3)' },
          ].map((m) => (
            <button key={m.id} title={m.t} onClick={() => s.setMode(m.id)}
              className={`p-1.5 rounded-md ${s.mode === m.id ? 'bg-white shadow-sm text-zinc-900' : 'text-zinc-400'}`}>{m.icon}</button>
          ))}
        </div>
        <button onClick={() => s.undo()} title="Undo (Ctrl+Z)" disabled={!s.past.length}
          className="p-2 rounded-lg hover:bg-zinc-100 disabled:opacity-30"><Undo2 size={15} /></button>
        <button onClick={() => s.redo()} title="Redo (Ctrl+Shift+Z)" disabled={!s.future.length}
          className="p-2 rounded-lg hover:bg-zinc-100 disabled:opacity-30"><Redo2 size={15} /></button>
        <button onClick={() => { setSplash([]); setDone(false); s.setExportOpen(true); }} title="Export zip"
          className="flex items-center gap-1.5 text-xs font-semibold bg-zinc-900 text-white px-3 py-1.5 rounded-lg hover:bg-zinc-700">
          <Download size={14} /> Export</button>
      </header>

      <div className="flex-1 flex min-h-0">
        <LayersPanel />

        {/* board / previews */}
        {s.mode === 'board' && (
          <div ref={boardRef} className="flex-1 relative overflow-hidden bg-[#fafafa]"
            style={{ backgroundImage: 'radial-gradient(#e4e4e7 1px, transparent 1px)', backgroundSize: '20px 20px' }}
            onMouseDown={(e) => {
              // middle-mouse pans only — never selects or drags anything
              if (e.button === 1) {
                e.preventDefault();
                const cam = useStore.getState().cam;
                setDrag({ kind: 'pan', start: { x: e.clientX - cam.x, y: e.clientY - cam.y }, pushed: true });
              } else if (e.button === 0 && e.target === e.currentTarget) {
                e.preventDefault();
                const cam = useStore.getState().cam;
                setDrag({ kind: 'pan', start: { x: e.clientX - cam.x, y: e.clientY - cam.y }, pushed: true });
                s.setSel({ boxId: null, variantId: null, imageId: null, multi: [] });
              }
            }}
            onMouseMove={(e) => {
              const st = useStore.getState();
              if (drawRef.current) {
                const d = drawRef.current;
                const img = st.images.find((m) => m.id === d.imageId);
                if (img) {
                  const r = boardRef.current.getBoundingClientRect();
                  const ds = dispScale(img);
                  const cx = (e.clientX - r.left - st.cam.x) / st.cam.zoom, cy = (e.clientY - r.top - st.cam.y) / st.cam.zoom;
                  const raw = { x: (cx - img.x) / ds, y: (cy - img.y - HEADER) / ds };
                  const useSnapD = snapOn && !e.altKey;
                  const sn = useSnapD ? snapPoint(raw, guideCandidates(img.w, img.h, siblingRects(img.id, null)), snapT(img)) : { x: raw.x, y: raw.y, guides: [] };
                  setGuides(useSnapD ? { imageId: img.id, list: sn.guides } : { imageId: null, list: [] });
                  const nd = { ...d, curX: sn.x, curY: sn.y };
                  drawRef.current = nd; setDraw(nd);
                  paintLoupe(e.clientX, e.clientY, img, { x: sn.x, y: sn.y });
                }
                return;
              }
              if (!drag) return;
              if (drag.kind === 'pan' && drag.start) {
                st.setCam({ ...st.cam, x: e.clientX - drag.start.x, y: e.clientY - drag.start.y });
                return;
              }
              if (drag.kind === 'img') {
                const dd = ensurePushed(drag);
                if (dd !== drag) setDrag(dd);
                const r = boardRef.current.getBoundingClientRect();
                st.moveImage(drag.id, (e.clientX - r.left - st.cam.x) / st.cam.zoom + drag.offX,
                  (e.clientY - r.top - st.cam.y) / st.cam.zoom + drag.offY);
                return;
              }
              if (drag.kind === 'boxmove') {
                const dd = ensurePushed(drag);
                if (dd !== drag) setDrag(dd);
                const img = st.images.find((m) => m.id === drag.imageId);
                const r = boardRef.current.getBoundingClientRect();
                const px = (e.clientX - r.left - st.cam.x) / st.cam.zoom, py = (e.clientY - r.top - st.cam.y) / st.cam.zoom;
                const ds = dispScale(img);
                const rawMove = { ...drag.startRect, x: (px - img.x) / ds + drag.offX, y: (py - img.y - HEADER) / ds + drag.offY };
                const useSnapM = snapOn && !e.altKey;
                const snMove = useSnapM ? snapMoveRect(rawMove, guideCandidates(img.w, img.h, siblingRects(img.id, drag.variantId)), snapT(img)) : { rect: rawMove, guides: [] };
                setGuides(useSnapM ? { imageId: img.id, list: snMove.guides } : { imageId: null, list: [] });
                st.setVariantRectLive(drag.boxId, drag.variantId, snMove.rect);
                paintLoupe(e.clientX, e.clientY, img, { x: snMove.rect.x + snMove.rect.w / 2, y: snMove.rect.y + snMove.rect.h / 2 });
                return;
              }
              if (drag.kind === 'boxresize') {
                const dd = ensurePushed(drag);
                if (dd !== drag) setDrag(dd);
                const img = st.images.find((m) => m.id === drag.imageId);
                const r = boardRef.current.getBoundingClientRect();
                const px = (e.clientX - r.left - st.cam.x) / st.cam.zoom, py = (e.clientY - r.top - st.cam.y) / st.cam.zoom;
                const ds = dispScale(img);
                const rawPt = { x: (px - img.x) / ds, y: (py - img.y - HEADER) / ds };
                const useSnapR = snapOn && !e.altKey;
                const snPt = useSnapR ? snapPoint(rawPt, guideCandidates(img.w, img.h, siblingRects(img.id, drag.variantId)), snapT(img)) : { x: rawPt.x, y: rawPt.y, guides: [] };
                setGuides(useSnapR ? { imageId: img.id, list: snPt.guides } : { imageId: null, list: [] });
                const cur = { x: snPt.x, y: snPt.y };
                const newRect = applyResize(drag.startRect, cur.x - drag.startPt.x, cur.y - drag.startPt.y, drag.dir, img);
                st.setVariantRectLive(drag.boxId, drag.variantId, newRect);
                // loupe tracks the moving corner/edge itself, not the cursor (grab-offset aware)
                paintLoupe(e.clientX, e.clientY, img, {
                  x: drag.dir.dx === 1 ? newRect.x + newRect.w : drag.dir.dx === -1 ? newRect.x : newRect.x + newRect.w / 2,
                  y: drag.dir.dy === 1 ? newRect.y + newRect.h : drag.dir.dy === -1 ? newRect.y : newRect.y + newRect.h / 2,
                });
              }
            }}
            onMouseUp={endDraw}
            onDragOver={(e) => e.preventDefault()}
            onDrop={(e) => {
              e.preventDefault();
              const files = [...(e.dataTransfer?.files || [])].filter((f) => f.type.startsWith('image/'));
              if (files.length) s.addImages(files);
            }}>
            <div className="absolute top-0 left-0" style={{ transform: `translate(${s.cam.x}px,${s.cam.y}px) scale(${s.cam.zoom})`, transformOrigin: '0 0' }}>
              {s.images.map((img) => {
                const ds = dispScale(img);
                const dw = img.w * ds, dh = img.h * ds;
                const shownBox = s.boxes.find((b) => b.imageId === img.id && b.id === s.sel.boxId);
                const shownVariant = shownBox
                  ? s.variants.find((v) => v.id === s.sel.variantId) || s.variants.find((v) => v.boxId === shownBox.id)
                  : null;
                const grid = shownBox?.slicer?.enabled && shownVariant
                  ? slicerCells(shownVariant.rect, shownVariant.crop, shownBox.slicer) : null;
                return (
                  <div key={img.id} className="absolute bg-white rounded-t-xl shadow-sm border-2 border-zinc-200 overflow-visible"
                    style={{ left: img.x, top: img.y, width: dw || 320, height: (dh || 200) + HEADER, boxSizing: 'content-box',
                      borderColor: s.sel.imageId === img.id ? '#3b82f6' : undefined,
                      boxShadow: [
                        s.sel.imageId === img.id ? '0 0 0 3px rgba(59,130,246,.25)' : null,
                        img.style?.shadow?.enabled ? cssBoxShadow(img.style.shadow, ds) : null,
                      ].filter(Boolean).join(', ') || undefined }}
                    onMouseDown={(e) => {
                      if (e.button !== 0) return;
                      if (useStore.getState().tool !== 'select') return;
                      if (e.target.closest('[data-box]')) return;
                      useStore.getState().setSel({ boxId: null, variantId: null, imageId: img.id });
                      const r = boardRef.current.getBoundingClientRect();
                      const cam = useStore.getState().cam;
                      const px = (e.clientX - r.left - cam.x) / cam.zoom, py = (e.clientY - r.top - cam.y) / cam.zoom;
                      setDrag({ kind: 'img', id: img.id, offX: img.x - px, offY: img.y - py, pushed: false });
                    }}>
                    <div className="flex items-center px-2.5 gap-2 cursor-grab" style={{ height: HEADER }}>
                      <span className="text-[11px] font-medium text-zinc-600 truncate">{img.name}</span>
                      <span className="text-[10px] text-zinc-300 font-mono">{img.w ? `${img.w}×${img.h}` : '…'}</span>
                      <div className="flex-1" />
                      <button className="text-zinc-300 hover:text-red-500" onClick={() => s.removeImage(img.id)}><X size={12} /></button>
                    </div>
                    <div className="relative" style={{ width: dw, height: dh }}
                      onMouseDown={(e) => {
                        if (e.button !== 0) return;
                        const st = useStore.getState();
                        if (st.tool !== 'select') { startDraw(e, img); return; }
                        const pt = imgPt(e, img);
                        const hit = hitVariant(pt, img.id);
                        if (hit) {
                          e.stopPropagation();
                          if (e.shiftKey) {
                            // multi-select toggle (primary stays)
                            if (!st.sel.boxId) {
                              st.setSel({ boxId: hit.box.id, variantId: hit.variant.id, imageId: null, multi: [] });
                            } else if (st.sel.boxId !== hit.box.id) {
                              const cur = st.sel.multi || [];
                              st.setSel({ boxId: st.sel.boxId, variantId: st.sel.variantId, imageId: null,
                                multi: cur.includes(hit.box.id) ? cur.filter((id) => id !== hit.box.id) : [...cur, hit.box.id] });
                            }
                            return;
                          }
                          st.setSel({ boxId: hit.box.id, variantId: hit.variant.id, imageId: null, multi: [] });
                          beginVariantMove(e, hit.box, hit.variant, img);
                        }
                        // miss: bubble to image-move
                      }}>
                      <img data-img={img.id} src={img.url} draggable={false}
                        className="absolute inset-0 w-full h-full block" alt=""
                        style={{
                          boxShadow: (img.style?.border?.w || 0) > 0 ? `inset 0 0 0 ${Math.max(1, img.style.border.w * ds)}px ${img.style.border.color}` : undefined,
                          filter: cssFilterString(img.style?.adjust),
                        }} />
                      {/* snap guides */}
                      {guides.imageId === img.id && guides.list.length > 0 && (
                        <div className="absolute inset-0 pointer-events-none z-10">
                          {guides.list.map((g, i) => g.o === 'v'
                            ? <div key={i} className="absolute top-0 bottom-0 w-px bg-rose-500" style={{ left: g.pos * ds }} />
                            : <div key={i} className="absolute left-0 right-0 h-px bg-rose-500" style={{ top: g.pos * ds }} />)}
                        </div>
                      )}
                      {/* only the selection renders bounds — overlap handled in layers */}
                      {shownBox && shownVariant && (
                        <div data-box
                          onMouseDown={(e) => {
                            if (e.button !== 0) return;
                            if (useStore.getState().tool !== 'select') return;
                            e.stopPropagation();
                            beginVariantMove(e, shownBox, shownVariant, img);
                          }}
                          className="absolute border-2 rounded-[2px] border-blue-500"
                          style={{
                            left: shownVariant.rect.x * ds, top: shownVariant.rect.y * ds,
                            width: shownVariant.rect.w * ds, height: shownVariant.rect.h * ds,
                            boxShadow: '0 0 0 3px rgba(59,130,246,.25)',
                            pointerEvents: s.tool === 'select' ? 'auto' : 'none',
                          }}>
                          <div className="absolute inset-0 pointer-events-none" style={{
                            borderRadius: Math.min(60, shownVariant.radius * ds),
                            border: shownVariant.border.w > 0 ? `${Math.max(1, shownVariant.border.w * ds)}px solid ${shownVariant.border.color}` : 'none',
                            background: shownVariant.mask?.enabled
                              ? 'repeating-linear-gradient(45deg, rgba(59,130,246,.28) 0 8px, rgba(59,130,246,.06) 8px 16px)'
                              : 'rgba(59,130,246,0.07)',
                            filter: cssFilterString(shownVariant.adjust),
                            boxShadow: shownVariant.shadow.enabled ? cssBoxShadow(shownVariant.shadow, ds) : 'none',
                          }} />
                          {shownVariant.feather > 0 && !shownVariant.mask?.enabled && (
                            <div className="absolute pointer-events-none border border-dashed border-blue-400/80 rounded-[2px]"
                              title={`Feather falloff ~${shownVariant.feather}px — check Focus for the real edge`}
                              style={{ inset: Math.min(80, shownVariant.feather * ds) }} />
                          )}
                          {/* slicer grid preview — clipped to the box, can never spill out */}
                          {grid && (
                            <div className="absolute inset-0 overflow-hidden pointer-events-none rounded-[2px]">
                              {grid.map((c, i) => (
                                <div key={i} className="absolute border border-white/90 bg-blue-500/10"
                                  style={{
                                    left: (c.rect.x - shownVariant.rect.x) * ds, top: (c.rect.y - shownVariant.rect.y) * ds,
                                    width: c.rect.w * ds, height: c.rect.h * ds,
                                  }} />
                              ))}
                            </div>
                          )}
                          <span className="absolute -top-5 left-0 text-[10px] px-1.5 py-px rounded-md font-medium whitespace-nowrap flex items-center gap-1 bg-blue-500 text-white"
                            style={{ pointerEvents: 'auto' }}>
                            {shownBox.name}/{shownVariant.name}{shownVariant.mask?.enabled ? ' ◐' : ''}{grid ? ` · ${grid.length}` : ''}
                            <span className="opacity-70" title="w × h @ x, y (source px)">{` · ${Math.round(shownVariant.rect.w)}×${Math.round(shownVariant.rect.h)} @ ${Math.round(shownVariant.rect.x)},${Math.round(shownVariant.rect.y)}`}</span>
                            {boxVariants.length > 1 && boxVariants.map((v) => (
                              <i key={v.id} title={v.name}
                                onMouseDown={(e) => { e.stopPropagation(); s.setSel({ boxId: shownBox.id, variantId: v.id }); }}
                                className={`w-1.5 h-1.5 rounded-full inline-block cursor-pointer ${v.id === shownVariant?.id ? 'bg-white' : 'bg-white/40 hover:bg-white/80'}`} />
                            ))}
                          </span>
                          {HANDLES.map((hh) => (
                            <span key={hh.id}
                              onMouseDown={(e) => {
                                if (e.button !== 0) return;
                                e.stopPropagation();
                                const pt = imgPt(e, img);
                                setDrag({ kind: 'boxresize', boxId: shownBox.id, variantId: shownVariant.id, imageId: img.id, pushed: false,
                                  dir: hh, startRect: { ...shownVariant.rect }, startPt: pt });
                              }}
                              className={`absolute w-2.5 h-2.5 bg-white border-2 border-blue-500 rounded-[3px] ${hh.cls}`}
                              style={{ cursor: hh.cur, pointerEvents: 'auto' }} />
                          ))}
                        </div>
                      )}
                      {/* multi-selection outlines (primary above has handles) */}
                      {(s.sel.multi || []).filter((id) => id !== s.sel.boxId).map((id) => {
                        const mb2 = s.boxes.find((x) => x.id === id && x.imageId === img.id);
                        if (!mb2) return null;
                        const mv = s.variants.find((x) => x.boxId === id);
                        if (!mv) return null;
                        return <div key={id} className="absolute border-2 border-violet-400 rounded-[2px] pointer-events-none"
                          style={{ left: mv.rect.x * ds, top: mv.rect.y * ds, width: mv.rect.w * ds, height: mv.rect.h * ds }} />;
                      })}
                      {draw?.imageId === img.id && (
                        <div className="absolute border-2 border-blue-500 bg-blue-500/10 pointer-events-none"
                          style={{
                            left: Math.min(draw.startX, draw.curX) * ds, top: Math.min(draw.startY, draw.curY) * ds,
                            width: Math.abs(draw.curX - draw.startX) * ds, height: Math.abs(draw.curY - draw.startY) * ds,
                          }} />
                      )}
                    </div>
                  </div>
                );
              })}
            </div>

            {/* centered empty state (outside the panned layer so it never drifts off) */}
            {!s.images.length && (
              <div className="absolute inset-0 grid place-items-center">
                <div className="bg-white border border-dashed border-zinc-300 rounded-2xl px-8 py-10 text-center w-[380px]">
                  <ImagePlus size={22} className="mx-auto text-zinc-300 mb-2" />
                  <p className="text-sm font-medium">Paste or drop images</p>
                  <p className="text-xs text-zinc-400 mt-1">draw boxes → style → export zip</p>
                  <button onClick={() => fileRef.current?.click()}
                    className="mt-4 text-xs font-semibold bg-zinc-900 text-white px-4 py-2 rounded-lg">Browse files</button>
                </div>
              </div>
            )}

            {/* align + distribute bar for multi-selection */}
            {(s.sel.multi || []).length > 0 && s.sel.boxId && (
              <div className="absolute bottom-[74px] left-1/2 -translate-x-1/2 z-10 flex items-center gap-0.5 bg-white border border-zinc-200 rounded-2xl shadow-lg p-1">
                {[
                  ['left', <AlignLeft size={15} />, 'Align left'], ['centerX', <AlignCenterHorizontal size={15} />, 'Align center H'],
                  ['right', <AlignRight size={15} />, 'Align right'], ['top', <AlignStartVertical size={15} />, 'Align top'],
                  ['centerY', <AlignCenterVertical size={15} />, 'Align center V'], ['bottom', <AlignEndVertical size={15} />, 'Align bottom'],
                  ['distH', <MoveHorizontal size={15} />, 'Distribute horizontally'], ['distV', <MoveVertical size={15} />, 'Distribute vertically'],
                ].map(([mode, icon, t]) => (
                  <button key={mode} title={t} onClick={() => s.alignBoxes([s.sel.boxId, ...(s.sel.multi || [])], mode)}
                    className="p-2 rounded-xl text-zinc-500 hover:bg-zinc-100">{icon}</button>
                ))}
                <span className="text-[10px] text-zinc-300 font-mono px-1">{1 + (s.sel.multi || []).length}</span>
              </div>
            )}
            {/* drawing loupe: crisp pixel zoom at the cursor */}
            <div ref={loupeRef} className="fixed z-20 pointer-events-none" style={{ display: 'none' }}>
              <canvas ref={loupeCanvasRef} width={132} height={132} className="rounded-xl shadow-2xl border-2 border-blue-500 bg-white" style={{ imageRendering: 'pixelated' }} />
              <div><span ref={loupeLabelRef} className="text-[10px] font-mono text-white bg-zinc-900/90 rounded-md px-1.5 py-0.5 mt-1 inline-block" /></div>
            </div>
            {/* bottom-center tools */}
            <div className="absolute bottom-4 left-1/2 -translate-x-1/2 z-10 flex items-center gap-0.5 bg-white border border-zinc-200 rounded-2xl shadow-lg p-1">
              {[
                { id: 'select', icon: <MousePointer2 size={16} />, t: 'Select (V)' },
                { id: 'box', icon: <BoxSelect size={16} />, t: 'Box (B)' },
              ].map((t) => (
                <button key={t.id} title={t.t} onClick={() => s.setTool(t.id)}
                  className={`p-2.5 rounded-xl ${s.tool === t.id ? 'bg-zinc-900 text-white' : 'text-zinc-500 hover:bg-zinc-100'}`}>{t.icon}</button>
              ))}
              <div className="w-px h-6 bg-zinc-200 mx-0.5" />
              <button title={snapOn ? 'Snapping on (hold Alt to bypass)' : 'Snapping off'} onClick={() => setSnapOn(!snapOn)}
                className={`p-2.5 rounded-xl ${snapOn ? 'text-zinc-900 bg-zinc-100' : 'text-zinc-300 hover:bg-zinc-100'}`}><Magnet size={16} /></button>
            </div>
          </div>
        )}

        {s.mode === 'focus' && (
          <div className="flex-1 overflow-auto p-8">
            {!selBox ? <p className="text-sm text-zinc-400 text-center mt-20">Select a box in layers, or press 1 and click one</p> : (
              <div className="max-w-3xl mx-auto">
                <div className="flex items-center gap-2 mb-4">
                  <span className="text-sm font-semibold">{selBox.name}</span>
                  {isLinkedVariant && <span className="text-[11px] bg-blue-50 text-blue-600 px-2 py-0.5 rounded-full">linked</span>}
                  <div className="flex-1" />
                  <BgSwitch bg={previewBg} setBg={setPreviewBg} custom={previewCustom} setCustom={setPreviewCustom} />
                  <select value={previewModel} onChange={(e) => setPreviewModel(e.target.value)} title="Preview upscale (lens only — export uses variant/global setting)"
                    className="text-xs border border-zinc-200 rounded-lg px-1.5 py-1 bg-white">
                    <option value="auto">Lens: auto</option>
                    {UPSCALE_MODELS.map((m) => <option key={m.id} value={m.id}>{m.label}</option>)}
                  </select>
                  {boxVariants.map((v) => (
                    <button key={v.id} onClick={() => s.setSel({ boxId: selBox.id, variantId: v.id })}
                      className={`text-xs px-2.5 py-1 rounded-lg ${v.id === selVariant?.id ? 'bg-zinc-900 text-white' : 'bg-zinc-100'}`}>{v.name}</button>
                  ))}
                </div>
                <FocusViewer bgClass={focusBg.className} bgStyle={focusBg.style}
                  badge={`${selBox.id}:${selVariant?.id}:${effPreviewModel}:${selCells?.length || 0}`}>
                  {selCells?.length ? (
                    <>
                      <div className="grid gap-3" style={{ gridTemplateColumns: `repeat(${selBox.slicer.cols}, minmax(0,1fr))` }}>
                        {selCells.slice(0, 60).map((c, i) => (
                          <div key={i} className="grid place-items-center">
                            <CellThumb image={selImage} cellRect={c.rect} variant={selVariant} className="block" />
                          </div>
                        ))}
                      </div>
                      {selCells.length > 60 && <p className="text-[11px] text-zinc-400 mt-2 text-center">+{selCells.length - 60} more in export</p>}
                    </>
                  ) : selImage && selVariant ? (
                    <HiResCut image={selImage} box={selBox} variant={selVariant} maskBase={selMaskBase}
                      model={effPreviewModel} exportScale={s.exportScale} className="block" />
                  ) : null}
                </FocusViewer>
                <p className="text-[11px] text-zinc-400 mt-3 text-center">no source image · Esc deselects</p>
              </div>
            )}
          </div>
        )}

        {s.mode === 'all' && (
          <div className="flex-1 overflow-auto p-6 relative">
            <div className="flex items-center gap-2 mb-3">
              <span className="text-xs text-zinc-400">{jobs.length} cuts · click one to focus</span>
              <div className="flex-1" />
              <BgSwitch bg={previewBg} setBg={setPreviewBg} custom={previewCustom} setCustom={setPreviewCustom} />
            </div>
            <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-4">
              {s.boxes.flatMap((b) => {
                const img = s.images.find((m) => m.id === b.imageId);
                if (!img) return [];
                return s.variants.filter((v) => v.boxId === b.id).flatMap((v) => {
                  const cells = slicerCells(v.rect, v.crop, b.slicer);
                  if (cells?.length) {
                    return cells.slice(0, 30).map((c, i) => (
                      <button key={`${v.id}-${i}`} onClick={() => { s.setSel({ boxId: b.id, variantId: v.id, imageId: null }); s.setMode('focus'); }}
                        className={`rounded-xl border border-zinc-200 p-4 grid place-items-center min-h-[140px] hover:border-blue-400 relative ${focusBg.className}`} style={focusBg.style}>
                        <CellThumb image={img} cellRect={c.rect} variant={v} className="max-w-full max-h-[120px] rounded-md" />
                        <span className="absolute bottom-1.5 left-2 text-[10px] font-mono bg-white/90 px-1.5 rounded">{b.name}/{v.name}/r{c.row + 1}c{c.col + 1}</span>
                      </button>
                    ));
                  }
                  return [(
                    <button key={v.id} onClick={() => { s.setSel({ boxId: b.id, variantId: v.id, imageId: null }); s.setMode('focus'); }}
                      className={`rounded-xl border border-zinc-200 p-4 grid place-items-center min-h-[140px] hover:border-blue-400 relative ${focusBg.className}`} style={focusBg.style}>
                      <CutThumb image={img} box={b} variant={v} maskBase={resolveMaskBase(b, s.boxes, s.variants)} className="max-w-full max-h-[120px] rounded-lg" />
                      <span className="absolute bottom-1.5 left-2 text-[10px] font-mono bg-white/90 px-1.5 rounded">{b.name}/{v.name}</span>
                    </button>
                  )];
                });
              })}
            </div>
            {!s.boxes.length && <p className="text-sm text-zinc-400 text-center mt-20">No cuts yet</p>}
          </div>
        )}

        {/* right panel — only when a box is selected */}
        {selBox && selVariant && s.mode === 'board' && (
          <aside className="w-64 border-l border-zinc-200 bg-white overflow-y-auto shrink-0 p-3">
            <div className="flex items-center gap-1.5 mb-1">
              <input value={selBox.name} onChange={(e) => s.renameBox(selBox.id, e.target.value)}
                className="text-sm font-semibold bg-transparent border-b border-transparent hover:border-zinc-200 focus:border-blue-400 outline-none flex-1 min-w-0" />
              {isLinkedVariant && <span className="text-[10px] bg-blue-50 text-blue-600 px-1.5 py-0.5 rounded-md font-semibold">LINKED</span>}
            </div>
            {selPath && <p className="text-[10px] font-mono text-zinc-400 mb-2 truncate" title={selPath}>{selPath}</p>}
            <div className="flex gap-1 mb-2">
              <button onClick={() => s.addVariant(selBox.id)} title="New linked variant (Ctrl+D)"
                className="flex-1 text-[11px] font-medium py-1.5 rounded-lg bg-zinc-100 hover:bg-zinc-200 flex items-center justify-center gap-1">
                <Plus size={12} /> Variant</button>
              <button onClick={() => s.deleteBox(selBox.id)} title="Delete box"
                className="p-1.5 rounded-lg hover:bg-red-50 text-zinc-400 hover:text-red-500"><Trash2 size={13} /></button>
            </div>
            <div className="flex gap-1 flex-wrap mb-1">
              {boxVariants.map((v) => (
                <span key={v.id} className={`group/vtab flex items-center text-[11px] rounded-lg ${v.id === selVariant.id ? 'bg-zinc-900 text-white' : 'bg-zinc-100'}`}>
                  <button onClick={() => s.setSel({ boxId: selBox.id, variantId: v.id })}
                    onDoubleClick={() => { const n = prompt('Variant name', v.name); if (n?.trim()) s.renameVariant(v.id, n.trim()); }}
                    title="Double-click to rename"
                    className="px-2 py-1">{v.name}</button>
                  {boxVariants.length > 1 && (
                    <button onClick={() => s.deleteVariant(selBox.id, v.id)} title="Delete variant"
                      className="hidden group-hover/vtab:block pr-1 opacity-60 hover:opacity-100"><X size={11} /></button>
                  )}
                </span>
              ))}
            </div>
            <p className="text-[10px] text-zinc-400 mb-1">variants export as folder · arrows nudge</p>

            <Row label="Rect" linked={isLinkedVariant ? selVariant.links?.rect : undefined}
              onToggleLink={isLinkedVariant ? () => s.toggleLink(selVariant.id, 'rect') : null}
              locked={isLinkedVariant && selVariant.links?.rect}
              onReset={() => resetGroup('rect')}>
              <div className="grid grid-cols-4 gap-1">
                {['x', 'y', 'w', 'h'].map((k) => (
                  <label key={k} className="text-[10px] text-zinc-400">{k}
                    <Num value={selVariant.rect[k]} min={0}
                      onChange={(v) => s.updateVariantRect(selBox.id, selVariant.id, { ...selVariant.rect, [k]: v })} width="w-full" /></label>
                ))}
              </div>
            </Row>

            {/* Slicer — box-level grid cutter, cells inherit this variant's style */}
            <div className="py-2 border-b border-zinc-100">
              <div className="flex items-center justify-between mb-1">
                <span
                  onDoubleClick={() => s.updateSlicer(selBox.id, { ...defaultSlicer(), enabled: selBox.slicer.enabled })}
                  title="Double-click to reset"
                  className="text-[11px] font-medium text-zinc-500 uppercase tracking-wide cursor-pointer hover:text-zinc-800">Slicer</span>
                <div className="flex items-center gap-0.5">
                  <VarPlus group="slicer"
                    getValue={() => ({ rows: selBox.slicer.rows, cols: selBox.slicer.cols, rowGap: selBox.slicer.rowGap, colGap: selBox.slicer.colGap })}
                    onApply={(v) => s.updateSlicer(selBox.id, v)}
                    menuOpen={varMenu} setMenuOpen={setVarMenu} />
                  <button onClick={() => s.updateSlicer(selBox.id, { enabled: !selBox.slicer.enabled })}
                    className={`text-[11px] font-semibold px-2.5 py-1 rounded-full ${selBox.slicer.enabled ? 'bg-emerald-500 text-white' : 'bg-zinc-100 text-zinc-400'}`}>
                    {selBox.slicer.enabled ? 'on' : 'off'}</button>
                </div>
              </div>
              {selBox.slicer.enabled && (
                <>
                  <div className="grid grid-cols-4 gap-1">
                    <label className="text-[10px] text-zinc-400">rows<Num value={selBox.slicer.rows} min={1} max={24}
                      onChange={(v) => s.updateSlicer(selBox.id, { rows: v })} width="w-full" /></label>
                    <label className="text-[10px] text-zinc-400">cols<Num value={selBox.slicer.cols} min={1} max={24}
                      onChange={(v) => s.updateSlicer(selBox.id, { cols: v })} width="w-full" /></label>
                    <label className="text-[10px] text-zinc-400">rgap<Num value={selBox.slicer.rowGap} min={0}
                      onChange={(v) => s.updateSlicer(selBox.id, { rowGap: v })} width="w-full" /></label>
                    <label className="text-[10px] text-zinc-400">cgap<Num value={selBox.slicer.colGap} min={0}
                      onChange={(v) => s.updateSlicer(selBox.id, { colGap: v })} width="w-full" /></label>
                  </div>
                  <p className="text-[10px] text-zinc-400 mt-1">cells use {selVariant.name}'s style · {selCells?.length || 0} cuts</p>
                </>
              )}
            </div>

            {/* Mask — invert: full image with a cutout where the box is */}
            <Row label="Mask" linked={isLinkedVariant ? selVariant.links?.mask : undefined}
              onToggleLink={isLinkedVariant ? () => s.toggleLink(selVariant.id, 'mask') : null}
              locked={isLinkedVariant && selVariant.links?.mask}
              onReset={() => resetGroup('mask')} {...vp('mask')}>
              <label className="flex items-center gap-2 text-xs mb-1">
                <input type="checkbox" checked={!!selVariant.mask?.enabled}
                  onChange={(e) => s.updateVariant(selVariant.id, 'mask', { ...(selVariant.mask || {}), enabled: e.target.checked })} /> use as mask</label>
              {selVariant.mask?.enabled && (
                <>
                  <label className="flex items-center gap-2 text-xs mb-1">
                    <input type="checkbox" checked={!!selVariant.mask?.fill}
                      onChange={(e) => s.updateVariant(selVariant.id, 'mask', { ...(selVariant.mask || {}), fill: e.target.checked ? '#ffffff' : null })} /> fill hole</label>
                  {selVariant.mask?.fill && (
                    <input type="color" value={selVariant.mask.fill}
                      onChange={(e) => s.updateVariant(selVariant.id, 'mask', { ...(selVariant.mask || {}), fill: e.target.value })}
                      className="w-8 h-7 rounded cursor-pointer" />
                  )}
                  <p className="text-[10px] text-zinc-400 mt-0.5">cuts the base (parent box, else full image) · overrides slicer</p>
                </>
              )}
            </Row>

            <Row label="Isolate" linked={isLinkedVariant ? selVariant.links?.isolate : undefined}
              onToggleLink={isLinkedVariant ? () => s.toggleLink(selVariant.id, 'isolate') : null}
              locked={isLinkedVariant && selVariant.links?.isolate}
              onReset={() => resetGroup('isolate')} {...vp('isolate')}>
              <label className="flex items-center gap-2 text-xs mb-1">
                <input type="checkbox" checked={!!selVariant.isolate?.enabled}
                  onChange={(e) => s.updateVariant(selVariant.id, 'isolate', { ...(selVariant.isolate || { model: 'u2netp' }), enabled: e.target.checked })} /> isolate subject</label>
              {selVariant.isolate?.enabled && (
                <>
                  <select value={selVariant.isolate.model || 'u2netp'}
                    onChange={(e) => s.updateVariant(selVariant.id, 'isolate', { ...selVariant.isolate, model: e.target.value })}
                    className="w-full text-xs border border-zinc-200 rounded-lg px-2 py-1.5 bg-white mb-1">
                    <option value="u2netp">U²-NetP (fast)</option>
                    <option value="silueta">Silueta (sharper)</option>
                  </select>
                  <label className="flex items-center gap-2 text-xs mb-1">
                    <input type="checkbox" checked={!!selVariant.isolate.upscaleMask}
                      onChange={(e) => s.updateVariant(selVariant.id, 'isolate', { ...selVariant.isolate, upscaleMask: e.target.checked })} /> upscale mask</label>
                  <p className="text-[10px] text-zinc-400 mt-0.5">
                    {selVariant.mask?.enabled ? 'hole is the subject silhouette' : 'keeps the subject, drops the rest'}
                    {selVariant.isolate.upscaleMask ? ' · upscales the box matte, not the full image' : ''}
                  </p>
                </>
              )}
            </Row>

            <Row label="Crop · first" linked={isLinkedVariant ? selVariant.links?.crop : undefined}
              onToggleLink={isLinkedVariant ? () => s.toggleLink(selVariant.id, 'crop') : null}
              locked={isLinkedVariant && selVariant.links?.crop}
              onReset={() => resetGroup('crop')} {...vp('crop')}>
              <div className="grid grid-cols-4 gap-1">
                {['t', 'r', 'b', 'l'].map((k) => (
                  <label key={k} className="text-[10px] text-zinc-400">{k}
                    <Num value={selVariant.crop[k]} onChange={(v) => s.updateVariant(selVariant.id, 'crop', { ...selVariant.crop, [k]: v })} width="w-full" /></label>
                ))}
              </div>
            </Row>

            <Row label="Radius" linked={isLinkedVariant ? selVariant.links?.radius : undefined}
              onToggleLink={isLinkedVariant ? () => s.toggleLink(selVariant.id, 'radius') : null}
              locked={isLinkedVariant && selVariant.links?.radius}
              onReset={() => resetGroup('radius')} {...vp('radius')}>
              <div className="flex items-center gap-2">
                <Slider value={selVariant.radius} min={0} max={120} step={1}
                  onChange={(v) => s.updateVariant(selVariant.id, 'radius', v)} />
                <Num value={selVariant.radius} onChange={(v) => s.updateVariant(selVariant.id, 'radius', v)} />
              </div>
            </Row>

            <Row label="Padding · transparent" linked={isLinkedVariant ? selVariant.links?.pad : undefined}
              onToggleLink={isLinkedVariant ? () => s.toggleLink(selVariant.id, 'pad') : null}
              locked={isLinkedVariant && selVariant.links?.pad}
              onReset={() => resetGroup('pad')} {...vp('pad')}>
              <div className="flex items-center gap-1.5 mb-1">
                <button onClick={() => s.updateVariant(selVariant.id, 'pad', { ...selVariant.pad, auto: !selVariant.pad?.auto })}
                  title="Auto: expand to full-image size, keeping x/y placement for AE stacking"
                  className={`text-[11px] font-semibold px-2.5 py-1 rounded-full ${selVariant.pad?.auto ? 'bg-emerald-500 text-white' : 'bg-zinc-100 text-zinc-400'}`}>
                  {selVariant.pad?.auto ? 'auto' : 'manual'}</button>
                {selVariant.pad?.auto && <span className="text-[10px] text-zinc-400">full-size export · placement kept</span>}
              </div>
              <div className={`grid grid-cols-4 gap-1 ${selVariant.pad?.auto ? 'opacity-40 pointer-events-none' : ''}`}>
                {['t', 'r', 'b', 'l'].map((k) => (
                  <label key={k} className="text-[10px] text-zinc-400">{k}
                    <Num value={selVariant.pad[k]} onChange={(v) => s.updateVariant(selVariant.id, 'pad', { ...selVariant.pad, [k]: v })} width="w-full" /></label>
                ))}
              </div>
            </Row>

            <Row label="Border" linked={isLinkedVariant ? selVariant.links?.border : undefined}
              onToggleLink={isLinkedVariant ? () => s.toggleLink(selVariant.id, 'border') : null}
              locked={isLinkedVariant && selVariant.links?.border}
              onReset={() => resetGroup('border')} {...vp('border')}>
              <div className="flex items-center gap-2">
                <Num value={selVariant.border.w} onChange={(v) => s.updateVariant(selVariant.id, 'border', { ...selVariant.border, w: v })} />
                <input type="color" value={selVariant.border.color}
                  onChange={(e) => s.updateVariant(selVariant.id, 'border', { ...selVariant.border, color: e.target.value })}
                  className="w-8 h-7 rounded cursor-pointer" />
              </div>
            </Row>

            <Row label="Shadow" linked={isLinkedVariant ? selVariant.links?.shadow : undefined}
              onToggleLink={isLinkedVariant ? () => s.toggleLink(selVariant.id, 'shadow') : null}
              locked={isLinkedVariant && selVariant.links?.shadow}
              onReset={() => resetGroup('shadow')} {...vp('shadow')}>
              <label className="flex items-center gap-2 text-xs mb-1">
                <input type="checkbox" checked={selVariant.shadow.enabled}
                  onChange={(e) => s.updateVariant(selVariant.id, 'shadow', { ...selVariant.shadow, enabled: e.target.checked })} /> on</label>
              {selVariant.shadow.enabled && (
                <ShadowControls shadow={selVariant.shadow}
                  onChange={(next) => s.updateVariant(selVariant.id, 'shadow', next)} />
              )}
            </Row>

            <Row label="Feather" linked={isLinkedVariant ? selVariant.links?.feather : undefined}
              onToggleLink={isLinkedVariant ? () => s.toggleLink(selVariant.id, 'feather') : null}
              locked={isLinkedVariant && selVariant.links?.feather}
              onReset={() => resetGroup('feather')} {...vp('feather')}>
              <div className="flex items-center gap-2">
                <Slider value={selVariant.feather} min={0} max={80} step={1}
                  onChange={(v) => s.updateVariant(selVariant.id, 'feather', v)} />
                <Num value={selVariant.feather} onChange={(v) => s.updateVariant(selVariant.id, 'feather', v)} />
              </div>
              <p className="text-[10px] text-zinc-400 mt-0.5">soft falloff to transparent at edges</p>
            </Row>

            <Row label="Adjust" linked={isLinkedVariant ? selVariant.links?.adjust : undefined}
              onToggleLink={isLinkedVariant ? () => s.toggleLink(selVariant.id, 'adjust') : null}
              locked={isLinkedVariant && selVariant.links?.adjust}
              onReset={() => resetGroup('adjust')} {...vp('adjust')}>
              {[['sat', 'Saturation'], ['bright', 'Value'], ['contrast', 'Contrast']].map(([k, lab]) => (
                <div key={k} className="mb-1">
                  <div className="flex justify-between text-[10px] text-zinc-400"><span>{lab}</span><span>{selVariant.adjust[k].toFixed(2)}</span></div>
                  <Slider value={selVariant.adjust[k]} min={0} max={2}
                    onChange={(v) => s.updateVariant(selVariant.id, 'adjust', { ...selVariant.adjust, [k]: v })} />
                </div>
              ))}
            </Row>

            <Row label="Transform" linked={isLinkedVariant ? selVariant.links?.transform : undefined}
              onToggleLink={isLinkedVariant ? () => s.toggleLink(selVariant.id, 'transform') : null}
              locked={isLinkedVariant && selVariant.links?.transform}
              onReset={() => resetGroup('transform')} {...vp('transform')}>
              <div className="grid grid-cols-2 gap-1">
                <label className="text-[10px] text-zinc-400">dx<Num value={selVariant.transform.dx} min={-500}
                  onChange={(v) => s.updateVariant(selVariant.id, 'transform', { ...selVariant.transform, dx: v })} width="w-full" /></label>
                <label className="text-[10px] text-zinc-400">dy<Num value={selVariant.transform.dy} min={-500}
                  onChange={(v) => s.updateVariant(selVariant.id, 'transform', { ...selVariant.transform, dy: v })} width="w-full" /></label>
                <label className="text-[10px] text-zinc-400">scale<Num value={selVariant.transform.scale} min={0.1} max={5} step={0.05}
                  onChange={(v) => s.updateVariant(selVariant.id, 'transform', { ...selVariant.transform, scale: v })} width="w-full" /></label>
                <label className="text-[10px] text-zinc-400">rot°<Num value={selVariant.transform.rot} min={-180} max={180}
                  onChange={(v) => s.updateVariant(selVariant.id, 'transform', { ...selVariant.transform, rot: v })} width="w-full" /></label>
              </div>
            </Row>

            <Row label="Upscale" onReset={() => s.updateVariant(selVariant.id, 'upscale', 'auto')}>
              <select value={selVariant.upscale || 'auto'}
                onChange={(e) => s.updateVariant(selVariant.id, 'upscale', e.target.value)}
                className="w-full text-xs border border-zinc-200 rounded-lg px-2 py-1.5 bg-white">
                <option value="auto">Auto (export setting)</option>
                {UPSCALE_MODELS.map((m) => <option key={m.id} value={m.id}>{m.label}</option>)}
              </select>
              {selVariant.upscale && selVariant.upscale !== 'auto' && (
                <p className="text-[10px] text-blue-600 mt-1">export uses this over the global setting</p>
              )}
            </Row>

            <div className="py-2">
              <div className="text-[11px] font-medium text-zinc-500 uppercase tracking-wide mb-1">Style</div>
              <div className="flex gap-1">
                <button onClick={() => s.copyStyle()} className="flex-1 text-[11px] py-1.5 rounded-lg bg-zinc-100 hover:bg-zinc-200">Copy</button>
                <button onClick={() => s.pasteStyle()} disabled={!s.styleClipboard}
                  className="flex-1 text-[11px] py-1.5 rounded-lg bg-zinc-100 hover:bg-zinc-200 disabled:opacity-40 flex items-center justify-center gap-1">
                  <ClipboardPaste size={11} /> Paste</button>
              </div>
              <p className="text-[10px] text-zinc-400 mt-1">copy/paste whole style · + menu per row shares single values</p>
            </div>
          </aside>
        )}
       {/* right panel — image styling when an image (not a box) is selected */}
        {!selBox && selImg && imgSt && s.mode === 'board' && (
          <aside className="w-64 border-l border-zinc-200 bg-white overflow-y-auto shrink-0 p-3">
            <div className="flex items-center gap-1.5 mb-1">
              <ImageIcon size={14} className="text-zinc-400 shrink-0" />
              <input value={selImg.name} onChange={(e) => s.renameImage(selImg.id, e.target.value)}
                className="text-sm font-semibold bg-transparent border-b border-transparent hover:border-zinc-200 focus:border-blue-400 outline-none flex-1 min-w-0" />
            </div>
            <p className="text-[10px] font-mono text-zinc-400 mb-2">{selImg.w ? `${selImg.w}×${selImg.h}` : ''} · styles the image itself</p>
            <button
              onClick={async () => {
                const im = useStore.getState().images.find((m) => m.id === selImg.id);
                if (!im?.w) return;
                const stl = im.style || defaultImageStyle();
                const canvas = await renderCut({ imageUrl: im.url,
                  box: { rect: { x: 0, y: 0, w: im.w, h: im.h } },
                  design: { radius: stl.radius, border: stl.border, shadow: stl.shadow, adjust: stl.adjust,
                    feather: stl.feather, pad: stl.pad, crop: { t: 0, r: 0, b: 0, l: 0 },
                    transform: { dx: 0, dy: 0, scale: 1, rot: 0, flipH: false }, mask: { enabled: false } },
                  scale: useStore.getState().exportScale });
                const blob = await new Promise((r) => canvas.toBlob(r, 'image/png'));
                const a = document.createElement('a');
                a.href = URL.createObjectURL(blob);
                a.download = `${im.name}-styled.png`;
                a.click();
              }}
              className="w-full text-[11px] font-medium py-1.5 rounded-lg bg-zinc-900 text-white hover:bg-zinc-700 mb-1">
              Export styled PNG</button>
            <p className="text-[10px] text-zinc-400 mb-1">mask cutouts composite onto this style</p>

            <Row label="Radius" onReset={() => s.updateImageStyle(selImg.id, 'radius', freshImg.radius)} {...ivp('radius')}>
              <div className="flex items-center gap-2">
                <Slider value={imgSt.radius} min={0} max={200} step={1}
                  onChange={(v) => s.updateImageStyle(selImg.id, 'radius', v)} />
                <Num value={imgSt.radius} onChange={(v) => s.updateImageStyle(selImg.id, 'radius', v)} />
              </div>
            </Row>
            <Row label="Border" onReset={() => s.updateImageStyle(selImg.id, 'border', structuredClone(freshImg.border))} {...ivp('border')}>
              <div className="flex items-center gap-2">
                <Num value={imgSt.border.w} onChange={(v) => s.updateImageStyle(selImg.id, 'border', { ...imgSt.border, w: v })} />
                <input type="color" value={imgSt.border.color}
                  onChange={(e) => s.updateImageStyle(selImg.id, 'border', { ...imgSt.border, color: e.target.value })}
                  className="w-8 h-7 rounded cursor-pointer" />
              </div>
            </Row>
            <Row label="Shadow" onReset={() => s.updateImageStyle(selImg.id, 'shadow', structuredClone(freshImg.shadow))} {...ivp('shadow')}>
              <label className="flex items-center gap-2 text-xs mb-1">
                <input type="checkbox" checked={imgSt.shadow.enabled}
                  onChange={(e) => s.updateImageStyle(selImg.id, 'shadow', { ...imgSt.shadow, enabled: e.target.checked })} /> on</label>
              {imgSt.shadow.enabled && (
                <ShadowControls shadow={imgSt.shadow}
                  onChange={(next) => s.updateImageStyle(selImg.id, 'shadow', next)} />
              )}
            </Row>
            <Row label="Feather" onReset={() => s.updateImageStyle(selImg.id, 'feather', 0)} {...ivp('feather')}>
              <div className="flex items-center gap-2">
                <Slider value={imgSt.feather} min={0} max={80} step={1}
                  onChange={(v) => s.updateImageStyle(selImg.id, 'feather', v)} />
                <Num value={imgSt.feather} onChange={(v) => s.updateImageStyle(selImg.id, 'feather', v)} />
              </div>
            </Row>
            <Row label="Adjust" onReset={() => s.updateImageStyle(selImg.id, 'adjust', structuredClone(freshImg.adjust))} {...ivp('adjust')}>
              {[['sat', 'Saturation'], ['bright', 'Value'], ['contrast', 'Contrast']].map(([k, lab]) => (
                <div key={k} className="mb-1">
                  <div className="flex justify-between text-[10px] text-zinc-400"><span>{lab}</span><span>{imgSt.adjust[k].toFixed(2)}</span></div>
                  <Slider value={imgSt.adjust[k]} min={0} max={2}
                    onChange={(v) => s.updateImageStyle(selImg.id, 'adjust', { ...imgSt.adjust, [k]: v })} />
                </div>
              ))}
            </Row>
            <Row label="Padding · transparent" onReset={() => s.updateImageStyle(selImg.id, 'pad', structuredClone(freshImg.pad))} {...ivp('pad')}>
              <div className="grid grid-cols-4 gap-1">
                {['t', 'r', 'b', 'l'].map((k) => (
                  <label key={k} className="text-[10px] text-zinc-400">{k}
                    <Num value={imgSt.pad[k]} onChange={(v) => s.updateImageStyle(selImg.id, 'pad', { ...imgSt.pad, [k]: v })} width="w-full" /></label>
                ))}
              </div>
              <p className="text-[10px] text-zinc-400 mt-0.5">feather + padding apply on export</p>
            </Row>
          </aside>
        )}
      </div>

      {/* export modal + splash */}
      {s.exportOpen && (
        <div className="fixed inset-0 bg-black/30 grid place-items-center z-50" onClick={() => !exporting && s.setExportOpen(false)}>
          <div className="bg-white rounded-2xl w-[640px] max-w-[94vw] max-h-[90vh] overflow-auto p-5 shadow-2xl" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center mb-3">
              <span className="text-sm font-semibold">Export</span>
              <span className="text-[11px] text-zinc-400 ml-2">{jobs.length} cuts</span>
              <div className="flex-1" />
              <button onClick={() => s.setExportOpen(false)} className="text-zinc-400 hover:text-zinc-700"><X size={16} /></button>
            </div>
            <div className="flex bg-zinc-100 rounded-lg p-0.5 mb-3">
              {[['all', `All cuts (${s.boxes.length})`], ['selected', 'Selected box']].map(([id, t]) => (
                <button key={id} onClick={() => setExportScope(id)}
                  className={`flex-1 py-1.5 rounded-lg text-xs font-semibold ${exportScope === id ? 'bg-white shadow-sm text-zinc-900' : 'text-zinc-400'}`}>{t}</button>
              ))}
            </div>
            <div className="grid grid-cols-2 gap-3 mb-3">
              <label className="text-xs">Scale
                <div className="flex gap-1 mt-1">
                  {[1, 2, 3].map((z) => (
                    <button key={z} onClick={() => s.setExportScale(z)}
                      className={`flex-1 py-1.5 rounded-lg text-xs font-semibold ${s.exportScale === z ? 'bg-zinc-900 text-white' : 'bg-zinc-100'}`}>{z}x</button>
                  ))}
                </div>
              </label>
              <label className="text-xs">Upscale
                <select value={s.upscaleModel} onChange={(e) => s.setUpscaleModel(e.target.value)}
                  className="mt-1 w-full text-xs border border-zinc-200 rounded-lg px-2 py-1.5 bg-white">
                  {UPSCALE_MODELS.map((m) => <option key={m.id} value={m.id}>{m.label}</option>)}
                </select>
              </label>
            </div>
            <p className="text-[11px] text-zinc-400 mb-3">
              {UPSCALE_MODELS.find((m) => m.id === s.upscaleModel)?.desc} · variants + groups export as folders ·
              order: crop → radius (+ feather) → padding → transform · clipper-manifest.json included for layer rebuilds
            </p>
            {exportScope === 'selected' && !s.sel.boxId && (
              <p className="text-[11px] text-amber-600 bg-amber-50 rounded-lg px-2.5 py-1.5 mb-3">Select a box first — or switch to All cuts.</p>
            )}
            {upscaleNote && <p className="text-[11px] text-amber-600 bg-amber-50 rounded-lg px-2.5 py-1.5 mb-3">{upscaleNote}</p>}

            {/* splash: sources left, cuts scatter right */}
            <div className="grid grid-cols-[1fr_1.4fr] gap-3 mb-3">
              <div className="rounded-xl border border-zinc-200 p-2 bg-zinc-50">
                <div className="text-[10px] font-semibold text-zinc-400 uppercase tracking-wide mb-1.5">Sources</div>
                <div className="flex flex-col gap-1.5 max-h-64 overflow-auto">
                  {s.images.map((img) => (
                    <div key={img.id} className="relative rounded-lg overflow-hidden border border-zinc-200 bg-white">
                      <img src={img.url} className="w-full block" alt="" draggable={false} />
                      {s.boxes.filter((b) => b.imageId === img.id).flatMap((b) =>
                        s.variants.filter((v) => v.boxId === b.id).map((v) => ({ b, v }))).map(({ b, v }) => {
                        const hot = activeCut?.variantId === v.id;
                        return (
                          <div key={v.id}
                            className={`absolute border-2 ${hot ? 'border-blue-500 pulsebox' : 'border-blue-400/60'}`}
                            style={{
                              left: `${(v.rect.x / img.w) * 100}%`, top: `${(v.rect.y / img.h) * 100}%`,
                              width: `${(v.rect.w / img.w) * 100}%`, height: `${(v.rect.h / img.h) * 100}%`,
                            }} />
                        );
                      })}
                    </div>
                  ))}
                  {!s.images.length && <p className="text-[11px] text-zinc-400">no images</p>}
                </div>
              </div>
              <div className="rounded-xl border border-zinc-200 checker relative overflow-hidden min-h-[280px]">
                <div className="absolute top-2 left-2.5 text-[10px] font-semibold text-zinc-500 uppercase tracking-wide bg-white/85 px-1.5 rounded">Cuts</div>
                {splash.map((p, i) => {
                  const pos = scatter[i % scatter.length];
                  return (
                    <div key={`${p.path}-${i}`} className="pop absolute"
                      style={{ left: `${pos.x}%`, top: `${pos.y}%`, width: '22%' }}>
                      <img src={p.thumb} className="w-full rounded-md shadow-lg border border-white" alt="" draggable={false} />
                      <div className="text-[9px] font-mono bg-zinc-900/85 text-white px-1 rounded mt-0.5 truncate">✂ {p.path}</div>
                    </div>
                  );
                })}
                {!splash.length && (
                  <p className="absolute inset-0 grid place-items-center text-[11px] text-zinc-400">
                    {exporting ? 'clipping sequentially…' : 'cuts land here, scattered'}
                  </p>
                )}
              </div>
            </div>

            <button onClick={doExport} disabled={exporting || !jobs.length}
              className="w-full py-2.5 rounded-xl bg-zinc-900 text-white text-sm font-semibold hover:bg-zinc-700 disabled:opacity-40">
              {exporting ? `Clipping… ${splash.length} files` : done ? `Download again (${jobs.length} cuts)` : `Clip + download zip (${jobs.length} cuts)`}</button>
          </div>
        </div>
      )}
      {(() => {
        const drawing = !!draw;
        const boxDrag = drag && (drag.kind === 'boxmove' || drag.kind === 'boxresize');
        const drawRect = drawing ? {
          x: Math.min(draw.startX, draw.curX), y: Math.min(draw.startY, draw.curY),
          w: Math.abs(draw.curX - draw.startX), h: Math.abs(draw.curY - draw.startY),
        } : null;
        const drawImg = drawing ? s.images.find((i) => i.id === draw.imageId) : null;
        const show = tweakOn || (drawing && drawRect && drawRect.w > 4 && drawRect.h > 4) || boxDrag;
        if (!show) return null;
        return (
          <div className="fixed z-30 bottom-20 right-[17.5rem] max-w-44 max-h-60 rounded-xl border border-zinc-200 shadow-xl checker pointer-events-none grid place-items-center overflow-hidden">
            {drawing && drawImg && drawRect ? (
              <LiveCrop image={drawImg} rect={drawRect} className="block" />
            ) : boxDrag && selImage && selVariant ? (
              <LiveCrop image={selImage} rect={selVariant.rect} className="block" />
            ) : selVariant && selImage ? (
              <CutThumb image={selImage} box={selBox} variant={selVariant} maskBase={selMaskBase} className="block max-w-44 max-h-60 w-auto h-auto object-contain" />
            ) : selImg ? (
              <img src={selImg.url} alt="" draggable={false} className="block max-w-44 max-h-60 w-auto h-auto object-contain"
                style={{ filter: cssFilterString(imgSt?.adjust), borderRadius: imgSt?.radius || 0 }} />
            ) : null}
          </div>
        );
      })()}
    </div>
    </TweakCtx.Provider>
  );
}

// Headless store test — mirrors the dashboard separation scenario.
// Run: bun test/store.headless.mjs  (no browser, no DOM needed)
import { useStore, ancestorPath, defaultVariant } from '../src/store.js';

const S = () => useStore.getState();
let pass = 0, fail = 0;
const ok = (cond, name, extra = '') => {
  if (cond) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name} ${extra}`); };
};

// synthetic image (bypasses addImages' DOM needs); style absent -> merge paths
useStore.setState({ images: [{ id: 'img1', url: 'x', name: 'dashboard', w: 1600, h: 1000, x: 0, y: 0 }] });

console.log('— boxes + variants');
S().addBox('img1', { x: 0, y: 0, w: 240, h: 1000 }); const sidebar = S().boxes.at(-1);
S().renameBox(sidebar.id, 'sidebar');
S().addBox('img1', { x: 264, y: 96, w: 1312, h: 168 }); const kpi = S().boxes.at(-1);
S().addBox('img1', { x: 1148, y: 288, w: 428, h: 400 }); const donut = S().boxes.at(-1);
S().addBox('img1', { x: 1310, y: 406, w: 104, h: 104 }); const hole = S().boxes.at(-1);
ok(S().boxes.length === 4, '4 boxes created');
ok(S().variants.length === 4, '1 variant each');
const sV1 = S().variants.find((v) => v.boxId === sidebar.id);
ok(sV1 && Object.keys(sV1.links).length === 0, 'original links to nothing');

console.log('— linked variants');
S().addVariant(sidebar.id);
let sVars = S().variants.filter((v) => v.boxId === sidebar.id);
const sV2 = sVars.at(-1);
ok(sVars.length === 2 && sV2.links.rect === true && sV2.links.transform === false, 'v2 linked all but transform');
S().toggleLink(sV2.id, 'radius');
S().updateVariant(sV2.id, 'radius', 24);
ok(S().variants.find((v) => v.id === sV2.id).radius === 24, 'unlinked radius editable');
ok(S().variants.find((v) => v.id === sV1.id).radius === 0, 'original untouched');
S().updateVariant(sV1.id, 'border', { w: 3, color: '#6366f1' });
ok(S().variants.find((v) => v.id === sV2.id).border.w === 3, 'linked border propagates from original');
S().toggleLink(sV2.id, 'radius'); // re-link snaps back
ok(S().variants.find((v) => v.id === sV2.id).radius === 0, 're-link snaps radius to original');
const before = JSON.stringify(S().variants.find((v) => v.id === sV2.id).rect);
S().updateVariantRect(sidebar.id, sV2.id, { x: 5, y: 5, w: 10, h: 10 });
ok(JSON.stringify(S().variants.find((v) => v.id === sV2.id).rect) === before, 'locked rect edit ignored');
S().updateVariantRect(sidebar.id, sV1.id, { x: 0, y: 0, w: 240, h: 1000 });
ok(S().variants.find((v) => v.id === sV2.id).rect.x === 0, 'original rect edit propagates to linked');

console.log('— slicer / mask / auto-pad flags');
S().updateSlicer(kpi.id, { enabled: true, rows: 1, cols: 4, rowGap: 0, colGap: 24 });
ok(S().boxes.find((b) => b.id === kpi.id).slicer.cols === 4, 'slicer configured');
S().setParent('box', hole.id, donut.id, 'box');
const holeV = S().variants.find((v) => v.boxId === hole.id);
S().updateVariant(holeV.id, 'mask', { enabled: true, fill: null });
S().updateVariant(holeV.id, 'feather', 6);
ok(S().variants.find((v) => v.id === holeV.id).mask.enabled === true, 'mask enabled on nested variant');
S().updateVariant(sV1.id, 'pad', { t: 0, r: 0, b: 0, l: 0, auto: true });
ok(S().variants.find((v) => v.id === sV1.id).pad.auto === true, 'auto-pad flag set');

console.log('— groups + hierarchy + export paths');
const gNav = S().addGroup('nav'), gStats = S().addGroup('stats'), gContent = S().addGroup('content');
S().setParent('box', sidebar.id, gNav, 'group');
S().setParent('box', kpi.id, gStats, 'group');
S().setParent('box', donut.id, gContent, 'group');
const st1 = S();
const freshHole = st1.boxes.find((b) => b.id === hole.id);
const freshDonut = st1.boxes.find((b) => b.id === donut.id);
const freshSidebar = st1.boxes.find((b) => b.id === sidebar.id);
ok(ancestorPath(freshHole, st1.boxes, st1.groups).length === 2, 'nested ancestor path has 2 levels');
S().renameBox(donut.id, 'donut-card');
const st2 = S();
ok(ancestorPath(st2.boxes.find((b) => b.id === hole.id), st2.boxes, st2.groups).join('/') === 'content/donut-card', 'nested path content/donut-card');
ok(ancestorPath(st2.boxes.find((b) => b.id === sidebar.id), st2.boxes, st2.groups).join('/') === 'nav', 'root path nav');
ok(S().setParent('box', donut.id, hole.id, 'box') === false, 'cycle guard rejects');
S().deleteGroup(gStats);
const st3 = S();
ok(st3.boxes.find((b) => b.id === kpi.id).parentId === null, 'deleteGroup moves children up');

console.log('— undo / redo');
const nvBefore = S().variants.length;
S().addVariant(sidebar.id);
ok(S().variants.length === nvBefore + 1, 'variant added');
S().undo();
ok(S().variants.length === nvBefore, 'undo removes variant');
S().redo();
ok(S().variants.length === nvBefore + 1, 'redo restores variant');
const pastLen = S().past.length;
S().beginHistory();
S().updateVariant(sV1.id, 'radius', 9);
ok(S().past.length === pastLen + 2, 'discrete edit pushes history');

console.log('— shared style variables');
S().saveStyleVar('border', 'brand-ring', { w: 4, color: '#6366f1' });
ok(S().styleVars.length === 1, 'var saved (outside history)');
const pastBeforeVars = S().past.length;
ok(S().past.length === pastBeforeVars, 'library save touches no history');
S().updateVariant(sV1.id, 'border', S().styleVars[0].value);
ok(S().variants.find((v) => v.id === sV1.id).border.w === 4, 'var applied');
S().deleteStyleVar(S().styleVars[0].id);
ok(S().styleVars.length === 0, 'var deleted');

console.log('— image style + original promotion');
S().updateImageStyle('img1', 'radius', 32);
ok(S().images[0].style.radius === 32, 'image style set (merges defaults)');
S().renameImage('img1', 'dash');
ok(S().images[0].name === 'dash', 'image renamed');
const ids = S().variants.filter((v) => v.boxId === sidebar.id).map((v) => v.id);
S().deleteVariant(sidebar.id, ids[0]); // delete original
const nf = S().variants.find((v) => v.boxId === sidebar.id);
ok(nf && Object.keys(nf.links).length === 0, 'new first promoted to original');

console.log('— align / distribute / batch delete / coalesced history');
S().addBox('img1', { x: 10, y: 10, w: 100, h: 50 }); const al1 = S().boxes.at(-1).id;
S().addBox('img1', { x: 200, y: 80, w: 150, h: 60 }); const al2 = S().boxes.at(-1).id;
S().addBox('img1', { x: 400, y: 30, w: 120, h: 40 }); const al3 = S().boxes.at(-1).id;
const p0 = S().past.length;
S().alignBoxes([al1, al2, al3], 'left');
const RA = (id) => S().variants.find((v) => v.boxId === id).rect;
ok(RA(al1).x === 10 && RA(al2).x === 10 && RA(al3).x === 10, 'align left');
ok(S().past.length === p0 + 1, 'align is one undo step');
S().undo();
ok(S().variants.find((v) => v.boxId === al2).rect.x === 200, 'align undoes cleanly');
S().alignBoxes([al1, al2, al3], 'distH');
const RD = (id) => S().variants.find((v) => v.boxId === id).rect;
ok(RD(al1).x === 10 && RD(al2).x === 185 && RD(al3).x === 400, 'distribute H even',
  JSON.stringify([RD(al1).x, RD(al2).x, RD(al3).x]));
const vAl3 = S().variants.find((v) => v.boxId === al3).id;
const p1 = S().past.length;
S().updateVariant(vAl3, 'radius', 5);
S().updateVariant(vAl3, 'radius', 6);
S().updateVariant(vAl3, 'radius', 7);
ok(S().past.length === p1 + 1, 'rapid same-field edits coalesce');
S().updateVariant(vAl3, 'feather', 3);
ok(S().past.length === p1 + 2, 'different field pushes new step');
S().undo();
const uv = S().variants.find((v) => v.id === vAl3);
ok(uv.radius === 7 && uv.feather === 0, 'undo drops last step only');
const nb = S().boxes.length, nv = S().variants.length;
S().deleteBoxes([al1, al2]);
ok(S().boxes.length === nb - 2 && S().variants.length === nv - 2, 'batch delete');
ok(S().variants.find((v) => v.boxId === al3).shadow.spread === 0, 'shadow spread defaults to 0');
S().updateVariant(vAl3, 'upscale', 'ui-text');
ok(S().variants.find((v) => v.id === vAl3).upscale === 'ui-text', 'variant upscale override persists');
ok(S().variants.find((v) => v.boxId === kpi.id)?.upscale === 'auto', 'upscale defaults to auto');
ok(S().variants.find((v) => v.boxId === kpi.id)?.isolate?.enabled === false, 'isolate defaults off');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

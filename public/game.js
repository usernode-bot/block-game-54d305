// block-game — the whole client: scene, input, rendering, sync.
//
// One job: build in the shared world. The 3D scene has one fixed daytime
// look of its own (it is the game's scenery, not themed chrome); only the
// HUD follows the viewer's Homeroom theme, via the dark class on <html>
// that index.html's theme script keeps up to date.

import * as THREE from '/vendor/three.module.js';

// The world box, mirroring server.js. Cell (x, y, z) is the unit cube whose
// lowest corner sits at those integer grid coordinates.
const WORLD = { sizeX: 128, sizeY: 64, sizeZ: 128 };

// The Hotbar palette, in tray order. These flat colours are the single
// source of truth for BOTH the 3D blocks (vertex-coloured faces) and the
// Hotbar slot previews (little SVG cubes built from the same values).
const PALETTE = [
  { name: 'Grass',  type: 'grass',  top: 0x74b44a, side: 0x79553a, front: 0x6b4a30 },
  { name: 'Dirt',   type: 'dirt',   top: 0x8a6244, side: 0x7d573c, front: 0x6f4d35 },
  { name: 'Stone',  type: 'stone',  top: 0x9c9c9c, side: 0x8d8d8d, front: 0x7f7f7f },
  { name: 'Log',    type: 'log',    top: 0xb09055, side: 0x6e5230, front: 0x63492b },
  { name: 'Planks', type: 'planks', top: 0xb98e5a, side: 0xa87e4e, front: 0x9c7345 },
  { name: 'Brick',  type: 'brick',  top: 0x9c5b4b, side: 0x8e5044, front: 0x814639 },
  { name: 'Glass',  type: 'glass',  top: 0xd8eef2, side: 0xc4e2ea, front: 0xb4d8e2, opacity: 0.5 },
  { name: 'Leaves', type: 'leaves', top: 0x4f9440, side: 0x46853a, front: 0x3d7632 },
];

// One fixed daytime sky. The scene never reads the theme.
const SKY = 0x9ecfe8;
const FOG_NEAR = 70, FOG_FAR = 190;
const REACH = 100; // how far the crosshair can target, in blocks
const MOVE_SPEED = 10; // blocks per second
const LOOK_SPEED = 0.0024; // radians per pixel of mouse travel
const POLL_MS = 1000;

// ---------------------------------------------------------------- auth ----
// The shell embeds the app with ?token=…; every API call forwards it as a
// header, exactly as the template script did.
const params = new URLSearchParams(window.location.search);
const token = params.get('token') || '';
const apiHeaders = token ? { 'x-usernode-token': token } : {};

// ------------------------------------------------------------ the world ----
// Key "x,y,z" → palette type. `air` rows from the server (break tombstones)
// are simply absent: nothing to render, nothing to aim at.
const world = new Map();
const keyOf = (x, y, z) => x + ',' + y + ',' + z;
const inBounds = (x, y, z) =>
  x >= 0 && x < WORLD.sizeX && y >= 0 && y < WORLD.sizeY && z >= 0 && z < WORLD.sizeZ;

// Cells with an edit in flight, so a sync batch can't clobber what the
// player just did before the server has answered. Cleared when the POST
// resolves; the next batch then shows the authoritative state.
const pending = new Set();

// ---------------------------------------------------------------- scene ----
const canvas = document.getElementById('game');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(window.innerWidth, window.innerHeight);

const scene = new THREE.Scene();
scene.background = new THREE.Color(SKY);
scene.fog = new THREE.Fog(SKY, FOG_NEAR, FOG_FAR);

const camera = new THREE.PerspectiveCamera(
  75, window.innerWidth / window.innerHeight, 0.1, 400
);
camera.rotation.order = 'YXZ';
// Spawn over the plain near one edge, looking toward the middle of the world.
camera.position.set(64.5, 12, 20.5);
camera.rotation.y = Math.PI; // default forward is -z; turned around to face +z

// A hemisphere fill from the sky plus one warm sun give the flat colours
// just enough shading to read as solids.
scene.add(new THREE.HemisphereLight(0xeaf4ff, 0x8a7a5c, 1.1));
const sun = new THREE.DirectionalLight(0xfff3d6, 1.6);
sun.position.set(20, 90, -40);
scene.add(sun);
scene.add(sun.target);

// ------------------------------------------------- per-type mesh toolkit ----
// BoxGeometry colours its 24 vertices in face order: +x, -x, +y, -y, +z, -z,
// four vertices per face. Baking vertex colours per type means the whole
// world draws as one InstancedMesh per block type — ~8 draw calls total —
// and Grass can keep its green top with earthy sides.
function coloredBox(top, side, front, bottom) {
  const geo = new THREE.BoxGeometry(1, 1, 1);
  const faceColors = [side, side, top, bottom ?? side, front, front];
  const colors = new Float32Array(24 * 3);
  const c = new THREE.Color();
  for (let f = 0; f < 6; f++) {
    c.setHex(faceColors[f]);
    for (let v = 0; v < 4; v++) {
      const i = (f * 4 + v) * 3;
      colors[i] = c.r; colors[i + 1] = c.g; colors[i + 2] = c.b;
    }
  }
  geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  return geo;
}

const geometryByType = new Map();
const materialByType = new Map();
for (const b of PALETTE) {
  geometryByType.set(b.type, coloredBox(b.top, b.side, b.front));
  materialByType.set(b.type, new THREE.MeshLambertMaterial({
    vertexColors: true,
    transparent: b.opacity !== undefined,
    opacity: b.opacity ?? 1,
  }));
}

// --------------------------------------------------------------- meshes ----
let typeMeshes = [];
let meshesDirty = false; // rebuild once per frame at most

function rebuildMeshes() {
  // Group solid cells by type. A full rebuild per change batch is cheap at
  // this world size and keeps the code simple.
  const byType = new Map();
  for (const [k, type] of world) {
    if (!byType.has(type)) byType.set(type, []);
    byType.get(type).push(k.split(',').map(Number));
  }
  for (const old of typeMeshes) {
    scene.remove(old);
    old.dispose();
  }
  typeMeshes = [];
  for (const b of PALETTE) {
    const cells = byType.get(b.type);
    if (!cells || !cells.length) continue;
    const mesh = new THREE.InstancedMesh(
      geometryByType.get(b.type), materialByType.get(b.type), cells.length
    );
    const m = new THREE.Matrix4();
    for (let i = 0; i < cells.length; i++) {
      const [x, y, z] = cells[i];
      mesh.setMatrixAt(i, m.makeTranslation(x + 0.5, y + 0.5, z + 0.5));
    }
    mesh.instanceMatrix.needsUpdate = true;
    // The mesh spans the whole world by definition; per-frame culling of a
    // single unit-box bounding sphere would wrongly hide it.
    mesh.frustumCulled = false;
    scene.add(mesh);
    typeMeshes.push(mesh);
  }
}

// ------------------------------------------------------------- targeting ----
// A voxel-grid raycast (Amanatides–Woo): walk the ray cell by cell until it
// enters a solid one. Faster and more precise than raycasting the meshes —
// it works straight off the world Map, meshes included or not.
function voxelRaycast(origin, dir, maxDist) {
  let x = Math.floor(origin.x), y = Math.floor(origin.y), z = Math.floor(origin.z);
  const stepX = dir.x > 0 ? 1 : -1;
  const stepY = dir.y > 0 ? 1 : -1;
  const stepZ = dir.z > 0 ? 1 : -1;
  const tDeltaX = dir.x !== 0 ? Math.abs(1 / dir.x) : Infinity;
  const tDeltaY = dir.y !== 0 ? Math.abs(1 / dir.y) : Infinity;
  const tDeltaZ = dir.z !== 0 ? Math.abs(1 / dir.z) : Infinity;
  // Distance along the ray to the first grid plane crossed on each axis.
  let tMaxX = dir.x !== 0 ? (dir.x > 0 ? x + 1 - origin.x : origin.x - x) * tDeltaX : Infinity;
  let tMaxY = dir.y !== 0 ? (dir.y > 0 ? y + 1 - origin.y : origin.y - y) * tDeltaY : Infinity;
  let tMaxZ = dir.z !== 0 ? (dir.z > 0 ? z + 1 - origin.z : origin.z - z) * tDeltaZ : Infinity;
  let nx = 0, ny = 0, nz = 0;
  let t = 0;
  while (t <= maxDist) {
    if (world.has(keyOf(x, y, z))) return { x, y, z, nx, ny, nz };
    if (tMaxX < tMaxY && tMaxX < tMaxZ) {
      x += stepX; t = tMaxX; tMaxX += tDeltaX; nx = -stepX; ny = 0; nz = 0;
    } else if (tMaxY < tMaxZ) {
      y += stepY; t = tMaxY; tMaxY += tDeltaY; ny = -stepY; nx = 0; nz = 0;
    } else {
      z += stepZ; t = tMaxZ; tMaxZ += tDeltaZ; nz = -stepZ; nx = 0; ny = 0;
    }
  }
  return null;
}

const aimDir = new THREE.Vector3();
function aim() {
  aimDir.set(0, 0, -1).applyQuaternion(camera.quaternion);
  return voxelRaycast(camera.position, aimDir, REACH);
}

// Dark wireframe outline around the aimed cell.
const highlight = new THREE.LineSegments(
  new THREE.EdgesGeometry(new THREE.BoxGeometry(1.002, 1.002, 1.002)),
  new THREE.LineBasicMaterial({ color: 0x1a1a1a })
);
highlight.visible = false;
scene.add(highlight);

function updateHighlight() {
  const hit = aim();
  if (hit) {
    highlight.position.set(hit.x + 0.5, hit.y + 0.5, hit.z + 0.5);
    highlight.visible = true;
  } else {
    highlight.visible = false;
  }
}

// ---------------------------------------------------------------- input ----
let locked = false;
let selected = 0;

const keys = new Set();
const movementKeys = new Set([
  'KeyW', 'KeyA', 'KeyS', 'KeyD', 'Space', 'ShiftLeft', 'ShiftRight',
]);

document.addEventListener('keydown', (e) => {
  const slot = /^Digit([1-8])$/.exec(e.code);
  if (slot) {
    selectSlot(Number(slot[1]) - 1);
    return;
  }
  if (!locked) return;
  if (movementKeys.has(e.code)) {
    keys.add(e.code);
    // Keep Space from scrolling the page or clicking a focused Hotbar slot.
    e.preventDefault();
  }
});
document.addEventListener('keyup', (e) => keys.delete(e.code));

document.addEventListener('mousemove', (e) => {
  if (!locked) return;
  camera.rotation.y -= e.movementX * LOOK_SPEED;
  camera.rotation.x -= e.movementY * LOOK_SPEED;
  const limit = Math.PI / 2 - 0.01;
  camera.rotation.x = Math.max(-limit, Math.min(limit, camera.rotation.x));
});

document.addEventListener('mousedown', (e) => {
  if (!locked) return;
  if (e.button === 0) place();
  else if (e.button === 2) breakBlock();
});
// Right-click is Break; the browser menu has nothing to say here.
document.addEventListener('contextmenu', (e) => e.preventDefault());

document.addEventListener('wheel', (e) => {
  if (!locked) return;
  const step = e.deltaY > 0 ? 1 : -1;
  selectSlot((selected + step + PALETTE.length) % PALETTE.length);
}, { passive: true });

function move(dt) {
  const f = (keys.has('KeyW') ? 1 : 0) - (keys.has('KeyS') ? 1 : 0);
  const r = (keys.has('KeyD') ? 1 : 0) - (keys.has('KeyA') ? 1 : 0);
  const u = (keys.has('Space') ? 1 : 0)
    - (keys.has('ShiftLeft') || keys.has('ShiftRight') ? 1 : 0);
  if (!f && !r && !u) return;
  // WASD is horizontal whatever the pitch; Space and Shift are pure up/down,
  // so flying feels like creative mode.
  const yaw = camera.rotation.y;
  const dx = (-Math.sin(yaw) * f + Math.cos(yaw) * r) * MOVE_SPEED * dt;
  const dz = (-Math.cos(yaw) * f - Math.sin(yaw) * r) * MOVE_SPEED * dt;
  camera.position.x += dx;
  camera.position.z += dz;
  camera.position.y += u * MOVE_SPEED * dt;
}

window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
});

// --------------------------------------------------------- pointer lock ----
const overlay = document.getElementById('overlay');
const overlayTitle = document.getElementById('overlay-title');
const overlayNote = document.getElementById('overlay-note');
const overlayHints = document.getElementById('overlay-hints');
const crosshair = document.getElementById('crosshair');
const expiredEl = document.getElementById('expired');
const touchCard = document.getElementById('touch-card');
const hotbarEl = document.getElementById('hotbar');
const blockNameEl = document.getElementById('block-name');

// This version needs a mouse and keyboard; a touch device gets the card.
const isTouch = window.matchMedia('(any-pointer: coarse)').matches
  || typeof canvas.requestPointerLock !== 'function';

function showOverlay(title, note, hints) {
  overlay.classList.remove('hidden');
  overlayTitle.textContent = title;
  overlayNote.textContent = note;
  overlayHints.classList.toggle('hidden', !hints);
}

function hideOverlay() {
  overlay.classList.add('hidden');
}

overlay.addEventListener('click', () => {
  if (loaded && !expired) canvas.requestPointerLock();
});
canvas.addEventListener('click', () => {
  if (loaded && !expired && !locked) canvas.requestPointerLock();
});

document.addEventListener('pointerlockchange', () => {
  locked = document.pointerLockElement === canvas;
  if (locked) hideOverlay();
  else if (!isTouch && !expired) showOverlay('Click to build', 'Your mouse will steer the camera.', true);
});

// ------------------------------------------------------------- the HUD ----
// A little isometric cube per palette entry, from the same colours the 3D
// blocks use, so the tray previews always match the world.
function cubeSvg(b, size) {
  const hex = (n) => '#' + n.toString(16).padStart(6, '0');
  return `<svg width="${size}" height="${size}" viewBox="0 0 100 100" aria-hidden="true">
    <polygon points="50,4 96,30 50,56 4,30" fill="${hex(b.top)}"/>
    <polygon points="4,30 50,56 50,98 4,72" fill="${hex(b.side)}"/>
    <polygon points="96,30 50,56 50,98 96,72" fill="${hex(b.front)}"/>
  </svg>`;
}

const SLOT_CLASSES = 'relative h-10 w-10 rounded-md border-2 flex items-center justify-center focus:outline-none ';
const SLOT_UP = 'bg-stone-50 border-stone-400 hover:bg-white dark:bg-stone-800 dark:border-stone-600 dark:hover:bg-stone-700';
const SLOT_SELECTED = 'bg-white border-green-600 ring-2 ring-green-600/40 dark:bg-stone-700 dark:border-green-400 dark:ring-green-400/50';

const slotButtons = PALETTE.map((b, i) => {
  const slot = document.createElement('button');
  slot.type = 'button';
  slot.title = b.name;
  slot.setAttribute('aria-label', b.name);
  slot.innerHTML = cubeSvg(b, 28);
  slot.addEventListener('click', () => selectSlot(i));
  hotbarEl.appendChild(slot);
  return slot;
});

function selectSlot(i) {
  selected = i;
  slotButtons.forEach((s, j) => {
    s.className = SLOT_CLASSES + (j === selected ? SLOT_SELECTED : SLOT_UP);
    s.setAttribute('aria-pressed', j === selected ? 'true' : 'false');
  });
  blockNameEl.textContent = PALETTE[selected].name;
}
selectSlot(0);

// ------------------------------------------------------------ place/break ----
// Edits are applied locally and rendered immediately, then confirmed by the
// next sync; the server is authoritative, so a rejected or overwritten edit
// corrects itself within about a second.

async function edit(x, y, z, type) {
  const k = keyOf(x, y, z);
  const prev = world.get(k);
  pending.add(k);
  if (type === 'air') world.delete(k);
  else world.set(k, type);
  meshesDirty = true;

  try {
    const res = await fetch('/api/blocks', {
      method: 'POST',
      headers: { ...apiHeaders, 'Content-Type': 'application/json' },
      body: JSON.stringify({ x, y, z, type }),
    });
    if (res.status === 401) {
      setExpired();
      revert();
    } else if (!res.ok) {
      // Out of bounds, unknown type, or a race the server refused: put the
      // cell back so the view matches the world again.
      revert();
    }
  } catch {
    revert();
  }
  pending.delete(k);

  function revert() {
    if (prev === undefined) {
      if (world.get(k) === type) world.delete(k);
    } else if (world.get(k) === type) {
      world.set(k, prev);
    }
    meshesDirty = true;
  }
}

function place() {
  const hit = aim();
  // Inside a block (no face) or aiming at nothing: nothing to do.
  if (!hit || (hit.nx === 0 && hit.ny === 0 && hit.nz === 0)) return;
  const x = hit.x + hit.nx, y = hit.y + hit.ny, z = hit.z + hit.nz;
  if (!inBounds(x, y, z)) return;
  // Occupied after a race — the aim ray would not have reached an empty
  // cell otherwise. No request; the next sync reconciles.
  if (world.has(keyOf(x, y, z))) return;
  edit(x, y, z, PALETTE[selected].type);
}

function breakBlock() {
  const hit = aim();
  if (!hit) return;
  edit(hit.x, hit.y, hit.z, 'air');
}

// ----------------------------------------------------------------- sync ----
let serverTime = null;
let loaded = false;
let expired = false;
let pollInFlight = false;

function setExpired() {
  expired = true;
  hideOverlay();
  crosshair.classList.add('hidden');
  expiredEl.classList.remove('hidden');
  if (document.pointerLockElement) document.exitPointerLock();
}

function applyRows(rows) {
  let changed = false;
  for (const [x, y, z, type] of rows) {
    const k = keyOf(x, y, z);
    if (pending.has(k)) continue; // an edit of ours is still in flight
    if (type === 'air') {
      if (world.has(k)) { world.delete(k); changed = true; }
    } else if (world.get(k) !== type) {
      world.set(k, type);
      changed = true;
    }
  }
  if (changed) meshesDirty = true;
  return changed;
}

async function poll() {
  if (expired || pollInFlight) return;
  pollInFlight = true;
  try {
    const url = serverTime
      ? '/api/blocks?since=' + encodeURIComponent(serverTime)
      : '/api/blocks';
    const res = await fetch(url, { headers: apiHeaders });
    if (res.status === 401) return setExpired();
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const data = await res.json();
    const first = serverTime === null;
    applyRows(data.blocks);
    // The server's clock, not ours: echoing this back is what keeps clock
    // skew from skipping or replaying changes.
    serverTime = data.serverTime;
    if (first) {
      loaded = true;
      if (isTouch) {
        hideOverlay();
        crosshair.classList.add('hidden');
        hotbarEl.parentElement.classList.add('hidden');
        blockNameEl.classList.add('hidden');
        touchCard.classList.remove('hidden');
      } else if (!expired) {
        showOverlay('Click to build', 'Your mouse will steer the camera.', true);
      }
    }
  } catch (err) {
    console.warn('sync failed: ' + err.message);
    if (!loaded) showOverlay("Couldn't load the world", 'Retrying…', false);
  } finally {
    pollInFlight = false;
  }
}

setInterval(poll, POLL_MS);
// While the tab is hidden the interval idles; on return, catch up with the
// accumulated `since` right away.
document.addEventListener('visibilitychange', () => {
  if (!document.hidden) poll();
});

// ------------------------------------------------------------- the loop ----
if (token) {
  showOverlay('Loading the world…', '', false);
  poll();
} else {
  // The shell never embedded the app (no ?token=…), so every API call
  // would 401. Say so instead of firing doomed requests on a timer.
  setExpired();
}

const timer = new THREE.Timer();
function frame() {
  requestAnimationFrame(frame);
  timer.update();
  const dt = Math.min(timer.getDelta(), 0.1);
  if (locked) move(dt);
  updateHighlight();
  if (meshesDirty) {
    meshesDirty = false;
    rebuildMeshes();
  }
  renderer.render(scene, camera);
}
frame();

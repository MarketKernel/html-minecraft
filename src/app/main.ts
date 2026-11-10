/**
 * The game: screens, input, the player, streaming chunks in and out around
 * them, TNT, particles, saving — and the loop that runs it all every frame.
 */
import { B, BLOCKS, FACE_TILE, isLiquid, isReplaceable, isTargetable, SHAPE, SHAPE_CROSS, SOLID } from '../core/blocks';
import { lookDirection, perspective, viewMatrix } from '../core/math';
import { meshChunk } from '../core/mesher';
import { hashString } from '../core/noise';
import { BODY_HEIGHT, collides, EYE_HEIGHT, HALF_WIDTH, newBody, step, type Body } from '../core/physics';
import { raycast, type Hit } from '../core/raycast';
import { applyEdits, encodeEdits, parseSave, type SaveData } from '../core/save';
import { BIOME_NAMES, CHUNK, HEIGHT } from '../core/terrain';
import { paintTiles } from '../core/textures';
import { chunkKey, keyX, keyZ, World } from '../core/world';
import { Sound } from './audio';
import { blockIcons } from './icons';
import { type Particle, Renderer, skyColors } from './renderer';
import { applyUpdate, justUpdated, startUpdates } from './update';

const SAVE_KEY = 'blockcraft.world.v1';
const SETTINGS_KEY = 'blockcraft.settings.v1';
/** Seconds in a full day. */
const DAY_LENGTH = 600;
const REACH = 6;
const DEFAULT_HOTBAR: number[] = [B.GRASS, B.COBBLE, B.PLANKS, B.LOG, B.GLASS, B.BRICK, B.GLOWSTONE, B.TNT, B.PUMPKIN];
const SPLASHES = [
  'One file!', 'No internet required!', 'Now with TNT!', '100% hand-painted pixels!', 'Made of cubes!',
  'Try pressing T!', 'Also try F to fly!', 'Square sun!', 'Synthesised music!', 'Glowstone glows!', 'Seeded!',
];

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

// ---------------------------------------------------------------- settings

interface Settings {
  renderDistance: number;
  fov: number;
  sound: boolean;
  music: boolean;
}

function loadSettings(): Settings {
  const defaults: Settings = { renderDistance: 8, fov: 75, sound: true, music: true };
  try {
    const raw = JSON.parse(localStorage.getItem(SETTINGS_KEY) ?? '{}') as Partial<Settings>;
    return {
      renderDistance: Number.isInteger(raw.renderDistance) && raw.renderDistance! >= 3 && raw.renderDistance! <= 16 ? raw.renderDistance! : defaults.renderDistance,
      fov: Number.isFinite(raw.fov) && raw.fov! >= 50 && raw.fov! <= 110 ? raw.fov! : defaults.fov,
      sound: typeof raw.sound === 'boolean' ? raw.sound : defaults.sound,
      music: typeof raw.music === 'boolean' ? raw.music : defaults.music,
    };
  } catch {
    return defaults;
  }
}

const settings = loadSettings();
const storeSettings = () => {
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
  } catch {
    // Private mode: settings last until the tab closes.
  }
};

// ---------------------------------------------------------------- set-up

const tiles = paintTiles();
const canvas = $<HTMLCanvasElement>('view');
let renderer: Renderer;
try {
  renderer = new Renderer(canvas, tiles);
} catch (error) {
  $('nogl').hidden = false;
  throw error;
}
const icons = blockIcons(tiles);
const sound = new Sound();
sound.sfxOn = settings.sound;
sound.musicOn = settings.music;

// ---------------------------------------------------------------- state

type Mode = 'title' | 'play' | 'pause' | 'inventory';
let mode: Mode = 'title';
let world!: World;
let body: Body = newBody(0, 80, 0);
let yaw = 0;
let pitch = -0.2;
let dayTime = 0.03;
let hotbar: number[] = [...DEFAULT_HOTBAR];
let slot = 0;
let spawn: [number, number] = [0, 0];
/** The player stands in the world: at the saved spot, or on the ground at the spawn. */
let placed = false;
/** This world has been played in, so the title screen offers to continue. */
let played = false;
let ready = false;
let saveDirty = false;
let lastSave = 0;
let time = 0;
let shake = 0;
let swing = 0;
let bobPhase = 0;
let stepDistance = 0;
let debug = false;
let target: Hit | null = null;
const meshed = new Set<number>();
const dirty = new Set<number>();
const primed = new Map<string, { x: number; y: number; z: number; fuse: number }>();
const particles: Particle[] = [];
const keys = new Set<string>();

/** Chunk offsets, nearest first, out to the furthest render distance. */
const OFFSETS: [number, number, number][] = [];
for (let dx = -18; dx <= 18; dx++) for (let dz = -18; dz <= 18; dz++) OFFSETS.push([dx, dz, dx * dx + dz * dz]);
OFFSETS.sort((a, b) => a[2] - b[2]);

// ---------------------------------------------------------------- the world

function startWorld(seed: number, data: SaveData | null): void {
  renderer.clearChunks();
  meshed.clear();
  dirty.clear();
  primed.clear();
  particles.length = 0;
  world = new World(seed);
  if (data) applyEdits(world, data.edits);
  world.onChange = blockChanged;
  spawn = world.terrain.findSpawn();
  if (data?.player) {
    const p = data.player;
    body = newBody(p.x, p.y, p.z);
    body.flying = p.flying;
    yaw = p.yaw;
    pitch = p.pitch;
    placed = true;
  } else {
    body = newBody(spawn[0] + 0.5, 100, spawn[1] + 0.5);
    yaw = 0;
    pitch = -0.1;
    placed = false;
  }
  dayTime = data?.time ?? 0.03;
  hotbar = data ? [...data.hotbar] : [...DEFAULT_HOTBAR];
  slot = data?.slot ?? 0;
  ready = false;
  played = !!data?.player;
  saveDirty = !data;
  renderHotbar();
}

function saveGame(): void {
  if (!world || !placed) return;
  const data: SaveData = {
    version: 1,
    seed: world.seed,
    time: dayTime,
    player: { x: body.x, y: body.y, z: body.z, yaw, pitch, flying: body.flying },
    hotbar,
    slot,
    edits: encodeEdits(world),
  };
  try {
    localStorage.setItem(SAVE_KEY, JSON.stringify(data));
    saveDirty = false;
  } catch {
    toast('Could not save: the browser refused the storage');
  }
  lastSave = time;
}

/** Where chunks are loaded around: the player, or the spawn until they stand somewhere. */
function focus(): [number, number] {
  return placed ? [body.x, body.z] : [spawn[0], spawn[1]];
}

/** A changed block shows in its chunk and, through light and shade, in the neighbours on its side. */
function blockChanged(x: number, _y: number, z: number): void {
  const cx = x >> 4;
  const cz = z >> 4;
  const nx = (x & 15) < 8 ? -1 : 1;
  const nz = (z & 15) < 8 ? -1 : 1;
  for (const [dx, dz] of [[0, 0], [nx, 0], [0, nz], [nx, nz]] as const) {
    const key = chunkKey(cx + dx, cz + dz);
    if (meshed.has(key)) dirty.add(key);
  }
  saveDirty = true;
}

function remesh(key: number): boolean {
  const cx = keyX(key);
  const cz = keyZ(key);
  const mesh = meshChunk(world, cx, cz);
  if (!mesh) return false;
  renderer.setChunk(key, cx, cz, mesh);
  meshed.add(key);
  dirty.delete(key);
  return true;
}

/** Generates and meshes chunks nearest first, until the time is up. */
function stream(deadline: number): void {
  const [fx, fz] = focus();
  const pcx = Math.floor(fx / CHUNK);
  const pcz = Math.floor(fz / CHUNK);
  const rd = settings.renderDistance;
  if (dirty.size) {
    const near = [...dirty].sort((a, b) => Math.hypot(keyX(a) - pcx, keyZ(a) - pcz) - Math.hypot(keyX(b) - pcx, keyZ(b) - pcz));
    for (const key of near) {
      if (!world.chunks.has(key)) dirty.delete(key);
      else remesh(key);
      if (performance.now() > deadline) return;
    }
  }
  for (const [dx, dz, d2] of OFFSETS) {
    if (d2 > rd * rd) break;
    const cx = pcx + dx;
    const cz = pcz + dz;
    const key = chunkKey(cx, cz);
    if (meshed.has(key)) continue;
    for (let nx = -1; nx <= 1; nx++) for (let nz = -1; nz <= 1; nz++) world.ensure(cx + nx, cz + nz);
    remesh(key);
    if (performance.now() > deadline) return;
  }
}

function unloadFar(): void {
  const [fx, fz] = focus();
  const pcx = Math.floor(fx / CHUNK);
  const pcz = Math.floor(fz / CHUNK);
  const keep = settings.renderDistance + 3;
  for (const key of [...world.chunks.keys()]) {
    if (Math.max(Math.abs(keyX(key) - pcx), Math.abs(keyZ(key) - pcz)) <= keep) continue;
    world.unload(key);
    renderer.removeChunk(key);
    meshed.delete(key);
    dirty.delete(key);
  }
}

/** How much of the spawn area is ready, 0–1. */
function loadProgress(): number {
  const [fx, fz] = focus();
  const pcx = Math.floor(fx / CHUNK);
  const pcz = Math.floor(fz / CHUNK);
  let done = 0;
  let all = 0;
  for (let dx = -2; dx <= 2; dx++) {
    for (let dz = -2; dz <= 2; dz++) {
      all++;
      if (meshed.has(chunkKey(pcx + dx, pcz + dz))) done++;
    }
  }
  return done / all;
}

// ---------------------------------------------------------------- acting on blocks

function eye(): [number, number, number] {
  return [body.x, body.y + EYE_HEIGHT, body.z];
}

function findTarget(): Hit | null {
  const [ex, ey, ez] = eye();
  const [dx, dy, dz] = lookDirection(yaw, pitch);
  return raycast((x, y, z) => world.get(x, y, z), ex, ey, ez, dx, dy, dz, REACH, isTargetable);
}

function skyBrightness(): number {
  return 0.35 + 0.65 * skyColors(dayTime).day;
}

function burst(x: number, y: number, z: number, id: number, count: number, speed = 3): void {
  const layer = FACE_TILE[id * 6]!;
  const light = BLOCKS[id]!.emit ? 1 : skyBrightness();
  for (let i = 0; i < count && particles.length < 900; i++) {
    particles.push({
      x: x + Math.random(),
      y: y + Math.random(),
      z: z + Math.random(),
      vx: (Math.random() - 0.5) * speed,
      vy: Math.random() * speed + 1,
      vz: (Math.random() - 0.5) * speed,
      life: 0.6 + Math.random() * 0.7,
      size: 0.09 + Math.random() * 0.08,
      layer,
      u: Math.floor(Math.random() * 4) / 4,
      v: Math.floor(Math.random() * 4) / 4,
      light,
    });
  }
}

/** Remeshes the chunk of a block right away, so a click shows on the very next frame. */
function remeshNow(x: number, z: number): void {
  const key = chunkKey(x >> 4, z >> 4);
  if (dirty.has(key)) remesh(key);
}

function breakBlock(): void {
  const hit = target;
  if (!hit || hit.id === B.BEDROCK) return;
  world.set(hit.x, hit.y, hit.z, B.AIR);
  // Plants do not float.
  const above = world.get(hit.x, hit.y + 1, hit.z);
  if (SHAPE[above] === SHAPE_CROSS) world.set(hit.x, hit.y + 1, hit.z, B.AIR);
  primed.delete(`${hit.x},${hit.y},${hit.z}`);
  burst(hit.x, hit.y, hit.z, hit.id, 18);
  sound.dig(BLOCKS[hit.id]!.material);
  remeshNow(hit.x, hit.z);
  swing = 1;
}

function useBlock(): void {
  const hit = target;
  if (!hit) return;
  if (hit.id === B.TNT) {
    prime(hit.x, hit.y, hit.z, 3);
    swing = 1;
    return;
  }
  const x = hit.x + hit.nx;
  const y = hit.y + hit.ny;
  const z = hit.z + hit.nz;
  if (y < 1 || y >= HEIGHT || !isReplaceable(world.get(x, y, z))) return;
  const id = hotbar[slot]!;
  if (SOLID[id]) {
    // Not into the player.
    const overlaps = body.x + HALF_WIDTH > x && body.x - HALF_WIDTH < x + 1 && body.z + HALF_WIDTH > z && body.z - HALF_WIDTH < z + 1 && body.y + BODY_HEIGHT > y && body.y < y + 1;
    if (overlaps) return;
  }
  if (world.set(x, y, z, id)) {
    sound.place(BLOCKS[id]!.material);
    remeshNow(x, z);
    swing = 1;
  }
}

function pickBlock(): void {
  if (!target || !BLOCKS[target.id]!.placeable) return;
  const at = hotbar.indexOf(target.id);
  if (at >= 0) slot = at;
  else hotbar[slot] = target.id;
  renderHotbar();
}

// ---------------------------------------------------------------- TNT

function prime(x: number, y: number, z: number, fuse: number): void {
  const key = `${x},${y},${z}`;
  if (primed.has(key)) return;
  primed.set(key, { x, y, z, fuse });
  sound.fuse();
}

function explode(x: number, y: number, z: number): void {
  const R = 4;
  world.set(x, y, z, B.AIR);
  let debris = 0;
  for (let dx = -R; dx <= R; dx++) {
    for (let dy = -R; dy <= R; dy++) {
      for (let dz = -R; dz <= R; dz++) {
        const d = Math.hypot(dx, dy, dz);
        if (d > R - 0.6 + Math.random() * 0.9) continue;
        const bx = x + dx;
        const by = y + dy;
        const bz = z + dz;
        const id = world.get(bx, by, bz);
        if (id === B.AIR || id === B.BEDROCK || isLiquid(id)) continue;
        if (id === B.TNT) {
          prime(bx, by, bz, 0.25 + Math.random() * 0.5);
          continue;
        }
        world.set(bx, by, bz, B.AIR);
        if (debris++ % 3 === 0) burst(bx, by, bz, id, 2, 9);
      }
    }
  }
  // Fire and smoke.
  burst(x - 0.5, y - 0.5, z - 0.5, B.LAVA, 40, 12);
  burst(x - 0.5, y, z - 0.5, B.COBBLE, 30, 7);
  const [ex, ey, ez] = eye();
  const distance = Math.hypot(ex - x - 0.5, ey - y - 0.5, ez - z - 0.5);
  sound.boom(distance);
  shake = Math.max(shake, Math.max(0, 1 - distance / 32));
  if (distance < 7) {
    const push = (7 - distance) * 2.5;
    body.vx += ((body.x - x - 0.5) / Math.max(distance, 0.5)) * push;
    body.vz += ((body.z - z - 0.5) / Math.max(distance, 0.5)) * push;
    body.vy += push * 0.8;
    body.onGround = false;
  }
  remeshNow(x, z);
}

function updateTnt(dt: number): void {
  for (const [key, t] of [...primed]) {
    if (world.get(t.x, t.y, t.z) !== B.TNT) {
      primed.delete(key);
      continue;
    }
    t.fuse -= dt;
    if (t.fuse > 0) continue;
    primed.delete(key);
    explode(t.x, t.y, t.z);
  }
}

function updateParticles(dt: number): void {
  for (let i = particles.length - 1; i >= 0; i--) {
    const p = particles[i]!;
    p.life -= dt;
    if (p.life <= 0) {
      particles[i] = particles[particles.length - 1]!;
      particles.pop();
      continue;
    }
    p.vy -= 20 * dt;
    const nx = p.x + p.vx * dt;
    const ny = p.y + p.vy * dt;
    const nz = p.z + p.vz * dt;
    if (SOLID[world.get(Math.floor(nx), Math.floor(ny), Math.floor(nz))]) {
      p.vy *= -0.25;
      p.vx *= 0.5;
      p.vz *= 0.5;
    } else {
      p.x = nx;
      p.y = ny;
      p.z = nz;
    }
  }
}

// ---------------------------------------------------------------- the player

let lastSpace = 0;
let wasInWater = false;

function updatePlayer(dt: number): void {
  const forward = (keys.has('KeyW') || keys.has('ArrowUp') ? 1 : 0) - (keys.has('KeyS') || keys.has('ArrowDown') ? 1 : 0);
  const strafe = (keys.has('KeyD') || keys.has('ArrowRight') ? 1 : 0) - (keys.has('KeyA') || keys.has('ArrowLeft') ? 1 : 0);
  const sprint = keys.has('ControlLeft') || keys.has('ControlRight') || keys.has('KeyR');
  const bumped = step((x, y, z) => world.get(x, y, z), body, { forward, strafe, jump: keys.has('Space'), descend: keys.has('ShiftLeft') || keys.has('ShiftRight'), sprint, yaw }, dt);
  // Walking into a one-block step hops onto it.
  if (bumped && !body.flying && !body.inWater) body.vy = 8.2;
  if (body.y < -30) {
    body.y = world.top(Math.floor(body.x), Math.floor(body.z)) + 2;
    body.vy = 0;
  }
  if (body.inWater && !wasInWater && body.vy < -4) sound.splash();
  wasInWater = body.inWater;
  const speed = Math.hypot(body.vx, body.vz);
  if (body.onGround && speed > 0.5) {
    bobPhase += speed * dt * 1.9;
    stepDistance += speed * dt;
    if (stepDistance > 2.1) {
      stepDistance = 0;
      sound.step(BLOCKS[world.get(Math.floor(body.x), Math.floor(body.y - 0.1), Math.floor(body.z))]!.material);
    }
  }
  if (mouseHeld >= 0 && time >= mouseRepeat) {
    mouseRepeat = time + 0.22;
    if (mouseHeld === 0) breakBlock();
    else if (mouseHeld === 2) useBlock();
  }
}

// ---------------------------------------------------------------- screens

function setMode(next: Mode): void {
  mode = next;
  $('menu').hidden = next !== 'title';
  $('pause').hidden = next !== 'pause';
  $('inventory').hidden = next !== 'inventory';
  document.body.classList.toggle('playing', next === 'play');
  document.body.classList.toggle('in-game', next !== 'title');
  if (next !== 'play') {
    keys.clear();
    mouseHeld = -1;
  }
}

function lockPointer(): void {
  try {
    const request = canvas.requestPointerLock() as unknown as Promise<void> | undefined;
    request?.catch?.(() => undefined);
  } catch {
    // Pointer lock refused (a frame, a test): play on without it.
  }
}

function play(): void {
  sound.unlock();
  played = true;
  setMode('play');
  lockPointer();
}

function pause(): void {
  if (mode !== 'play') return;
  setMode('pause');
  saveGame();
}

function toTitle(): void {
  saveGame();
  setMode('title');
  updateTitle();
  if (document.pointerLockElement) document.exitPointerLock();
}

function openInventory(): void {
  setMode('inventory');
  if (document.pointerLockElement) document.exitPointerLock();
}

function updateTitle(): void {
  $('play').textContent = played ? 'Continue' : 'Play';
  $('world-info').textContent = `Seed ${world.seed}`;
}

let toastTimer = 0;
function toast(text: string): void {
  const t = $('toast');
  t.textContent = text;
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => t.classList.remove('show'), 1800);
}

let nameTimer = 0;
function renderHotbar(): void {
  const bar = $('hotbar');
  bar.replaceChildren(
    ...hotbar.map((id, i) => {
      const cell = document.createElement('div');
      cell.className = 'slot' + (i === slot ? ' selected' : '');
      const img = document.createElement('img');
      img.src = icons[id]!;
      img.alt = BLOCKS[id]!.name;
      const n = document.createElement('span');
      n.textContent = String(i + 1);
      cell.append(img, n);
      cell.addEventListener('click', () => selectSlot(i));
      return cell;
    }),
  );
  const name = $('blockname');
  name.textContent = BLOCKS[hotbar[slot]!]!.name;
  name.classList.add('show');
  clearTimeout(nameTimer);
  nameTimer = window.setTimeout(() => name.classList.remove('show'), 1400);
}

function selectSlot(i: number): void {
  slot = (i + hotbar.length) % hotbar.length;
  renderHotbar();
  saveDirty = true;
}

function buildInventory(): void {
  const grid = $('grid');
  for (const block of BLOCKS) {
    if (!block.placeable) continue;
    const b = document.createElement('button');
    b.className = 'item';
    b.title = block.name;
    const img = document.createElement('img');
    img.src = icons[block.id]!;
    img.alt = block.name;
    b.append(img);
    b.addEventListener('click', () => {
      hotbar[slot] = block.id;
      sound.unlock();
      sound.click();
      renderHotbar();
      saveDirty = true;
    });
    grid.append(b);
  }
}

function bindSettings(): void {
  const distance = $<HTMLInputElement>('distance');
  const fov = $<HTMLInputElement>('fov');
  const sfx = $<HTMLInputElement>('sfx');
  const music = $<HTMLInputElement>('music');
  const show = () => {
    $('distance-value').textContent = `${settings.renderDistance} chunks`;
    $('fov-value').textContent = `${settings.fov}°`;
  };
  distance.value = String(settings.renderDistance);
  fov.value = String(settings.fov);
  sfx.checked = settings.sound;
  music.checked = settings.music;
  show();
  distance.addEventListener('input', () => {
    settings.renderDistance = Number(distance.value);
    show();
    storeSettings();
  });
  fov.addEventListener('input', () => {
    settings.fov = Number(fov.value);
    show();
    storeSettings();
  });
  sfx.addEventListener('change', () => {
    settings.sound = sound.sfxOn = sfx.checked;
    storeSettings();
  });
  music.addEventListener('change', () => {
    settings.music = sound.musicOn = music.checked;
    storeSettings();
  });
}

function seedFrom(text: string): number {
  const t = text.trim();
  if (!t) return Math.floor(Math.random() * 2 ** 31);
  return /^-?\d+$/.test(t) ? Number(t) | 0 : hashString(t) | 0;
}

// ---------------------------------------------------------------- input

let mouseHeld = -1;
let mouseRepeat = 0;

addEventListener('keydown', (e) => {
  if ((e.target as HTMLElement).tagName === 'INPUT' && (e.target as HTMLInputElement).type === 'text') return;
  if (mode === 'play') {
    keys.add(e.code);
    if (e.code.startsWith('Digit') && e.code !== 'Digit0') selectSlot(Number(e.code.slice(5)) - 1);
    else if (e.code === 'KeyE') openInventory();
    else if (e.code === 'KeyF') {
      body.flying = !body.flying;
      toast(body.flying ? 'Flying' : 'Walking');
    } else if (e.code === 'F3') debug = !debug;
    else if (e.code === 'KeyM') {
      settings.music = sound.musicOn = !sound.musicOn;
      $<HTMLInputElement>('music').checked = settings.music;
      storeSettings();
      toast(sound.musicOn ? 'Music on' : 'Music off');
    } else if (e.code === 'Escape' && !document.pointerLockElement) pause();
    else if (e.code === 'Space' && !e.repeat) {
      if (time - lastSpace < 0.3) body.flying = !body.flying;
      lastSpace = time;
    }
    if (['Space', 'F3', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(e.code) || e.ctrlKey) e.preventDefault();
  } else if (mode === 'inventory') {
    if (e.code === 'KeyE' || e.code === 'Escape') play();
    else if (e.code.startsWith('Digit') && e.code !== 'Digit0') selectSlot(Number(e.code.slice(5)) - 1);
  } else if (mode === 'pause' && e.code === 'Escape') play();
});
addEventListener('keyup', (e) => keys.delete(e.code));
addEventListener('blur', () => keys.clear());

addEventListener('mousemove', (e) => {
  if (mode !== 'play' || document.pointerLockElement !== canvas) return;
  const k = 0.0024;
  yaw -= e.movementX * k;
  pitch = Math.max(-1.55, Math.min(1.55, pitch - e.movementY * k));
});
canvas.addEventListener('mousedown', (e) => {
  if (mode !== 'play') return;
  sound.unlock();
  // The click that takes the mouse back only takes the mouse.
  if (!document.pointerLockElement && 'requestPointerLock' in canvas) {
    lockPointer();
    return;
  }
  if (e.button === 1) {
    e.preventDefault();
    pickBlock();
    return;
  }
  mouseHeld = e.button;
  mouseRepeat = time + 0.3;
  if (e.button === 0) breakBlock();
  else if (e.button === 2) useBlock();
});
addEventListener('mouseup', () => (mouseHeld = -1));
canvas.addEventListener('contextmenu', (e) => e.preventDefault());
addEventListener(
  'wheel',
  (e) => {
    if (mode !== 'play' && mode !== 'inventory') return;
    selectSlot(slot + Math.sign(e.deltaY));
  },
  { passive: true },
);
document.addEventListener('pointerlockchange', () => {
  if (!document.pointerLockElement && mode === 'play') pause();
});
addEventListener('pagehide', () => saveGame());
addEventListener('visibilitychange', () => document.hidden && saveGame());

$('play').addEventListener('click', play);
$('new').addEventListener('click', () => {
  startWorld(seedFrom($<HTMLInputElement>('seed').value), null);
  $<HTMLInputElement>('seed').value = '';
  play();
});
$('resume').addEventListener('click', play);
$('quit').addEventListener('click', toTitle);
$('inventory').addEventListener('click', (e) => e.target === e.currentTarget && play());
for (const button of document.querySelectorAll<HTMLButtonElement>('[data-update]')) {
  button.addEventListener('click', () => {
    saveGame();
    applyUpdate();
  });
}

// ---------------------------------------------------------------- the loop

let last = performance.now();
let fps = 0;
let frames = 0;
let fpsTime = 0;
let unloadTimer = 0;

function frame(now: number): void {
  const dt = Math.min(0.05, (now - last) / 1000);
  last = now;
  time += dt;
  frames++;
  if (time - fpsTime >= 1) {
    fps = frames;
    frames = 0;
    fpsTime = time;
  }
  const active = mode === 'play' || mode === 'inventory';
  const timeScale = active && keys.has('KeyT') ? 60 : 1;
  if (mode !== 'pause') dayTime = (dayTime + (dt / DAY_LENGTH) * timeScale) % 1;

  // Stand the player on the ground once their spawn chunk is there.
  if (!placed && world.has(Math.floor(spawn[0] / CHUNK), Math.floor(spawn[1] / CHUNK))) {
    body.y = world.top(spawn[0], spawn[1]) + 1;
    placed = true;
    updateTitle();
  }
  const progress = loadProgress();
  ready = placed && progress === 1;
  if (ready && mode === 'play') updatePlayer(dt);
  if (placed && collides((x, y, z) => world.get(x, y, z), body.x, body.y, body.z) && !ready) body.y += 1;
  if (mode !== 'pause') {
    updateTnt(dt);
    updateParticles(dt);
  }
  swing = Math.max(0, swing - dt * 4);
  shake = Math.max(0, shake - dt * 1.6);

  stream(performance.now() + (mode === 'play' && ready ? 6 : 14));
  if ((unloadTimer += dt) > 1) {
    unloadTimer = 0;
    unloadFar();
  }

  // The camera: circling over the land on the title screen, the player's eyes in the game.
  let cx: number;
  let cy: number;
  let cz: number;
  let cyaw = yaw;
  let cpitch = pitch;
  if (mode === 'title') {
    const [fx, fz] = focus();
    const a = time * 0.05;
    const ground = placed ? Math.max(world.top(Math.floor(fx), Math.floor(fz)), 50) : 70;
    cx = fx + Math.cos(a) * 34;
    cz = fz + Math.sin(a) * 34;
    cy = ground + 22;
    const dx = fx - cx;
    const dz = fz - cz;
    cyaw = Math.atan2(-dx, -dz);
    cpitch = -Math.atan2(cy - ground, Math.hypot(dx, dz));
  } else {
    const speed = Math.hypot(body.vx, body.vz);
    const bob = body.onGround && !body.flying ? Math.sin(bobPhase * 2) * 0.05 * Math.min(1, speed / 4) : 0;
    [cx, cy, cz] = eye();
    cy += bob;
    if (shake) {
      cx += (Math.random() - 0.5) * shake * 0.5;
      cy += (Math.random() - 0.5) * shake * 0.5;
      cz += (Math.random() - 0.5) * shake * 0.5;
    }
  }
  target = mode === 'play' && ready ? findTarget() : null;
  const underwater = isLiquid(world.get(Math.floor(cx), Math.floor(cy), Math.floor(cz)));
  const sprinting = mode === 'play' && (keys.has('ControlLeft') || keys.has('KeyR')) && Math.hypot(body.vx, body.vz) > 5;
  const aspect = canvas.clientWidth / Math.max(1, canvas.clientHeight);
  const fov = ((settings.fov + (sprinting ? 8 : 0)) * Math.PI) / 180;
  renderer.render({
    view: viewMatrix(cx, cy, cz, cyaw, cpitch),
    proj: perspective(fov, aspect, 0.05, 1200),
    cam: [cx, cy, cz],
    time,
    dayTime,
    renderDistance: settings.renderDistance,
    underwater,
    target: target ? [target.x, target.y, target.z] : null,
    flashes: [...primed.values()].map((t) => ({ x: t.x, y: t.y, z: t.z, on: Math.floor(t.fuse * (t.fuse < 1 ? 8 : 4)) % 2 === 0 })),
    particles,
    hand: mode === 'title' ? null : { id: hotbar[slot]!, swing, bob: Math.sin(bobPhase) * 0.03 * Math.min(1, Math.hypot(body.vx, body.vz) / 4) },
  });

  // HUD.
  document.body.classList.toggle('underwater', underwater && mode !== 'title');
  const loading = $('loading');
  loading.hidden = ready || mode === 'title';
  if (!ready) ($('loading-bar').style.width = `${Math.round(progress * 100)}%`);
  const dbg = $('debug');
  dbg.hidden = !debug || mode === 'title';
  if (debug) {
    world.terrain.column(Math.floor(body.x), Math.floor(body.z));
    const hours = Math.floor((dayTime * 24 + 6) % 24);
    dbg.textContent = [
      `Blockcraft ${__APP_VERSION__}  ${fps} fps`,
      `XYZ ${body.x.toFixed(1)} / ${body.y.toFixed(1)} / ${body.z.toFixed(1)}`,
      `Chunk ${Math.floor(body.x / CHUNK)}, ${Math.floor(body.z / CHUNK)}  ·  ${BIOME_NAMES[world.terrain.biome]}`,
      `Drawn ${renderer.stats.chunks} chunks, ${renderer.stats.quads} quads  ·  loaded ${world.chunks.size}`,
      `Time ${String(hours).padStart(2, '0')}:00  ·  seed ${world.seed}`,
      target ? `Looking at ${BLOCKS[target.id]!.name} (${target.x}, ${target.y}, ${target.z})` : '',
    ].join('\n');
  }
  sound.tick();
  if (mode === 'play' && saveDirty && time - lastSave > 15) saveGame();
  requestAnimationFrame(frame);
}

// ---------------------------------------------------------------- start

let saved: SaveData | null = null;
try {
  saved = parseSave(localStorage.getItem(SAVE_KEY), DEFAULT_HOTBAR);
} catch {
  saved = null;
}
startWorld(saved?.seed ?? Math.floor(Math.random() * 2 ** 31), saved);
buildInventory();
bindSettings();
$('splash').textContent = SPLASHES[Math.floor(Math.random() * SPLASHES.length)]!;
$('version').textContent = `v${__APP_VERSION__}`;
setMode('title');
updateTitle();
requestAnimationFrame(frame);
if (justUpdated()) toast(`Updated to v${__APP_VERSION__}`);
// Only in the installed game (build/pages/): a new deploy waits for the player to say when.
startUpdates((version) => {
  for (const button of document.querySelectorAll<HTMLButtonElement>('[data-update]')) {
    button.textContent = version ? `Update to v${version}` : 'Update to the new version';
    button.hidden = false;
  }
});

/** A handle for tests and the curious, from the console. */
Object.assign(window, {
  blockcraft: {
    get state() {
      return {
        mode, ready, placed, seed: world.seed, x: body.x, y: body.y, z: body.z, yaw, pitch, flying: body.flying, onGround: body.onGround,
        dayTime, chunks: renderer.chunkCount, drawn: renderer.stats, slot, hotbar: [...hotbar], primed: primed.size, edits: world.editCount,
        target: target && { x: target.x, y: target.y, z: target.z, id: target.id },
      };
    },
    play,
    pause,
    toTitle,
    newWorld: (seed: number) => startWorld(seed, null),
    look(y: number, p: number) {
      yaw = y;
      pitch = p;
    },
    teleport(x: number, y: number, z: number) {
      body.x = x;
      body.y = y;
      body.z = z;
      body.vx = body.vy = body.vz = 0;
    },
    setTime: (t: number) => (dayTime = t),
    fly: (on: boolean) => (body.flying = on),
    get: (x: number, y: number, z: number) => world.get(x, y, z),
    set: (x: number, y: number, z: number, id: number) => world.set(x, y, z, id),
    top: (x: number, z: number) => world.top(x, z),
    breakTarget: () => ((target = findTarget()), breakBlock()),
    useTarget: () => ((target = findTarget()), useBlock()),
    selectSlot,
    save: saveGame,
  },
});

/** The mesher: which faces show, ambient occlusion, light, and how fast. */
import { checker, load } from '../tools/load.mjs';

const { check, done } = checker();
const C = await load('core/mesher', 'core/blocks', 'core/terrain', 'core/world');

/** A world of 3×3 empty chunks, with blocks put in by hand. */
function emptyWorld() {
  const chunks = new Map();
  for (let x = -1; x <= 1; x++) for (let z = -1; z <= 1; z++) chunks.set(`${x},${z}`, new Uint8Array(16 * 16 * 128));
  return {
    chunk: (x, z) => chunks.get(`${x},${z}`),
    set(x, y, z, id) {
      chunks.get(`${x >> 4},${z >> 4}`)[C.index(x & 15, y, z & 15)] = id;
    },
  };
}
const VB = C.VERTEX_BYTES;
/** Vertices as objects. */
function vertices(bytes) {
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const out = [];
  for (let o = 0; o < bytes.length; o += VB) {
    out.push({ x: v.getInt16(o, true), y: v.getInt16(o + 2, true), z: v.getInt16(o + 4, true), layer: bytes[o + 10], flags: bytes[o + 11], shade: bytes[o + 12], sky: bytes[o + 13], block: bytes[o + 14] });
  }
  return out;
}

{
  const w = emptyWorld();
  w.set(5, 60, 5, C.B.STONE);
  const m = C.meshChunk(w, 0, 0);
  check('a lone block has six faces', m.solidQuads, 6);
  check('…and no water', m.waterQuads, 0);
  check('maxY is above it', m.maxY, 61);
  const vs = vertices(m.solid);
  check('positions are in 1/16 blocks', [Math.min(...vs.map((v) => v.x)), Math.max(...vs.map((v) => v.x))], [80, 96]);
  check('out in the open, full sky light but underneath', vs.filter((v) => v.shade !== Math.round(255 * 0.55)).every((v) => v.sky === 255), true);
  check('underneath is in its shadow', vs.filter((v) => v.shade === Math.round(255 * 0.55)).every((v) => v.sky < 255), true);
  check('the top is the brightest face', Math.max(...vs.map((v) => v.shade)), 255);
}
{
  const w = emptyWorld();
  w.set(5, 60, 5, C.B.STONE);
  w.set(6, 60, 5, C.B.STONE);
  check('two blocks side by side share no face', C.meshChunk(w, 0, 0).solidQuads, 10);
  w.set(5, 61, 6, C.B.STONE);
  const vs = vertices(C.meshChunk(w, 0, 0).solid);
  const top = vs.filter((v) => v.y === 61 * 16 && v.x >= 80 && v.x <= 96 && v.z <= 96);
  check('a block in the corner darkens the corner next to it', Math.min(...top.map((v) => v.shade)) < 255, true);
}
{
  const w = emptyWorld();
  w.set(20, 60, 5, C.B.GLOWSTONE);
  w.set(15, 60, 5, C.B.STONE);
  const vs = vertices(C.meshChunk(w, 0, 0).solid);
  check('light from the next chunk reaches over the border', Math.max(...vs.map((v) => v.block)) > 0, true);
  w.set(8, 60, 8, C.B.GLOWSTONE);
  const glow = vertices(C.meshChunk(w, 0, 0).solid).filter((v) => v.flags & C.FLAG_EMISSIVE);
  check('glowstone is emissive', glow.length, 24);
}
{
  const w = emptyWorld();
  for (let x = 0; x < 3; x++) w.set(x, 50, 0, C.B.WATER);
  w.set(1, 49, 0, C.B.SAND);
  const m = C.meshChunk(w, 0, 0);
  check('no faces between water and water', m.waterQuads, 3 + 2 + 6 + 2); // tops, open bottoms, long sides, ends
  const tops = vertices(m.water).filter((v) => v.y % 16 !== 0);
  check('the water surface sits a little low', [...new Set(tops.map((v) => v.y))], [50 * 16 + 14]);
}
{
  const w = emptyWorld();
  w.set(3, 60, 3, C.B.TALL_GRASS);
  const m = C.meshChunk(w, 0, 0);
  check('a plant is two crossed quads, both sides', m.solidQuads, 4);
  const vs = vertices(m.solid);
  check('only its top sways', vs.filter((v) => v.flags & C.FLAG_SWAY).every((v) => v.y === 61 * 16), true);
}
check('a missing neighbour means no mesh yet', C.meshChunk({ chunk: (x) => (x === 1 ? undefined : new Uint8Array(32768)) }, 0, 0), null);
check('the block in hand: a cube', C.meshBlock(C.B.TNT).quads, 6);

// A real chunk, for size and speed.
const world = new C.World(2024);
for (let x = -1; x <= 1; x++) for (let z = -1; z <= 1; z++) world.ensure(x, z);
const t0 = performance.now();
const real = C.meshChunk(world, 0, 0);
const ms = performance.now() - t0;
check('a real chunk has a few thousand faces at most', real.solidQuads > 300 && real.solidQuads < 20000, true);
console.log(`  (real chunk: ${real.solidQuads} solid + ${real.waterQuads} water quads, ${ms.toFixed(1)} ms)`);
done('mesher');

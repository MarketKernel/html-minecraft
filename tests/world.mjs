/** Noise, terrain, the world's edits and saving them. */
import { createHash } from 'node:crypto';
import { checker, load } from '../tools/load.mjs';

const { check, done } = checker();
const C = await load('core/noise', 'core/terrain', 'core/world', 'core/save', 'core/blocks', 'core/textures');
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex').slice(0, 16);

// Noise: deterministic, roughly in [-1, 1], and not flat.
const n = new C.Noise(42);
const values = Array.from({ length: 2000 }, (_, i) => n.noise3(i * 0.37, i * 0.11, i * 0.53));
check('noise is repeatable', new C.Noise(42).noise2(3.3, 7.7), n.noise2(3.3, 7.7));
check('noise stays in range', values.every((v) => v >= -1.01 && v <= 1.01), true);
check('noise varies', Math.max(...values) - Math.min(...values) > 1, true);
check('noise is zero on the lattice', n.noise2(5, 9), 0);
check('hash3 is in [0, 1)', [1, 2, 3, 4].map((i) => C.hash3(7, i, -i, i * 3)).every((v) => v >= 0 && v < 1), true);

// Terrain: a pure function of the seed.
const t1 = new C.Terrain(1234);
const t2 = new C.Terrain(1234);
const t3 = new C.Terrain(99);
const start = performance.now();
const a = t1.generate(3, -2);
const ms = performance.now() - start;
check('same seed, same chunk', sha(a), sha(t2.generate(3, -2)));
check('another seed, another chunk', sha(a) !== sha(t3.generate(3, -2)), true);
check('bedrock at the bottom', [0, 5, 100, 255].map((col) => a[(col >> 4) * 2048 + (col & 15) * 128]), [13, 13, 13, 13].map(() => C.B.BEDROCK));
check('a chunk is generated quickly', ms < 400, true);

// Generating in another order changes nothing: no state leaks from one chunk to the next.
const order = [[0, 0], [1, 0], [0, 1], [-1, 5]];
const forward = order.map(([x, z]) => sha(t1.generate(x, z)));
const backward = [...order].reverse().map(([x, z]) => sha(t2.generate(x, z))).reverse();
check('order does not matter', forward, backward);
// A tree crown crossing a border: leaves next to a log on the edge of one chunk show up in the next.
let crossings = 0;
for (let cx = 0; cx < 12 && crossings < 3; cx++) {
  const left = t1.generate(cx, 0);
  const right = t1.generate(cx + 1, 0);
  for (let z = 1; z < 15; z++) {
    for (let y = 1; y < 120; y++) {
      if (left[C.index(15, y, z)] !== C.B.LOG || left[C.index(15, y + 2, z)] !== C.B.LOG) continue;
      crossings++;
      check('a crown reaches across the border', [C.B.LEAVES, C.B.LOG].includes(right[C.index(0, y + 3, z)]), true);
      break;
    }
  }
}

// The spawn is on dry grassland.
const [sx, sz] = t1.findSpawn();
t1.column(sx, sz);
check('spawn is above the sea', t1.height > C.SEA, true);
check('spawn is plains or forest', [C.BIOME.PLAINS, C.BIOME.FOREST].includes(t1.biome), true);

// The world: edits are kept and laid over a regenerated chunk.
const w = new C.World(1234);
w.ensure(0, 0);
const top = w.top(5, 5);
let changed = [];
w.onChange = (x, y, z) => changed.push([x, y, z]);
check('set changes a block', w.set(5, top + 1, 5, C.B.GLOWSTONE), true);
check('set twice is no change', w.set(5, top + 1, 5, C.B.GLOWSTONE), false);
check('onChange fires once', changed, [[5, top + 1, 5]]);
check('negative coordinates', (w.ensure(-1, -1), w.set(-3, 60, -7, C.B.BRICK) && w.get(-3, 60, -7)), C.B.BRICK);
w.unload(C.chunkKey(0, 0));
check('unloaded reads as air', w.get(5, top + 1, 5), C.B.AIR);
w.ensure(0, 0);
check('edits survive regeneration', w.get(5, top + 1, 5), C.B.GLOWSTONE);
check('chunk keys round-trip', [C.keyX(C.chunkKey(-5, 7)), C.keyZ(C.chunkKey(-5, 7))], [-5, 7]);

// Saving and loading.
const hotbar = [1, 2, 3, 4, 5, 6, 7, 8, 9];
const save = { version: 1, seed: 1234, time: 0.3, player: { x: 1, y: 70, z: 2, yaw: 0.5, pitch: -0.2, flying: true }, hotbar, slot: 4, edits: C.encodeEdits(w) };
const parsed = C.parseSave(JSON.stringify(save), hotbar);
check('save round-trips', parsed, save);
const w2 = new C.World(1234);
C.applyEdits(w2, parsed.edits);
w2.ensure(0, 0);
w2.ensure(-1, -1);
check('loaded edits apply', [w2.get(5, top + 1, 5), w2.get(-3, 60, -7)], [C.B.GLOWSTONE, C.B.BRICK]);
check('garbage is no save', C.parseSave('{oops', hotbar), null);
check('a wrong version is no save', C.parseSave(JSON.stringify({ ...save, version: 2 }), hotbar), null);
const broken = C.parseSave(JSON.stringify({ ...save, hotbar: [999], slot: 77, time: 'noon', player: { x: 'a' }, edits: [[0, 0, [1]], 'x'] }), hotbar);
check('broken fields fall back', [broken.hotbar, broken.slot, broken.time, broken.player, broken.edits], [hotbar, 0, 0.05, null, []]);

// Textures: one layer per tile, and nothing left fully black and transparent by mistake.
const tiles = C.paintTiles();
check('a layer for every tile', tiles.length, C.TILES.length * 16 * 16 * 4);
check('textures are stable', sha(tiles), sha(C.paintTiles()));
check('water is see-through', tiles[C.TILES.indexOf('water') * 1024 + 3], 170);

console.log(`  (one chunk in ${ms.toFixed(1)} ms; ${crossings} trees on borders)`);
done('world');

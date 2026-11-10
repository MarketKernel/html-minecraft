/**
 * The world generator: a chunk is a pure function of the seed and its
 * coordinates. Height comes from a few layers of noise (continents, hills,
 * mountain ridges), biomes from temperature and moisture, caves from where two
 * 3D noise fields both cross zero. Trees are planted by a hash of their
 * position, so a tree on a chunk border grows the same from either side.
 */
import { B } from './blocks';
import { hash3, Noise } from './noise';

export const CHUNK = 16;
export const HEIGHT = 128;
export const SEA = 46;

/** A chunk is CHUNK×CHUNK columns of HEIGHT blocks; a column is contiguous. */
export const index = (x: number, y: number, z: number) => (x << 11) | (z << 7) | y;

export const BIOME = { OCEAN: 0, BEACH: 1, PLAINS: 2, FOREST: 3, DESERT: 4, SNOWY: 5, MOUNTAIN: 6 } as const;
export const BIOME_NAMES = ['Ocean', 'Beach', 'Plains', 'Forest', 'Desert', 'Snowy', 'Mountains'];

const smoothstep = (a: number, b: number, x: number) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

export class Terrain {
  private readonly continent: Noise;
  private readonly hills: Noise;
  private readonly ridges: Noise;
  private readonly mountainMask: Noise;
  private readonly temperature: Noise;
  private readonly moisture: Noise;
  private readonly caveA: Noise;
  private readonly caveB: Noise;
  private readonly detail: Noise;

  /** Set by column(): the surface height and the biome there. */
  height = 0;
  biome = 0;

  constructor(readonly seed: number) {
    const n = (i: number) => new Noise((seed + i * 0x9e3779b1) | 0);
    this.continent = n(1);
    this.hills = n(2);
    this.ridges = n(3);
    this.mountainMask = n(4);
    this.temperature = n(5);
    this.moisture = n(6);
    this.caveA = n(7);
    this.caveB = n(8);
    this.detail = n(9);
  }

  /** Works out the surface height and biome of one column into this.height and this.biome. */
  column(wx: number, wz: number): void {
    const c = this.continent.fbm2(wx / 520, wz / 520, 4);
    const hills = this.hills.fbm2(wx / 90, wz / 90, 4);
    const ridge = 1 - Math.abs(this.ridges.fbm2(wx / 240, wz / 240, 4));
    const mask = smoothstep(0.02, 0.32, this.mountainMask.fbm2(wx / 700, wz / 700, 3) + c * 0.3);
    let h = SEA + 5 + c * 34 + hills * (5 + 7 * Math.max(0, c + 0.2)) + mask * ridge * ridge * ridge * 62;
    h = Math.floor(Math.min(HEIGHT - 8, Math.max(4, h)));

    const temp = this.temperature.fbm2(wx / 420, wz / 420, 2) - Math.max(0, h - SEA - 20) / 90;
    const moist = this.moisture.fbm2(wx / 330 + 50, wz / 330 - 50, 2);
    let biome: number;
    if (h < SEA - 1) biome = BIOME.OCEAN;
    else if (h <= SEA + 1) biome = BIOME.BEACH;
    else if (h > SEA + 40) biome = BIOME.MOUNTAIN;
    else if (temp < -0.22) biome = BIOME.SNOWY;
    else if (temp > 0.18 && moist < 0.08) biome = BIOME.DESERT;
    else if (moist > 0.1) biome = BIOME.FOREST;
    else biome = BIOME.PLAINS;
    this.height = h;
    this.biome = biome;
  }

  /** A dry, gentle spot near the origin: the first grassland found walking out in a spiral. */
  findSpawn(): [number, number] {
    for (let r = 0; r < 4000; r += 8) {
      const steps = Math.max(1, Math.floor((2 * Math.PI * r) / 8));
      for (let i = 0; i < steps; i++) {
        const a = (i / steps) * Math.PI * 2;
        const x = Math.round(Math.cos(a) * r);
        const z = Math.round(Math.sin(a) * r);
        this.column(x, z);
        if ((this.biome === BIOME.PLAINS || this.biome === BIOME.FOREST) && this.height > SEA + 2) return [x, z];
      }
    }
    return [0, 0];
  }

  generate(cx: number, cz: number): Uint8Array {
    const data = new Uint8Array(CHUNK * CHUNK * HEIGHT);
    const seed = this.seed;
    const x0 = cx * CHUNK;
    const z0 = cz * CHUNK;
    const heights = new Int16Array(CHUNK * CHUNK);
    const biomes = new Uint8Array(CHUNK * CHUNK);

    for (let x = 0; x < CHUNK; x++) {
      for (let z = 0; z < CHUNK; z++) {
        const wx = x0 + x;
        const wz = z0 + z;
        this.column(wx, wz);
        const h = this.height;
        const biome = this.biome;
        heights[x * CHUNK + z] = h;
        biomes[x * CHUNK + z] = biome;
        const col = index(x, 0, z);

        data[col] = B.BEDROCK;
        for (let y = 1; y <= h; y++) data[col + y] = B.STONE;
        if (hash3(seed, wx, 1, wz) < 0.6) data[col + 1] = B.BEDROCK;
        if (hash3(seed, wx, 2, wz) < 0.25) data[col + 2] = B.BEDROCK;

        // The surface layers.
        const patch = this.detail.noise2(wx / 9, wz / 9);
        if (biome === BIOME.OCEAN) {
          const floor = patch > 0.15 ? B.DIRT : B.SAND;
          for (let y = h - 2; y <= h; y++) data[col + y] = floor;
          for (let y = h + 1; y <= SEA; y++) data[col + y] = B.WATER;
        } else if (biome === BIOME.BEACH || biome === BIOME.DESERT) {
          const depth = biome === BIOME.DESERT ? 5 : 3;
          for (let y = h - depth; y <= h; y++) data[col + y] = B.SAND;
          for (let y = h + 1; y <= SEA; y++) data[col + y] = B.WATER;
        } else if (biome === BIOME.MOUNTAIN) {
          if (h > SEA + 52 + patch * 6) data[col + h] = B.SNOW;
          else if (patch > 0.25 && h < SEA + 50) {
            data[col + h] = B.GRASS;
            data[col + h - 1] = B.DIRT;
          }
        } else {
          for (let y = h - 3; y < h; y++) data[col + y] = B.DIRT;
          data[col + h] = biome === BIOME.SNOWY ? B.SNOW_GRASS : B.GRASS;
        }

        // Caves, where two noise fields are both near zero: long winding tunnels.
        // They stay clear of the sea floor, which would otherwise leak into them.
        const top = h <= SEA + 1 ? h - 5 : h;
        for (let y = 3; y < top; y++) {
          const a = this.caveA.noise3(wx / 26, y / 16, wz / 26);
          if (a * a > 0.012) continue;
          const b = this.caveB.noise3(wx / 26, y / 16, wz / 26);
          if (a * a + b * b < 0.012) data[col + y] = y < 11 ? B.LAVA : B.AIR;
        }

        // Ore, scattered through the stone left after the caves.
        for (let y = 3; y < h - 3; y++) {
          if (data[col + y] !== B.STONE) continue;
          const r = hash3(seed ^ 0x51ed27, wx, y, wz);
          if (y < 16 && r < 0.0018) data[col + y] = B.DIAMOND_ORE;
          else if (y < 32 && r < 0.0045) data[col + y] = B.GOLD_ORE;
          else if (y < 90 && r < 0.016) data[col + y] = B.COAL_ORE;
        }
      }
    }

    // Plants: grass, flowers, the odd pumpkin and cactus.
    for (let x = 0; x < CHUNK; x++) {
      for (let z = 0; z < CHUNK; z++) {
        const h = heights[x * CHUNK + z]!;
        const biome = biomes[x * CHUNK + z]!;
        const col = index(x, 0, z);
        if (h + 3 >= HEIGHT || data[col + h + 1] !== B.AIR) continue;
        const ground = data[col + h];
        const r = hash3(seed ^ 0x1234567, x0 + x, 0, z0 + z);
        if (ground === B.GRASS) {
          const grassy = biome === BIOME.FOREST ? 0.14 : 0.1;
          if (r < 0.012) data[col + h + 1] = B.FLOWER_RED;
          else if (r < 0.024) data[col + h + 1] = B.FLOWER_YELLOW;
          else if (r < 0.026 && biome === BIOME.PLAINS) data[col + h + 1] = B.PUMPKIN;
          else if (r < 0.026 + grassy) data[col + h + 1] = B.TALL_GRASS;
        } else if (ground === B.SAND && biome === BIOME.DESERT && r < 0.006) {
          const tall = 1 + Math.floor(hash3(seed, x0 + x, 7, z0 + z) * 3);
          for (let y = 1; y <= tall; y++) data[col + h + y] = B.CACTUS;
        }
      }
    }

    // Trees, looked for a few blocks beyond the chunk so that crowns reaching
    // in from a neighbour are planted here too.
    for (let wx = x0 - 3; wx < x0 + CHUNK + 3; wx++) {
      for (let wz = z0 - 3; wz < z0 + CHUNK + 3; wz++) {
        const r = hash3(seed ^ 0x7ee5, wx, 1, wz);
        if (r >= 0.05) continue;
        this.column(wx, wz);
        const chance = this.biome === BIOME.FOREST ? 0.05 : this.biome === BIOME.PLAINS ? 0.005 : this.biome === BIOME.SNOWY ? 0.012 : 0;
        if (r >= chance || this.height < SEA + 2 || this.height > HEIGHT - 12) continue;
        this.tree(data, wx - x0, this.height + 1, wz - z0, wx, wz);
      }
    }
    return data;
  }

  private tree(data: Uint8Array, tx: number, ty: number, tz: number, wx: number, wz: number): void {
    const seed = this.seed;
    const trunk = 4 + Math.floor(hash3(seed, wx, 2, wz) * 3);
    const inside = (x: number, z: number) => x >= 0 && x < CHUNK && z >= 0 && z < CHUNK;
    for (let dy = trunk - 2; dy <= trunk + 1; dy++) {
      const r = dy < trunk ? 2 : 1;
      for (let dx = -r; dx <= r; dx++) {
        for (let dz = -r; dz <= r; dz++) {
          const corner = Math.abs(dx) === r && Math.abs(dz) === r;
          if (corner && (dy === trunk + 1 || hash3(seed, wx + dx, ty + dy, wz + dz) < 0.5)) continue;
          const x = tx + dx;
          const z = tz + dz;
          if (!inside(x, z)) continue;
          const i = index(x, ty + dy, z);
          if (data[i] === B.AIR) data[i] = B.LEAVES;
        }
      }
    }
    if (inside(tx, tz)) for (let dy = 0; dy < trunk; dy++) data[index(tx, ty + dy, tz)] = B.LOG;
  }
}

/**
 * Seeded randomness: a small PRNG, a coordinate hash and Perlin noise. The
 * world is a pure function of its seed, so every chunk comes out the same no
 * matter when or in which order it is generated.
 */

export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A well-mixed hash of integer coordinates, in [0, 1). */
export function hash3(seed: number, x: number, y: number, z: number): number {
  let h = seed ^ Math.imul(x, 0x27d4eb2d) ^ Math.imul(y, 0x165667b1) ^ Math.imul(z, 0x9e3779b1);
  h = Math.imul(h ^ (h >>> 15), 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

export function hashString(text: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 0x01000193);
  return h >>> 0;
}

const fade = (t: number) => t * t * t * (t * (t * 6 - 15) + 10);
const lerp = (t: number, a: number, b: number) => a + t * (b - a);

function grad2(h: number, x: number, y: number): number {
  switch (h & 7) {
    case 0: return x + y;
    case 1: return -x + y;
    case 2: return x - y;
    case 3: return -x - y;
    case 4: return x;
    case 5: return -x;
    case 6: return y;
    default: return -y;
  }
}

function grad3(h: number, x: number, y: number, z: number): number {
  const g = h & 15;
  const u = g < 8 ? x : y;
  const v = g < 4 ? y : g === 12 || g === 14 ? x : z;
  return ((g & 1) === 0 ? u : -u) + ((g & 2) === 0 ? v : -v);
}

/** Ken Perlin's improved noise over a permutation shuffled by the seed. Roughly in [-1, 1]. */
export class Noise {
  private readonly p = new Uint8Array(512);

  constructor(seed: number) {
    const random = mulberry32(seed);
    const perm = Array.from({ length: 256 }, (_, i) => i);
    for (let i = 255; i > 0; i--) {
      const j = Math.floor(random() * (i + 1));
      [perm[i], perm[j]] = [perm[j]!, perm[i]!];
    }
    for (let i = 0; i < 512; i++) this.p[i] = perm[i & 255]!;
  }

  noise2(x: number, y: number): number {
    const p = this.p;
    const fx = Math.floor(x);
    const fy = Math.floor(y);
    const xf = x - fx;
    const yf = y - fy;
    const X = fx & 255;
    const Y = fy & 255;
    const u = fade(xf);
    const v = fade(yf);
    const a = p[X]! + Y;
    const b = p[X + 1]! + Y;
    return lerp(
      v,
      lerp(u, grad2(p[a]!, xf, yf), grad2(p[b]!, xf - 1, yf)),
      lerp(u, grad2(p[a + 1]!, xf, yf - 1), grad2(p[b + 1]!, xf - 1, yf - 1)),
    );
  }

  noise3(x: number, y: number, z: number): number {
    const p = this.p;
    const fx = Math.floor(x);
    const fy = Math.floor(y);
    const fz = Math.floor(z);
    x -= fx;
    y -= fy;
    z -= fz;
    const X = fx & 255;
    const Y = fy & 255;
    const Z = fz & 255;
    const u = fade(x);
    const v = fade(y);
    const w = fade(z);
    const A = p[X]! + Y;
    const AA = p[A]! + Z;
    const AB = p[A + 1]! + Z;
    const B = p[X + 1]! + Y;
    const BA = p[B]! + Z;
    const BB = p[B + 1]! + Z;
    return lerp(
      w,
      lerp(v, lerp(u, grad3(p[AA]!, x, y, z), grad3(p[BA]!, x - 1, y, z)), lerp(u, grad3(p[AB]!, x, y - 1, z), grad3(p[BB]!, x - 1, y - 1, z))),
      lerp(
        v,
        lerp(u, grad3(p[AA + 1]!, x, y, z - 1), grad3(p[BA + 1]!, x - 1, y, z - 1)),
        lerp(u, grad3(p[AB + 1]!, x, y - 1, z - 1), grad3(p[BB + 1]!, x - 1, y - 1, z - 1)),
      ),
    );
  }

  /** Octaves of noise2, each twice as fine and half as strong, scaled back to about [-1, 1]. */
  fbm2(x: number, y: number, octaves: number): number {
    let sum = 0;
    let amp = 1;
    let norm = 0;
    for (let i = 0; i < octaves; i++) {
      sum += this.noise2(x, y) * amp;
      norm += amp;
      amp *= 0.5;
      x *= 2;
      y *= 2;
    }
    return sum / norm;
  }
}

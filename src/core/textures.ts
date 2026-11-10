/**
 * Every texture is painted here, pixel by pixel, from a seed made of its name:
 * no image files, and the same pixels on every run. The result is one RGBA
 * buffer, TILE×TILE per layer, in the order of TILES.
 */
import { TILES, type TileName } from './blocks';
import { hashString, mulberry32 } from './noise';

export const TILE = 16;

type RGB = readonly [number, number, number];

class Painter {
  readonly random: () => number;
  private readonly offset: number;

  constructor(private readonly data: Uint8Array, layer: number, seed: number) {
    this.random = mulberry32(seed);
    this.offset = layer * TILE * TILE * 4;
  }

  set(x: number, y: number, c: RGB, alpha = 255): void {
    if (x < 0 || y < 0 || x >= TILE || y >= TILE) return;
    const o = this.offset + (y * TILE + x) * 4;
    this.data[o] = Math.max(0, Math.min(255, c[0]));
    this.data[o + 1] = Math.max(0, Math.min(255, c[1]));
    this.data[o + 2] = Math.max(0, Math.min(255, c[2]));
    this.data[o + 3] = alpha;
  }

  get(x: number, y: number): RGB {
    const o = this.offset + (y * TILE + x) * 4;
    return [this.data[o]!, this.data[o + 1]!, this.data[o + 2]!];
  }

  alpha(x: number, y: number): number {
    return this.data[this.offset + (y * TILE + x) * 4 + 3]!;
  }

  /** c, a little lighter or darker at random. */
  vary(c: RGB, amount: number): RGB {
    const f = 1 + (this.random() - 0.5) * amount;
    return [c[0] * f, c[1] * f, c[2] * f];
  }

  fill(c: RGB, amount = 0.15, alpha = 255): void {
    for (let y = 0; y < TILE; y++) for (let x = 0; x < TILE; x++) this.set(x, y, this.vary(c, amount), alpha);
  }

  speckle(c: RGB, chance: number, amount = 0.1): void {
    for (let y = 0; y < TILE; y++) for (let x = 0; x < TILE; x++) if (this.random() < chance) this.set(x, y, this.vary(c, amount), this.alpha(x, y) || 255);
  }

  rect(x0: number, y0: number, w: number, h: number, c: RGB, amount = 0.1, alpha = 255): void {
    for (let y = y0; y < y0 + h; y++) for (let x = x0; x < x0 + w; x++) this.set(x, y, this.vary(c, amount), alpha);
  }

  clear(): void {
    for (let y = 0; y < TILE; y++) for (let x = 0; x < TILE; x++) this.set(x, y, [0, 0, 0], 0);
  }

  /** Small clumps of colour, as in ore. */
  blobs(c: RGB, count: number, highlight?: RGB): void {
    for (let i = 0; i < count; i++) {
      const x = 1 + Math.floor(this.random() * 13);
      const y = 1 + Math.floor(this.random() * 13);
      this.set(x, y, this.vary(c, 0.15));
      this.set(x + 1, y, this.vary(c, 0.15));
      this.set(x, y + 1, this.vary(c, 0.25));
      if (this.random() < 0.6) this.set(x + 1, y + 1, this.vary(c, 0.3));
      if (highlight) this.set(x, y, highlight);
    }
  }

  /**
   * Transparent pixels take the tile's average colour: mipmaps blend them with
   * their neighbours, and black there would leave a dark fringe at a distance.
   */
  bleed(): void {
    let r = 0;
    let g = 0;
    let b = 0;
    let n = 0;
    for (let y = 0; y < TILE; y++) {
      for (let x = 0; x < TILE; x++) {
        if (!this.alpha(x, y)) continue;
        const c = this.get(x, y);
        r += c[0];
        g += c[1];
        b += c[2];
        n++;
      }
    }
    if (!n) return;
    for (let y = 0; y < TILE; y++) for (let x = 0; x < TILE; x++) if (!this.alpha(x, y)) this.set(x, y, [r / n, g / n, b / n], 0);
  }
}

const DIRT: RGB = [134, 96, 67];
const GRASS: RGB = [98, 190, 58];
const STONE: RGB = [130, 130, 136];
const SNOW: RGB = [246, 250, 255];
const PUMPKIN: RGB = [236, 132, 28];

function dirt(p: Painter): void {
  p.fill(DIRT, 0.18);
  p.speckle([104, 72, 48], 0.2);
  p.speckle([166, 124, 88], 0.08);
  p.speckle([128, 128, 128], 0.03);
}

function stone(p: Painter): void {
  p.fill(STONE, 0.1);
  for (let i = 0; i < 16; i++) {
    const x = Math.floor(p.random() * 16);
    const y = Math.floor(p.random() * 16);
    const len = 2 + Math.floor(p.random() * 4);
    const c: RGB = p.random() < 0.6 ? [108, 108, 114] : [152, 152, 158];
    for (let k = 0; k < len; k++) p.set(x + k, y, p.vary(c, 0.06));
  }
}

/** A dirt side under a fringe of something else on top. */
function sideWithTop(p: Painter, top: RGB, depth: number): void {
  dirt(p);
  for (let x = 0; x < TILE; x++) {
    const h = depth + (p.random() < 0.5 ? 1 : 0) + (p.random() < 0.25 ? 1 : 0);
    for (let y = 0; y < h; y++) p.set(x, y, p.vary(top, 0.2));
  }
}

function wool(c: RGB): (p: Painter) => void {
  return (p) => {
    p.fill(c, 0.08);
    for (let y = 0; y < TILE; y++) for (let x = 0; x < TILE; x++) if ((x + y * 3) % 5 === 0) p.set(x, y, p.vary([c[0] * 0.9, c[1] * 0.9, c[2] * 0.9], 0.05));
  };
}

/** Pixel letters for the TNT label, 5 rows each. */
const LETTERS: Record<string, string[]> = {
  T: ['111', '010', '010', '010', '010'],
  N: ['1001', '1101', '1011', '1001', '1001'],
};

function flower(p: Painter, petal: RGB, centre: RGB): void {
  p.clear();
  for (let y = 7; y < 16; y++) p.set(7, y, p.vary([62, 150, 42], 0.15));
  p.set(6, 11, [70, 165, 48]);
  p.set(5, 10, [70, 165, 48]);
  p.set(8, 12, [70, 165, 48]);
  p.set(9, 11, [70, 165, 48]);
  for (const [x, y] of [[6, 3], [7, 3], [8, 3], [5, 4], [6, 4], [8, 4], [9, 4], [5, 5], [9, 5], [6, 6], [7, 6], [8, 6], [5, 6], [9, 6], [7, 2]] as const) {
    p.set(x, y, p.vary(petal, 0.15));
  }
  p.set(7, 4, centre);
  p.set(7, 5, centre);
  p.set(6, 5, p.vary(centre, 0.2));
  p.set(8, 5, p.vary(centre, 0.2));
}

const PAINT: Record<TileName, (p: Painter) => void> = {
  grass_top(p) {
    p.fill(GRASS, 0.22);
    p.speckle([132, 216, 74], 0.15);
    p.speckle([72, 150, 42], 0.15);
  },
  grass_side: (p) => sideWithTop(p, GRASS, 3),
  dirt,
  stone,
  cobble(p) {
    p.fill([84, 84, 90], 0.1);
    for (let row = 0; row < 4; row++) {
      let x = row % 2 ? -2 : 0;
      while (x < TILE) {
        const w = 3 + Math.floor(p.random() * 4);
        const base: RGB = p.vary([136, 136, 142], 0.25);
        for (let y = row * 4; y < row * 4 + 3; y++) {
          for (let k = x; k < x + w - 1; k++) {
            const edge = y === row * 4 ? 1.18 : y === row * 4 + 2 ? 0.82 : 1;
            p.set(k, y, p.vary([base[0] * edge, base[1] * edge, base[2] * edge], 0.08));
          }
        }
        x += w;
      }
    }
  },
  sand(p) {
    p.fill([230, 214, 152], 0.07);
    p.speckle([206, 186, 128], 0.15);
    p.speckle([246, 234, 186], 0.08);
  },
  water(p) {
    p.fill([46, 112, 232], 0.08, 170);
    for (let i = 0; i < 9; i++) {
      const x = Math.floor(p.random() * 16);
      const y = Math.floor(p.random() * 16);
      const len = 3 + Math.floor(p.random() * 4);
      for (let k = 0; k < len; k++) p.set((x + k) % 16, y, [96, 166, 255], 170);
    }
  },
  log_side(p) {
    p.fill([112, 82, 50], 0.12);
    for (let x = 0; x < TILE; x++) {
      if (x % 4 !== 1 && p.random() > 0.15) continue;
      for (let y = 0; y < TILE; y++) if (p.random() < 0.85) p.set(x, y, p.vary([80, 58, 34], 0.15));
    }
  },
  log_top(p) {
    for (let y = 0; y < TILE; y++) {
      for (let x = 0; x < TILE; x++) {
        const d = Math.max(Math.abs(x - 7.5), Math.abs(y - 7.5));
        const c: RGB = d > 6.6 ? [100, 72, 42] : Math.floor(d) % 2 ? [182, 146, 92] : [154, 118, 72];
        p.set(x, y, p.vary(c, 0.08));
      }
    }
  },
  leaves(p) {
    p.fill([54, 156, 46], 0.3);
    p.speckle([34, 112, 30], 0.2);
    p.speckle([92, 196, 70], 0.1);
    for (let y = 0; y < TILE; y++) for (let x = 0; x < TILE; x++) if (p.random() < 0.18) p.set(x, y, [0, 0, 0], 0);
  },
  planks(p) {
    p.fill([196, 152, 92], 0.08);
    for (let y = 0; y < TILE; y++) {
      const row = y >> 2;
      for (let x = 0; x < TILE; x++) {
        if (y % 4 === 3) p.set(x, y, p.vary([138, 100, 56], 0.08));
        else if (x === (row * 5 + 3) % 16) p.set(x, y, [150, 112, 66]);
        else if (p.random() < 0.12) p.set(x, y, p.vary([176, 134, 78], 0.1));
      }
    }
  },
  glass(p) {
    p.clear();
    for (let i = 0; i < TILE; i++) {
      p.set(i, 0, [226, 244, 255]);
      p.set(i, 15, [190, 220, 240]);
      p.set(0, i, [226, 244, 255]);
      p.set(15, i, [190, 220, 240]);
    }
    for (const [x, y] of [[3, 5], [4, 4], [5, 3], [4, 6], [6, 4], [10, 11], [11, 10], [12, 9]] as const) p.set(x, y, [255, 255, 255], 220);
  },
  snow(p) {
    p.fill(SNOW, 0.04);
    p.speckle([214, 230, 248], 0.12);
  },
  snow_side: (p) => sideWithTop(p, SNOW, 4),
  bedrock(p) {
    p.fill([84, 84, 84], 0.1);
    p.speckle([38, 38, 40], 0.3);
    p.speckle([140, 140, 140], 0.15);
  },
  coal_ore(p) {
    stone(p);
    p.blobs([34, 34, 38], 5);
  },
  gold_ore(p) {
    stone(p);
    p.blobs([255, 204, 30], 5, [255, 246, 160]);
  },
  diamond_ore(p) {
    stone(p);
    p.blobs([70, 236, 232], 5, [220, 255, 255]);
  },
  brick(p) {
    p.fill([206, 196, 184], 0.06);
    for (let y = 0; y < TILE; y++) {
      if (y % 4 === 3) continue;
      const shift = (y >> 2) % 2 ? 4 : 0;
      for (let x = 0; x < TILE; x++) if ((x + shift) % 8 !== 7) p.set(x, y, p.vary([186, 68, 48], 0.14));
    }
  },
  glowstone(p) {
    p.fill([246, 196, 86], 0.15);
    for (let i = 0; i < 12; i++) p.rect(Math.floor(p.random() * 14), Math.floor(p.random() * 14), 2, 2, [255, 244, 176], 0.05);
    p.speckle([196, 132, 46], 0.12);
  },
  tnt_top(p) {
    p.fill([206, 44, 32], 0.1);
    p.rect(4, 4, 8, 8, [214, 214, 214], 0.05);
    p.rect(6, 6, 4, 4, [70, 70, 70], 0.1);
  },
  tnt_side(p) {
    p.fill([218, 42, 30], 0.08);
    for (let x = 0; x < TILE; x += 4) for (let y = 0; y < TILE; y++) p.set(x, y, p.vary([168, 28, 20], 0.08));
    p.rect(0, 5, 16, 7, [242, 242, 242], 0.03);
    let x = 2;
    for (const ch of 'TNT') {
      const glyph = LETTERS[ch]!;
      glyph.forEach((row, y) => [...row].forEach((bit, dx) => bit === '1' && p.set(x + dx, 6 + y, [30, 30, 30])));
      x += glyph[0]!.length + 1;
    }
  },
  tnt_bottom(p) {
    p.fill([170, 34, 26], 0.1);
  },
  cactus_top(p) {
    p.fill([84, 168, 64], 0.1);
    p.rect(3, 3, 10, 10, [110, 196, 84], 0.08);
  },
  cactus_side(p) {
    p.fill([76, 164, 60], 0.1);
    for (let x = 1; x < TILE; x += 4) for (let y = 0; y < TILE; y++) p.set(x, y, p.vary([44, 118, 40], 0.1));
    for (let i = 0; i < 8; i++) p.set(Math.floor(p.random() * 16), Math.floor(p.random() * 16), [236, 226, 180]);
  },
  flower_red: (p) => flower(p, [234, 34, 46], [255, 214, 60]),
  flower_yellow: (p) => flower(p, [255, 222, 36], [255, 150, 30]),
  tall_grass(p) {
    p.clear();
    for (let i = 0; i < 9; i++) {
      let x = 1 + Math.floor(p.random() * 14);
      const h = 5 + Math.floor(p.random() * 10);
      const lean = p.random() < 0.5 ? -1 : 1;
      for (let k = 0; k < h; k++) {
        if (k > h / 2 && p.random() < 0.3) x += lean;
        p.set(x, 15 - k, p.vary([96, 186, 56], 0.25));
      }
    }
  },
  pumpkin_top(p) {
    p.fill(PUMPKIN, 0.08);
    for (let i = 0; i < TILE; i += 4) for (let k = 0; k < TILE; k++) p.set(i, k, p.vary([196, 100, 18], 0.08));
    p.rect(7, 7, 2, 2, [96, 72, 28], 0.1);
  },
  pumpkin_side(p) {
    p.fill(PUMPKIN, 0.08);
    for (let x = 0; x < TILE; x += 4) for (let y = 0; y < TILE; y++) p.set(x, y, p.vary([196, 100, 18], 0.08));
  },
  pumpkin_face(p) {
    PAINT.pumpkin_side(p);
    const glow: RGB = [255, 236, 110];
    for (const [x, y] of [[3, 4], [4, 4], [3, 5], [4, 5], [5, 5], [11, 4], [12, 4], [10, 5], [11, 5], [12, 5]] as const) p.set(x, y, glow);
    for (let x = 3; x <= 12; x++) p.set(x, 10, glow);
    for (const x of [4, 5, 7, 8, 10, 11]) p.set(x, 11, glow);
    for (const x of [5, 6, 7, 8, 9, 10]) p.set(x, 12, glow);
  },
  lava(p) {
    p.fill([228, 92, 20], 0.1);
    for (let i = 0; i < 10; i++) p.rect(Math.floor(p.random() * 14), Math.floor(p.random() * 14), 2 + Math.floor(p.random() * 2), 2, [255, 176, 40], 0.1);
    p.speckle([255, 226, 110], 0.06);
    p.speckle([168, 44, 12], 0.08);
  },
  wool_white: wool([236, 236, 236]),
  wool_red: wool([222, 50, 50]),
  wool_orange: wool([246, 140, 30]),
  wool_yellow: wool([252, 216, 40]),
  wool_lime: wool([122, 212, 40]),
  wool_cyan: wool([28, 182, 194]),
  wool_blue: wool([52, 84, 214]),
  wool_purple: wool([142, 60, 204]),
  wool_pink: wool([246, 132, 172]),
  wool_black: wool([38, 38, 44]),
};

export function paintTiles(): Uint8Array {
  const data = new Uint8Array(TILES.length * TILE * TILE * 4);
  TILES.forEach((name, layer) => {
    const p = new Painter(data, layer, hashString(name));
    PAINT[name](p);
    p.bleed();
  });
  return data;
}

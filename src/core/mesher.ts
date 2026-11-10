/**
 * Turns a chunk into vertices: only the faces that touch something see-through
 * are emitted, each corner shaded by ambient occlusion and lit by the sky and
 * by glowing blocks nearby.
 *
 * The chunk is first copied into a padded region together with LIGHT_RANGE
 * blocks of its neighbours: enough for faces on the border, and exactly as far
 * as block light travels, so a lantern in the next chunk lights this one too and
 * no seam shows where the two meet.
 *
 * A vertex is 16 bytes: int16 x, y, z in 1/16 of a block from the chunk's
 * corner (and one spare); uint8 u, v, texture layer, flags; uint8 shade, sky
 * light, block light, spare. Quads are 4 vertices, drawn with one shared index
 * buffer (0 1 2, 0 2 3) — the AO-aware diagonal is chosen by which corner a
 * quad starts from.
 */
import {
  B, EMIT, FACE_TILE, FLAG_SWAY, FLAGS, OCCLUDES, OPAQUE, SHAPE, SHAPE_CROSS, SHAPE_CUBE, SHAPE_LIQUID,
} from './blocks';
import { CHUNK, HEIGHT } from './terrain';
import type { BlockSource } from './world';

export const VERTEX_BYTES = 16;
export const LIGHT_RANGE = 8;

const P = LIGHT_RANGE;
const W = CHUNK + 2 * P;
/** A row of bedrock under the world and one of air above it, so y ± 1 never needs a check. */
const RH = HEIGHT + 2;
const SX = W * RH;
const SZ = RH;
const SIZE = W * W * RH;

const region = new Uint8Array(SIZE);
const blockLight = new Uint8Array(SIZE);
const skyLight = new Uint8Array(SIZE);
const queue = new Int32Array(SIZE);

/** Brightness of each light level, 0–255. */
const LEVEL = Array.from({ length: LIGHT_RANGE + 1 }, (_, l) => Math.round(255 * Math.pow(l / LIGHT_RANGE, 1.6)));
const AO = [0.5, 0.68, 0.84, 1];
/** +x, -x, +y, -y, +z, -z */
const SHADE = [0.78, 0.78, 1, 0.55, 0.9, 0.9];
const NORMAL = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]] as const;
/** Corners of each face as seen from outside: bottom-left, bottom-right, top-right, top-left. */
const CORNERS = [
  [[1, 0, 1], [1, 0, 0], [1, 1, 0], [1, 1, 1]],
  [[0, 0, 0], [0, 0, 1], [0, 1, 1], [0, 1, 0]],
  [[0, 1, 1], [1, 1, 1], [1, 1, 0], [0, 1, 0]],
  [[0, 0, 0], [1, 0, 0], [1, 0, 1], [0, 0, 1]],
  [[0, 0, 1], [1, 0, 1], [1, 1, 1], [0, 1, 1]],
  [[1, 0, 0], [0, 0, 0], [0, 1, 0], [1, 1, 0]],
] as const;
const UV = [[0, 1], [1, 1], [1, 0], [0, 0]] as const;

const delta = (x: number, y: number, z: number) => x * SX + z * SZ + y;
const NEIGHBOUR = NORMAL.map(([x, y, z]) => delta(x, y, z));
/** For every face and corner: offsets of the two side cells and the diagonal one, next to the face. */
const AO_OFFSETS = CORNERS.map((corners, f) => {
  const normal = NORMAL[f]!;
  const axis = normal.findIndex((v) => v !== 0);
  const tangents = [0, 1, 2].filter((a) => a !== axis);
  return corners.map((c) => {
    const unit = (a: number) => {
      const v = [0, 0, 0];
      v[a] = c[a] === 1 ? 1 : -1;
      return v;
    };
    const s1 = unit(tangents[0]!);
    const s2 = unit(tangents[1]!);
    return [delta(s1[0]!, s1[1]!, s1[2]!), delta(s2[0]!, s2[1]!, s2[2]!), delta(s1[0]! + s2[0]!, s1[1]! + s2[1]!, s1[2]! + s2[2]!)];
  });
});

export class MeshBuilder {
  private buffer: ArrayBuffer;
  private i16: Int16Array;
  private u8: Uint8Array;
  quads = 0;

  constructor(quads = 2048) {
    this.buffer = new ArrayBuffer(quads * 4 * VERTEX_BYTES);
    this.i16 = new Int16Array(this.buffer);
    this.u8 = new Uint8Array(this.buffer);
  }

  reset(): void {
    this.quads = 0;
  }

  /** Room for one more quad. */
  reserve(): void {
    if ((this.quads + 1) * 4 * VERTEX_BYTES <= this.buffer.byteLength) return;
    const bigger = new ArrayBuffer(this.buffer.byteLength * 2);
    new Uint8Array(bigger).set(this.u8);
    this.buffer = bigger;
    this.i16 = new Int16Array(bigger);
    this.u8 = new Uint8Array(bigger);
  }

  vertex(n: number, x: number, y: number, z: number, u: number, v: number, layer: number, flags: number, shade: number, sky: number, block: number): void {
    const o = n * VERTEX_BYTES;
    const h = o >> 1;
    this.i16[h] = x;
    this.i16[h + 1] = y;
    this.i16[h + 2] = z;
    this.u8[o + 8] = u;
    this.u8[o + 9] = v;
    this.u8[o + 10] = layer;
    this.u8[o + 11] = flags;
    this.u8[o + 12] = shade;
    this.u8[o + 13] = sky;
    this.u8[o + 14] = block;
  }

  /** A copy of the vertices written so far. */
  take(): Uint8Array {
    return this.u8.slice(0, this.quads * 4 * VERTEX_BYTES);
  }
}

export interface ChunkMesh {
  /** Opaque and cut-out geometry: terrain, leaves, plants, glass, lava. */
  solid: Uint8Array;
  solidQuads: number;
  /** See-through water, drawn last with blending. */
  water: Uint8Array;
  waterQuads: number;
  /** Highest y with anything in it, for culling. */
  maxY: number;
}

const solidBuilder = new MeshBuilder(8192);
const waterBuilder = new MeshBuilder(2048);

/** Copies the chunk and its neighbours' near edges into the region; false if a neighbour is not loaded. */
function fillRegion(src: BlockSource, cx: number, cz: number): boolean {
  const chunks: Uint8Array[] = [];
  for (let dx = -1; dx <= 1; dx++) {
    for (let dz = -1; dz <= 1; dz++) {
      const c = src.chunk(cx + dx, cz + dz);
      if (!c) return false;
      chunks[(dx + 1) * 3 + dz + 1] = c;
    }
  }
  for (let rx = 0; rx < W; rx++) {
    const lx = rx - P;
    const ox = lx < 0 ? 0 : lx >= CHUNK ? 2 : 1;
    const sx = lx - (ox - 1) * CHUNK;
    for (let rz = 0; rz < W; rz++) {
      const lz = rz - P;
      const oz = lz < 0 ? 0 : lz >= CHUNK ? 2 : 1;
      const sz = lz - (oz - 1) * CHUNK;
      const data = chunks[ox * 3 + oz]!;
      const from = (sx << 11) | (sz << 7);
      const to = rx * SX + rz * SZ;
      region[to] = B.BEDROCK;
      region.set(data.subarray(from, from + HEIGHT), to + 1);
      region[to + RH - 1] = B.AIR;
    }
  }
  return true;
}

/**
 * Sky light: full above the highest opaque block of a column and fading below
 * it, so overhangs are shaded and caves grow dark the deeper they go.
 */
function lightSky(): void {
  for (let c = 0; c < W * W; c++) {
    const base = c * RH;
    let y = RH - 1;
    while (y > 0 && !OPAQUE[region[base + y]!]) skyLight[base + y--] = 255;
    const top = y;
    for (; y >= 0; y--) skyLight[base + y] = Math.max(10, 235 - (top - y) * 34);
  }
}

/** Block light: a flood from every glowing block, one level fainter with each step. */
function lightBlocks(): void {
  blockLight.fill(0);
  let head = 0;
  let tail = 0;
  for (let i = 0; i < SIZE; i++) {
    const e = EMIT[region[i]!]!;
    if (e) {
      blockLight[i] = e;
      queue[tail++] = i;
    }
  }
  while (head < tail) {
    const i = queue[head++]!;
    const l = blockLight[i]! - 1;
    if (l <= 0) continue;
    const rx = (i / SX) | 0;
    const rest = i - rx * SX;
    const rz = (rest / SZ) | 0;
    const y = rest - rz * SZ;
    const spread = (j: number) => {
      if (blockLight[j]! < l && !OPAQUE[region[j]!]) {
        blockLight[j] = l;
        queue[tail++] = j;
      }
    };
    if (rx > 0) spread(i - SX);
    if (rx < W - 1) spread(i + SX);
    if (rz > 0) spread(i - SZ);
    if (rz < W - 1) spread(i + SZ);
    if (y > 0) spread(i - 1);
    if (y < RH - 1) spread(i + 1);
  }
}

/** A face shows unless something opaque covers it, or it meets more of the same see-through block. */
function hidden(id: number, other: number): boolean {
  if (OPAQUE[other]) return true;
  if (other === id) return true;
  return SHAPE[id] === SHAPE_LIQUID && SHAPE[other] === SHAPE_CUBE;
}

function emitFace(out: MeshBuilder, f: number, lx: number, y: number, lz: number, i: number, id: number, lowered: boolean): void {
  const base = i + NEIGHBOUR[f]!;
  const layer = FACE_TILE[id * 6 + f]!;
  const flags = FLAGS[id]!;
  const offsets = AO_OFFSETS[f]!;
  const corners = CORNERS[f]!;
  const ao = [0, 0, 0, 0];
  const sky = [0, 0, 0, 0];
  const blk = [0, 0, 0, 0];
  for (let k = 0; k < 4; k++) {
    const [d1, d2, d3] = offsets[k]!;
    const a = base + d1!;
    const b = base + d2!;
    const c = base + d3!;
    const s1 = OCCLUDES[region[a]!]!;
    const s2 = OCCLUDES[region[b]!]!;
    const sc = OCCLUDES[region[c]!]!;
    ao[k] = s1 && s2 ? 0 : 3 - s1 - s2 - sc;
    // Smooth light: the average of the open cells around the corner.
    let n = 1;
    let sl = skyLight[base]!;
    let bl = LEVEL[blockLight[base]!]!;
    for (const j of s1 && s2 ? [a, b] : [a, b, c]) {
      if (OPAQUE[region[j]!]) continue;
      n++;
      sl += skyLight[j]!;
      bl += LEVEL[blockLight[j]!]!;
    }
    sky[k] = sl / n;
    blk[k] = bl / n;
  }
  out.reserve();
  // Split the quad along the diagonal whose ends are lit alike, or the shading shows a crease.
  const start = ao[0]! + ao[2]! < ao[1]! + ao[3]! ? 1 : 0;
  const v0 = out.quads * 4;
  for (let n = 0; n < 4; n++) {
    const k = (n + start) & 3;
    const c = corners[k]!;
    const top = c[1] === 1;
    out.vertex(
      v0 + n,
      (lx + c[0]) * 16,
      top && lowered ? y * 16 + 14 : (y + c[1]) * 16,
      (lz + c[2]) * 16,
      UV[k]![0],
      UV[k]![1],
      layer,
      flags,
      Math.round(255 * SHADE[f]! * AO[ao[k]!]!),
      Math.round(sky[k]!),
      Math.round(blk[k]!),
    );
  }
  out.quads++;
}

/** Two crossed quads, each with a back side, swaying at the top. */
const CROSS = [
  [[2, 2], [14, 14]],
  [[2, 14], [14, 2]],
  [[14, 14], [2, 2]],
  [[14, 2], [2, 14]],
] as const;

function emitCross(out: MeshBuilder, lx: number, y: number, lz: number, i: number, id: number): void {
  const layer = FACE_TILE[id * 6]!;
  const flags = FLAGS[id]!;
  const sky = skyLight[i]!;
  const blk = LEVEL[blockLight[i]!]!;
  for (const [[ax, az], [bx, bz]] of CROSS) {
    out.reserve();
    const v0 = out.quads * 4;
    const x0 = lx * 16;
    const z0 = lz * 16;
    out.vertex(v0, x0 + ax, y * 16, z0 + az, 0, 1, layer, flags & ~FLAG_SWAY, 230, sky, blk);
    out.vertex(v0 + 1, x0 + bx, y * 16, z0 + bz, 1, 1, layer, flags & ~FLAG_SWAY, 230, sky, blk);
    out.vertex(v0 + 2, x0 + bx, y * 16 + 16, z0 + bz, 1, 0, layer, flags, 230, sky, blk);
    out.vertex(v0 + 3, x0 + ax, y * 16 + 16, z0 + az, 0, 0, layer, flags, 230, sky, blk);
    out.quads++;
  }
}

/** The mesh of a chunk, or null while any of its eight neighbours is not loaded yet. */
export function meshChunk(src: BlockSource, cx: number, cz: number): ChunkMesh | null {
  if (!fillRegion(src, cx, cz)) return null;
  lightSky();
  lightBlocks();
  solidBuilder.reset();
  waterBuilder.reset();
  let maxY = 0;
  for (let lx = 0; lx < CHUNK; lx++) {
    for (let lz = 0; lz < CHUNK; lz++) {
      const col = (lx + P) * SX + (lz + P) * SZ;
      for (let y = 0; y < HEIGHT; y++) {
        const i = col + y + 1;
        const id = region[i]!;
        if (id === B.AIR) continue;
        const shape = SHAPE[id];
        if (shape === SHAPE_CROSS) {
          emitCross(solidBuilder, lx, y, lz, i, id);
          maxY = Math.max(maxY, y + 1);
          continue;
        }
        const liquid = shape === SHAPE_LIQUID;
        const out = id === B.WATER ? waterBuilder : solidBuilder;
        const lowered = liquid && SHAPE[region[i + 1]!] !== SHAPE_LIQUID;
        for (let f = 0; f < 6; f++) {
          // A lowered liquid top shows even under a block.
          if (hidden(id, region[i + NEIGHBOUR[f]!]!) && !(lowered && f === 2)) continue;
          emitFace(out, f, lx, y, lz, i, id, lowered);
          maxY = Math.max(maxY, y + 1);
        }
      }
    }
  }
  return { solid: solidBuilder.take(), solidQuads: solidBuilder.quads, water: waterBuilder.take(), waterQuads: waterBuilder.quads, maxY };
}

/** One block on its own, fully lit, for the block in the player's hand. */
export function meshBlock(id: number): { data: Uint8Array; quads: number } {
  const out = new MeshBuilder(16);
  if (SHAPE[id] === SHAPE_CROSS) {
    // emitCross reads the light of a region cell; lend it cell 0.
    skyLight[0] = 255;
    blockLight[0] = 0;
    emitCross(out, 0, 0, 0, 0, id);
  } else {
    for (let f = 0; f < 6; f++) {
      out.reserve();
      const v0 = out.quads * 4;
      CORNERS[f]!.forEach((c, k) =>
        out.vertex(v0 + k, c[0] * 16, c[1] * 16, c[2] * 16, UV[k]![0], UV[k]![1], FACE_TILE[id * 6 + f]!, FLAGS[id]! & ~FLAG_SWAY, Math.round(255 * SHADE[f]!), 255, 0),
      );
      out.quads++;
    }
  }
  return { data: out.take(), quads: out.quads };
}

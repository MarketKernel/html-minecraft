/**
 * The loaded part of the world, plus every block the player has changed.
 * Chunks come and go with the player; the edits stay, and are laid over a
 * chunk again whenever it is generated anew.
 */
import { B } from './blocks';
import { CHUNK, HEIGHT, index, Terrain } from './terrain';

export interface BlockSource {
  chunk(cx: number, cz: number): Uint8Array | undefined;
}

export const chunkKey = (cx: number, cz: number) => (cx + 32768) * 65536 + (cz + 32768);
export const keyX = (key: number) => Math.floor(key / 65536) - 32768;
export const keyZ = (key: number) => (key % 65536) - 32768;

export class World implements BlockSource {
  readonly terrain: Terrain;
  readonly chunks = new Map<number, Uint8Array>();
  /** By chunk: local index → block. */
  readonly edits = new Map<number, Map<number, number>>();
  /** Called after a block changes, with its world coordinates. */
  onChange: ((x: number, y: number, z: number) => void) | null = null;

  constructor(readonly seed: number) {
    this.terrain = new Terrain(seed);
  }

  chunk(cx: number, cz: number): Uint8Array | undefined {
    return this.chunks.get(chunkKey(cx, cz));
  }

  has(cx: number, cz: number): boolean {
    return this.chunks.has(chunkKey(cx, cz));
  }

  /** The chunk, generated now if it is not loaded. */
  ensure(cx: number, cz: number): Uint8Array {
    const key = chunkKey(cx, cz);
    let data = this.chunks.get(key);
    if (!data) {
      data = this.terrain.generate(cx, cz);
      const edits = this.edits.get(key);
      if (edits) for (const [i, id] of edits) data[i] = id;
      this.chunks.set(key, data);
    }
    return data;
  }

  unload(key: number): void {
    this.chunks.delete(key);
  }

  /** Below the world is bedrock, above it air; an unloaded chunk reads as air. */
  get(x: number, y: number, z: number): number {
    if (y < 0) return B.BEDROCK;
    if (y >= HEIGHT) return B.AIR;
    const data = this.chunks.get(chunkKey(x >> 4, z >> 4));
    return data ? data[index(x & 15, y, z & 15)]! : B.AIR;
  }

  /** Changes a loaded block and remembers the change. False if nothing changed. */
  set(x: number, y: number, z: number, id: number): boolean {
    if (y < 0 || y >= HEIGHT) return false;
    const key = chunkKey(x >> 4, z >> 4);
    const data = this.chunks.get(key);
    if (!data) return false;
    const i = index(x & 15, y, z & 15);
    if (data[i] === id) return false;
    data[i] = id;
    let edits = this.edits.get(key);
    if (!edits) this.edits.set(key, (edits = new Map()));
    edits.set(i, id);
    this.onChange?.(x, y, z);
    return true;
  }

  /** The highest block that is not air in a loaded column, or -1. */
  top(x: number, z: number): number {
    for (let y = HEIGHT - 1; y >= 0; y--) if (this.get(x, y, z) !== B.AIR) return y;
    return -1;
  }

  get editCount(): number {
    let n = 0;
    for (const e of this.edits.values()) n += e.size;
    return n;
  }
}

export { CHUNK, HEIGHT };

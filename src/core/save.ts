/**
 * A saved game: the seed regenerates the terrain, so only the player, the clock
 * and the changed blocks are stored. Everything read back is checked field by
 * field; anything broken falls back to a default instead of breaking the game.
 */
import { BLOCK_COUNT } from './blocks';
import { chunkKey, keyX, keyZ, type World } from './world';

export interface PlayerState {
  x: number;
  y: number;
  z: number;
  yaw: number;
  pitch: number;
  flying: boolean;
}

export interface SaveData {
  version: 1;
  seed: number;
  /** Fraction of a day, 0–1. */
  time: number;
  player: PlayerState | null;
  hotbar: number[];
  slot: number;
  /** [chunk x, chunk z, [index, block, index, block, …]] */
  edits: [number, number, number[]][];
}

export function encodeEdits(world: World): SaveData['edits'] {
  const out: SaveData['edits'] = [];
  for (const [key, edits] of world.edits) {
    const flat: number[] = [];
    for (const [i, id] of edits) flat.push(i, id);
    out.push([keyX(key), keyZ(key), flat]);
  }
  return out;
}

export function applyEdits(world: World, edits: SaveData['edits']): void {
  for (const [cx, cz, flat] of edits) {
    const map = new Map<number, number>();
    for (let i = 0; i + 1 < flat.length; i += 2) map.set(flat[i]!, flat[i + 1]!);
    world.edits.set(chunkKey(cx, cz), map);
  }
}

const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const isInt = (v: unknown, min: number, max: number): v is number => Number.isInteger(v) && (v as number) >= min && (v as number) <= max;

export function parseSave(text: string | null, defaultHotbar: number[]): SaveData | null {
  if (!text) return null;
  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(text);
  } catch {
    return null;
  }
  if (!raw || typeof raw !== 'object' || raw.version !== 1 || !isInt(raw.seed, -(2 ** 31), 2 ** 32)) return null;
  const p = raw.player as Record<string, unknown> | null;
  const player =
    p && isNum(p.x) && isNum(p.y) && isNum(p.z) && isNum(p.yaw) && isNum(p.pitch)
      ? { x: p.x, y: p.y, z: p.z, yaw: p.yaw, pitch: Math.max(-1.55, Math.min(1.55, p.pitch)), flying: p.flying === true }
      : null;
  const hotbar = Array.isArray(raw.hotbar) && raw.hotbar.length === defaultHotbar.length && raw.hotbar.every((id) => isInt(id, 1, BLOCK_COUNT - 1)) ? (raw.hotbar as number[]) : [...defaultHotbar];
  const edits: SaveData['edits'] = [];
  if (Array.isArray(raw.edits)) {
    for (const entry of raw.edits) {
      if (!Array.isArray(entry) || !isInt(entry[0], -32768, 32767) || !isInt(entry[1], -32768, 32767) || !Array.isArray(entry[2])) continue;
      const flat = entry[2] as unknown[];
      // Pairs of a local index and a block that exists.
      const valid = flat.length % 2 === 0 && flat.every((v, i) => (i % 2 ? isInt(v, 0, BLOCK_COUNT - 1) : isInt(v, 0, 32767)));
      if (valid) edits.push([entry[0], entry[1], flat as number[]]);
    }
  }
  return {
    version: 1,
    seed: raw.seed,
    time: isNum(raw.time) ? (raw.time >= 0 && raw.time < 1 ? raw.time : ((raw.time % 1) + 1) % 1) : 0.05,
    player,
    hotbar,
    slot: isInt(raw.slot, 0, hotbar.length - 1) ? raw.slot : 0,
    edits,
  };
}

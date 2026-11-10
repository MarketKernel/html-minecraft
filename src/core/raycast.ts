/**
 * Which block the crosshair is on: a walk along the ray from cell to cell
 * (Amanatides & Woo), so no block is skipped however thin the slice it crosses.
 */
import type { BlockAt } from './physics';

export interface Hit {
  x: number;
  y: number;
  z: number;
  /** The face it entered through: where a placed block goes. */
  nx: number;
  ny: number;
  nz: number;
  id: number;
  distance: number;
}

export function raycast(get: BlockAt, ox: number, oy: number, oz: number, dx: number, dy: number, dz: number, maxDistance: number, pick: (id: number) => boolean): Hit | null {
  const len = Math.hypot(dx, dy, dz);
  dx /= len;
  dy /= len;
  dz /= len;
  let x = Math.floor(ox);
  let y = Math.floor(oy);
  let z = Math.floor(oz);
  const sx = Math.sign(dx);
  const sy = Math.sign(dy);
  const sz = Math.sign(dz);
  const tdx = sx ? Math.abs(1 / dx) : Infinity;
  const tdy = sy ? Math.abs(1 / dy) : Infinity;
  const tdz = sz ? Math.abs(1 / dz) : Infinity;
  let tx = sx > 0 ? (x + 1 - ox) * tdx : sx < 0 ? (ox - x) * tdx : Infinity;
  let ty = sy > 0 ? (y + 1 - oy) * tdy : sy < 0 ? (oy - y) * tdy : Infinity;
  let tz = sz > 0 ? (z + 1 - oz) * tdz : sz < 0 ? (oz - z) * tdz : Infinity;
  let nx = 0;
  let ny = 0;
  let nz = 0;
  let t = 0;
  while (t <= maxDistance) {
    const id = get(x, y, z);
    if (pick(id)) return { x, y, z, nx, ny, nz, id, distance: t };
    if (tx < ty && tx < tz) {
      x += sx;
      t = tx;
      tx += tdx;
      [nx, ny, nz] = [-sx, 0, 0];
    } else if (ty < tz) {
      y += sy;
      t = ty;
      ty += tdy;
      [nx, ny, nz] = [0, -sy, 0];
    } else {
      z += sz;
      t = tz;
      tz += tdz;
      [nx, ny, nz] = [0, 0, -sz];
    }
  }
  return null;
}

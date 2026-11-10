/**
 * The player as a box: walking, jumping, swimming and flying, pushed out of
 * solid blocks one axis at a time. Movement per sub-step stays under half a
 * block, so nothing is ever tunnelled through.
 */
import { isLiquid, SOLID } from './blocks';

export const HALF_WIDTH = 0.3;
export const BODY_HEIGHT = 1.8;
export const EYE_HEIGHT = 1.62;

const GRAVITY = 30;
const JUMP_SPEED = 9.2;
const EPS = 1e-4;

export interface Body {
  /** Feet, at the centre of the box's base. */
  x: number;
  y: number;
  z: number;
  vx: number;
  vy: number;
  vz: number;
  onGround: boolean;
  inWater: boolean;
  flying: boolean;
}

export interface Controls {
  /** -1 … 1 */
  forward: number;
  strafe: number;
  jump: boolean;
  descend: boolean;
  sprint: boolean;
  yaw: number;
}

export type BlockAt = (x: number, y: number, z: number) => number;

export function newBody(x: number, y: number, z: number): Body {
  return { x, y, z, vx: 0, vy: 0, vz: 0, onGround: false, inWater: false, flying: false };
}

/** Any solid block inside the box? */
export function collides(get: BlockAt, x: number, y: number, z: number): boolean {
  const x0 = Math.floor(x - HALF_WIDTH);
  const x1 = Math.floor(x + HALF_WIDTH - EPS);
  const y0 = Math.floor(y);
  const y1 = Math.floor(y + BODY_HEIGHT - EPS);
  const z0 = Math.floor(z - HALF_WIDTH);
  const z1 = Math.floor(z + HALF_WIDTH - EPS);
  for (let bx = x0; bx <= x1; bx++)
    for (let by = y0; by <= y1; by++) for (let bz = z0; bz <= z1; bz++) if (SOLID[get(bx, by, bz)]) return true;
  return false;
}

function touchesLiquid(get: BlockAt, b: Body): boolean {
  for (let y = Math.floor(b.y + 0.1); y <= Math.floor(b.y + 0.9); y++) {
    for (const [dx, dz] of [[-HALF_WIDTH, -HALF_WIDTH], [HALF_WIDTH, HALF_WIDTH], [-HALF_WIDTH, HALF_WIDTH], [HALF_WIDTH, -HALF_WIDTH]] as const) {
      if (isLiquid(get(Math.floor(b.x + dx), y, Math.floor(b.z + dz)))) return true;
    }
  }
  return false;
}

/** Moves along one axis and backs off to the face of whatever it ran into. True if it hit something. */
function moveAxis(get: BlockAt, b: Body, axis: 0 | 1 | 2, d: number): boolean {
  if (d === 0) return false;
  if (axis === 0) b.x += d;
  else if (axis === 1) b.y += d;
  else b.z += d;
  if (!collides(get, b.x, b.y, b.z)) return false;
  if (axis === 0) {
    b.x = d > 0 ? Math.floor(b.x + HALF_WIDTH) - HALF_WIDTH - EPS : Math.floor(b.x - HALF_WIDTH) + 1 + HALF_WIDTH + EPS;
    b.vx = 0;
  } else if (axis === 2) {
    b.z = d > 0 ? Math.floor(b.z + HALF_WIDTH) - HALF_WIDTH - EPS : Math.floor(b.z - HALF_WIDTH) + 1 + HALF_WIDTH + EPS;
    b.vz = 0;
  } else {
    if (d < 0) {
      b.y = Math.floor(b.y) + 1;
      b.onGround = true;
    } else {
      b.y = Math.floor(b.y + BODY_HEIGHT) - BODY_HEIGHT - EPS;
    }
    b.vy = 0;
  }
  return true;
}

/** Advances the body by dt seconds. Returns true when it bumped into a wall while walking. */
export function step(get: BlockAt, b: Body, c: Controls, dt: number): boolean {
  b.inWater = touchesLiquid(get, b);
  const fx = -Math.sin(c.yaw);
  const fz = -Math.cos(c.yaw);
  let wx = fx * c.forward + Math.cos(c.yaw) * c.strafe;
  let wz = fz * c.forward - Math.sin(c.yaw) * c.strafe;
  const len = Math.hypot(wx, wz);
  if (len > 1) {
    wx /= len;
    wz /= len;
  }
  const speed = b.flying ? (c.sprint ? 22 : 11) : b.inWater ? 3.2 : c.sprint ? 5.8 : 4.4;
  const grip = b.flying ? 10 : b.inWater ? 6 : b.onGround ? 18 : 5;
  const k = Math.min(1, grip * dt);
  b.vx += (wx * speed - b.vx) * k;
  b.vz += (wz * speed - b.vz) * k;

  if (b.flying) {
    const target = ((c.jump ? 1 : 0) - (c.descend ? 1 : 0)) * speed * 0.8;
    b.vy += (target - b.vy) * Math.min(1, 12 * dt);
  } else if (b.inWater) {
    b.vy -= 9 * dt;
    b.vy *= 1 - Math.min(1, 2.5 * dt);
    if (c.jump) b.vy = Math.min(4, b.vy + 24 * dt);
  } else {
    b.vy = Math.max(-55, b.vy - GRAVITY * dt);
    if (c.jump && b.onGround) b.vy = JUMP_SPEED;
  }

  const travel = Math.max(Math.abs(b.vx), Math.abs(b.vy), Math.abs(b.vz)) * dt;
  const steps = Math.max(1, Math.ceil(travel / 0.4));
  const h = dt / steps;
  let bumped = false;
  const wasOnGround = b.onGround;
  b.onGround = false;
  for (let i = 0; i < steps; i++) {
    bumped = moveAxis(get, b, 0, b.vx * h) || bumped;
    bumped = moveAxis(get, b, 2, b.vz * h) || bumped;
    moveAxis(get, b, 1, b.vy * h);
  }
  // Landing ends a flight, as in the original.
  if (b.flying && b.onGround && c.descend) b.flying = false;
  return bumped && wasOnGround && len > 0.1;
}

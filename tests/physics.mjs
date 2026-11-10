/** The player's box against the blocks, and the crosshair's ray. */
import { checker, load } from '../tools/load.mjs';

const { check, done } = checker();
const C = await load('core/physics', 'core/raycast', 'core/blocks', 'core/math');

/** A flat floor at y = 10 with a wall at x = 5 and a pool at z ≥ 20. */
const get = (x, y, z) => {
  if (y <= 10) return C.B.STONE;
  if (x === 5 && y <= 13) return C.B.STONE;
  if (z >= 20 && y <= 13 && x < 5) return C.B.WATER;
  return C.B.AIR;
};
const idle = { forward: 0, strafe: 0, jump: false, descend: false, sprint: false, yaw: 0 };
const run = (body, controls, seconds) => {
  for (let t = 0; t < seconds; t += 1 / 60) C.step(get, body, controls, 1 / 60);
  return body;
};
const near = (a, b, eps = 1e-3) => Math.abs(a - b) < eps;

{
  const b = run(C.newBody(0.5, 20, 0.5), idle, 2);
  check('falls and lands on the floor', [near(b.y, 11), b.onGround], [true, true]);
  const before = b.y;
  run(b, { ...idle, jump: true }, 0.2);
  check('jumps', b.y > before + 0.5, true);
  run(b, idle, 1.5);
  check('comes back down', near(b.y, 11), true);
}
{
  // yaw -π/2 looks along +x.
  const b = run(C.newBody(2.5, 11, 0.5), { ...idle, forward: 1, yaw: -Math.PI / 2 }, 3);
  check('a wall stops it', near(b.x, 5 - C.HALF_WIDTH, 0.01), true);
  check('…without passing through', b.x < 5, true);
}
{
  const b = run(C.newBody(0.5, 11, 0.5), { ...idle, forward: 1, sprint: true }, 1);
  check('sprints toward -z at about 5.8 blocks/s', b.z < -4.5 && b.z > -6, true);
}
{
  const b = run(C.newBody(2.5, 11, 22.5), idle, 0.5);
  check('the pool is water', b.inWater, true);
  const sink = b.vy;
  run(b, { ...idle, jump: true }, 0.5);
  check('swims up', b.vy > sink && b.vy > 0, true);
}
{
  const b = C.newBody(0.5, 30, 0.5);
  b.flying = true;
  run(b, idle, 1);
  check('hovers when flying', near(b.y, 30, 0.05), true);
  run(b, { ...idle, jump: true }, 1);
  check('rises when flying', b.y > 35, true);
}
{
  // A fast fall over many frames does not tunnel through the floor.
  const b = C.newBody(0.5, 100, 0.5);
  b.vy = -55;
  for (let i = 0; i < 60; i++) C.step(get, b, idle, 0.05);
  check('no tunnelling at full speed', near(b.y, 11), true);
}

// Raycast.
{
  const pick = (id) => id !== C.B.AIR && id !== C.B.WATER;
  const hit = C.raycast(get, 0.5, 12.5, 0.5, 1, 0, 0, 10, pick);
  check('hits the wall', [hit.x, hit.y, hit.z], [5, 12, 0]);
  check('…on its -x face', [hit.nx, hit.ny, hit.nz], [-1, 0, 0]);
  check('…at the right distance', near(hit.distance, 4.5), true);
  const down = C.raycast(get, 0.5, 12.5, 0.5, 0, -1, 0, 10, pick);
  check('looking down hits the floor top', [down.y, down.ny], [10, 1]);
  check('out of reach is no hit', C.raycast(get, 0.5, 12.5, 0.5, 0, 1, 0, 50, pick), null);
  const diag = C.raycast(get, 0.5, 12.5, 0.5, 1, -0.2, 0.3, 20, pick);
  check('a slanted ray finds the floor or the wall', diag !== null, true);
}

// Matrices: the view looks where lookDirection says.
{
  const [dx, dy, dz] = C.lookDirection(0.7, 0.3);
  const v = C.viewMatrix(1, 2, 3, 0.7, 0.3);
  const p = [1 + dx * 5, 2 + dy * 5, 3 + dz * 5];
  const out = [0, 1, 2].map((r) => v[r] * p[0] + v[4 + r] * p[1] + v[8 + r] * p[2] + v[12 + r]);
  check('a point ahead lands on -z in view space', out.map((x) => Math.round(x * 1000) / 1000), [0, 0, -5]);
  const m = C.multiply(C.perspective(1.2, 1.5, 0.1, 500), v);
  const back = C.multiply(m, C.invert(m));
  check('invert inverts', [...back].map((x) => Math.round(x * 1e4) / 1e4), [...C.identity()]);
  const planes = C.frustumPlanes(m);
  check('a box ahead is visible', C.boxVisible(planes, p[0] - 1, p[1] - 1, p[2] - 1, p[0] + 1, p[1] + 1, p[2] + 1), true);
  const q = [1 - dx * 5, 2 - dy * 5, 3 - dz * 5];
  check('a box behind is not', C.boxVisible(planes, q[0] - 1, q[1] - 1, q[2] - 1, q[0] + 1, q[1] + 1, q[2] + 1), false);
}
done('physics');

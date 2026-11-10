/** Column-major 4×4 matrices, as WebGL takes them, and frustum culling. */

export type Mat4 = Float32Array;

export const identity = (): Mat4 => new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);

export function perspective(fovy: number, aspect: number, near: number, far: number): Mat4 {
  const f = 1 / Math.tan(fovy / 2);
  const m = new Float32Array(16);
  m[0] = f / aspect;
  m[5] = f;
  m[10] = (far + near) / (near - far);
  m[11] = -1;
  m[14] = (2 * far * near) / (near - far);
  return m;
}

export function multiply(a: Mat4, b: Mat4): Mat4 {
  const out = new Float32Array(16);
  for (let c = 0; c < 4; c++) {
    for (let r = 0; r < 4; r++) {
      let s = 0;
      for (let k = 0; k < 4; k++) s += a[k * 4 + r]! * b[c * 4 + k]!;
      out[c * 4 + r] = s;
    }
  }
  return out;
}

export function translation(x: number, y: number, z: number): Mat4 {
  const m = identity();
  m[12] = x;
  m[13] = y;
  m[14] = z;
  return m;
}

export function scaling(s: number): Mat4 {
  const m = identity();
  m[0] = m[5] = m[10] = s;
  return m;
}

export function rotationX(a: number): Mat4 {
  const m = identity();
  const c = Math.cos(a);
  const s = Math.sin(a);
  m[5] = c;
  m[6] = s;
  m[9] = -s;
  m[10] = c;
  return m;
}

export function rotationY(a: number): Mat4 {
  const m = identity();
  const c = Math.cos(a);
  const s = Math.sin(a);
  m[0] = c;
  m[2] = -s;
  m[8] = s;
  m[10] = c;
  return m;
}

export function rotationZ(a: number): Mat4 {
  const m = identity();
  const c = Math.cos(a);
  const s = Math.sin(a);
  m[0] = c;
  m[1] = s;
  m[4] = -s;
  m[5] = c;
  return m;
}

/** The view of a camera at eye, turned by yaw (0 looks to -z) and tilted by pitch (up is positive). */
export function viewMatrix(x: number, y: number, z: number, yaw: number, pitch: number): Mat4 {
  return multiply(rotationX(-pitch), multiply(rotationY(-yaw), translation(-x, -y, -z)));
}

/** Where the camera looks, as a unit vector. */
export function lookDirection(yaw: number, pitch: number): [number, number, number] {
  return [-Math.sin(yaw) * Math.cos(pitch), Math.sin(pitch), -Math.cos(yaw) * Math.cos(pitch)];
}

export function invert(m: Mat4): Mat4 {
  const inv = new Float32Array(16);
  const [a00, a01, a02, a03, a10, a11, a12, a13, a20, a21, a22, a23, a30, a31, a32, a33] = m as unknown as number[];
  const b00 = a00! * a11! - a01! * a10!;
  const b01 = a00! * a12! - a02! * a10!;
  const b02 = a00! * a13! - a03! * a10!;
  const b03 = a01! * a12! - a02! * a11!;
  const b04 = a01! * a13! - a03! * a11!;
  const b05 = a02! * a13! - a03! * a12!;
  const b06 = a20! * a31! - a21! * a30!;
  const b07 = a20! * a32! - a22! * a30!;
  const b08 = a20! * a33! - a23! * a30!;
  const b09 = a21! * a32! - a22! * a31!;
  const b10 = a21! * a33! - a23! * a31!;
  const b11 = a22! * a33! - a23! * a32!;
  const det = b00 * b11 - b01 * b10 + b02 * b09 + b03 * b08 - b04 * b07 + b05 * b06;
  const d = det ? 1 / det : 0;
  inv[0] = (a11! * b11 - a12! * b10 + a13! * b09) * d;
  inv[1] = (a02! * b10 - a01! * b11 - a03! * b09) * d;
  inv[2] = (a31! * b05 - a32! * b04 + a33! * b03) * d;
  inv[3] = (a22! * b04 - a21! * b05 - a23! * b03) * d;
  inv[4] = (a12! * b08 - a10! * b11 - a13! * b07) * d;
  inv[5] = (a00! * b11 - a02! * b08 + a03! * b07) * d;
  inv[6] = (a32! * b02 - a30! * b05 - a33! * b01) * d;
  inv[7] = (a20! * b05 - a22! * b02 + a23! * b01) * d;
  inv[8] = (a10! * b10 - a11! * b08 + a13! * b06) * d;
  inv[9] = (a01! * b08 - a00! * b10 - a03! * b06) * d;
  inv[10] = (a30! * b04 - a31! * b02 + a33! * b00) * d;
  inv[11] = (a21! * b02 - a20! * b04 - a23! * b00) * d;
  inv[12] = (a11! * b07 - a10! * b09 - a12! * b06) * d;
  inv[13] = (a00! * b09 - a01! * b07 + a02! * b06) * d;
  inv[14] = (a31! * b01 - a30! * b03 - a32! * b00) * d;
  inv[15] = (a20! * b03 - a21! * b01 + a22! * b00) * d;
  return inv;
}

/** The six planes of a view-projection matrix, as [a, b, c, d] with the inside positive. */
export function frustumPlanes(m: Mat4): Float32Array {
  const planes = new Float32Array(24);
  const row = (r: number, i: number) => m[i * 4 + r]!;
  for (let p = 0; p < 6; p++) {
    const r = p >> 1;
    const sign = p & 1 ? -1 : 1;
    for (let i = 0; i < 4; i++) planes[p * 4 + i] = row(3, i) + sign * row(r, i);
  }
  return planes;
}

/** False only when the box lies wholly outside one of the planes. */
export function boxVisible(planes: Float32Array, x0: number, y0: number, z0: number, x1: number, y1: number, z1: number): boolean {
  for (let p = 0; p < 6; p++) {
    const a = planes[p * 4]!;
    const b = planes[p * 4 + 1]!;
    const c = planes[p * 4 + 2]!;
    const d = planes[p * 4 + 3]!;
    // The corner furthest along the plane's normal.
    if (a * (a > 0 ? x1 : x0) + b * (b > 0 ? y1 : y0) + c * (c > 0 ? z1 : z0) + d < 0) return false;
  }
  return true;
}

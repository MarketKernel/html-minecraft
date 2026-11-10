/**
 * Everything drawn with WebGL2, in this order: the sky (a full-screen
 * triangle that works out the sun, the moon, stars and clouds per pixel), the
 * chunks, the outline of the targeted block, particles, see-through water and,
 * over a cleared depth buffer, the block in the player's hand.
 *
 * Textures live in one TEXTURE_2D_ARRAY, a layer per tile: mipmaps without the
 * bleeding an atlas has, and a quad's UVs are simply 0–1.
 */
import { TILES } from '../core/blocks';
import {
  boxVisible, frustumPlanes, invert, type Mat4, multiply, rotationX as rotX, rotationY as rotY, scaling as scale, translation as translationOf,
} from '../core/math';
import { meshBlock, VERTEX_BYTES, type ChunkMesh } from '../core/mesher';
import { TILE } from '../core/textures';
import { CHUNK } from '../core/terrain';

const CHUNK_VS = `#version 300 es
layout(location = 0) in vec4 aPos;
layout(location = 1) in vec4 aTex;
layout(location = 2) in vec4 aLight;
uniform mat4 uViewProj;
uniform vec3 uOrigin;
uniform vec3 uCam;
uniform float uTime;
out vec3 vUV;
out vec3 vLight;
out float vDist;
flat out int vFlags;
void main() {
  vec3 p = aPos.xyz / 16.0 + uOrigin;
  int flags = int(aTex.w + 0.5);
  if ((flags & 1) != 0 && mod(aPos.y, 16.0) > 0.5) {
    p.y += sin(uTime * 1.8 + p.x * 0.6 + p.z * 0.8) * 0.045 - 0.03;
  }
  if ((flags & 2) != 0) {
    float w = uTime * 1.6 + p.x * 0.4 + p.z * 0.3 + p.y * 0.2;
    p.x += sin(w) * 0.035;
    p.z += cos(w * 0.8) * 0.03;
  }
  vUV = vec3(aTex.xy, aTex.z);
  vLight = aLight.xyz;
  vFlags = flags;
  vDist = length(p.xz - uCam.xz);
  gl_Position = uViewProj * vec4(p, 1.0);
}`;

const CHUNK_FS = `#version 300 es
precision highp float;
precision highp sampler2DArray;
uniform sampler2DArray uAtlas;
uniform vec3 uSkyLight;
uniform vec3 uFogColor;
uniform vec2 uFog;
uniform float uTime;
uniform int uPass;
in vec3 vUV;
in vec3 vLight;
in float vDist;
flat in int vFlags;
out vec4 outColor;
void main() {
  vec3 uv = vUV;
  if ((vFlags & 8) != 0) uv.xy += vec2(uTime * 0.02, uTime * 0.045);
  vec4 c = texture(uAtlas, uv);
  if (uPass == 0 && c.a < 0.5) discard;
  vec3 light;
  if ((vFlags & 4) != 0) {
    light = vec3(1.0);
  } else {
    vec3 sky = uSkyLight * vLight.y;
    vec3 torch = vec3(1.0, 0.82, 0.55) * vLight.z * 1.1;
    light = max(max(sky, torch), vec3(0.035)) * vLight.x;
  }
  vec3 col = c.rgb * light;
  float fog = smoothstep(uFog.x, uFog.y, vDist);
  outColor = vec4(mix(col, uFogColor, fog), uPass == 1 ? c.a : 1.0);
}`;

const SKY_VS = `#version 300 es
out vec2 vClip;
void main() {
  vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2)) * 2.0 - 1.0;
  vClip = p;
  gl_Position = vec4(p, 0.0, 1.0);
}`;

const SKY_FS = `#version 300 es
precision highp float;
uniform mat4 uInvViewProj;
uniform vec3 uCam;
uniform vec3 uSunDir;
uniform vec3 uZenith;
uniform vec3 uHorizon;
uniform vec3 uGlow;
uniform float uNight;
uniform float uTime;
uniform float uCloudLight;
in vec2 vClip;
out vec4 outColor;
float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float hash3(vec3 p) { return fract(sin(dot(p, vec3(127.1, 311.7, 74.7))) * 43758.5453); }
float vnoise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash(i), hash(i + vec2(1, 0)), f.x), mix(hash(i + vec2(0, 1)), hash(i + vec2(1, 1)), f.x), f.y);
}
/** A square disc around direction d, the way the original draws its sun. */
float square(vec3 dir, vec3 d, float size) {
  float facing = dot(dir, d);
  if (facing <= 0.0) return 0.0;
  vec3 r = normalize(cross(d, vec3(0.0, 0.0, 1.0)));
  vec3 u = cross(r, d);
  vec2 q = vec2(dot(dir, r), dot(dir, u)) / facing;
  return step(max(abs(q.x), abs(q.y)), size);
}
void main() {
  vec4 far = uInvViewProj * vec4(vClip, 1.0, 1.0);
  vec3 dir = normalize(far.xyz / far.w - uCam);
  float up = max(dir.y, 0.0);
  vec3 col = mix(uHorizon, uZenith, pow(up, 0.55));
  // Below the horizon the sky is the fog colour, so the far terrain fades into it without a seam.
  if (dir.y < 0.0) col = uHorizon;
  // Sunrise and sunset light up the sky around the sun near the horizon.
  float toward = max(dot(dir, normalize(vec3(uSunDir.x, 0.0, uSunDir.z))), 0.0);
  col += uGlow * pow(toward, 4.0) * (1.0 - min(1.0, abs(dir.y) * 2.5));
  // Stars.
  if (uNight > 0.0 && dir.y > 0.0) {
    vec3 cell = floor(dir * 160.0);
    float h = hash3(cell);
    if (h > 0.996) col += vec3(0.9, 0.95, 1.0) * (h - 0.996) * 250.0 * uNight * smoothstep(0.0, 0.25, dir.y);
  }
  float sun = square(dir, uSunDir, 0.085);
  float sunHalo = pow(max(dot(dir, uSunDir), 0.0), 220.0);
  col = mix(col, vec3(1.0, 0.97, 0.78), sun);
  col += vec3(1.0, 0.8, 0.45) * sunHalo * 0.6;
  float moon = square(dir, -uSunDir, 0.055);
  col = mix(col, vec3(0.86, 0.9, 1.0), moon * 0.95);
  // Flat blocky clouds drifting on a plane high up.
  float t = (180.0 - uCam.y) / dir.y;
  if (t > 0.0 && t < 3000.0) {
    vec2 p = uCam.xz + dir.xz * t + vec2(uTime * 2.0, uTime * 0.6);
    vec2 cell = floor(p / 14.0);
    float n = vnoise(cell * 0.11) * 0.7 + vnoise(cell * 0.37) * 0.3;
    if (n > 0.58) {
      float fade = 1.0 - smoothstep(600.0, 2600.0, t);
      vec3 cloud = mix(vec3(0.13, 0.15, 0.25), vec3(1.0), uCloudLight) + uGlow * 0.3;
      col = mix(col, cloud, 0.85 * fade);
    }
  }
  outColor = vec4(col, 1.0);
}`;

const LINE_VS = `#version 300 es
layout(location = 0) in vec3 aPos;
uniform mat4 uViewProj;
uniform vec3 uOffset;
uniform float uScale;
void main() { gl_Position = uViewProj * vec4((aPos - 0.5) * uScale + 0.5 + uOffset, 1.0); }`;

const LINE_FS = `#version 300 es
precision mediump float;
uniform vec4 uColor;
out vec4 outColor;
void main() { outColor = uColor; }`;

const PARTICLE_VS = `#version 300 es
layout(location = 0) in vec4 aPos;
layout(location = 1) in vec4 aTex;
uniform mat4 uViewProj;
uniform float uScale;
out vec3 vTex;
out float vLight;
void main() {
  gl_Position = uViewProj * vec4(aPos.xyz, 1.0);
  gl_PointSize = clamp(aPos.w * uScale / gl_Position.w, 1.0, 64.0);
  vTex = aTex.xyz;
  vLight = aTex.w;
}`;

const PARTICLE_FS = `#version 300 es
precision highp float;
precision highp sampler2DArray;
uniform sampler2DArray uAtlas;
in vec3 vTex;
in float vLight;
out vec4 outColor;
void main() {
  vec4 c = texture(uAtlas, vec3(vTex.xy + gl_PointCoord * 0.25, vTex.z));
  if (c.a < 0.5) discard;
  outColor = vec4(c.rgb * vLight, 1.0);
}`;

export interface Particle {
  x: number;
  y: number;
  z: number;
  vx: number;
  vy: number;
  vz: number;
  life: number;
  size: number;
  layer: number;
  u: number;
  v: number;
  light: number;
}

export interface Frame {
  view: Mat4;
  proj: Mat4;
  cam: [number, number, number];
  time: number;
  /** Fraction of the day: 0 sunrise, 0.25 noon, 0.5 sunset, 0.75 midnight. */
  dayTime: number;
  renderDistance: number;
  underwater: boolean;
  target: [number, number, number] | null;
  /** Primed TNT, flashing white. */
  flashes: { x: number; y: number; z: number; on: boolean }[];
  particles: Particle[];
  hand: { id: number; swing: number; bob: number } | null;
}

interface GpuChunk {
  cx: number;
  cz: number;
  maxY: number;
  solid: WebGLVertexArrayObject | null;
  solidBuffer: WebGLBuffer | null;
  solidQuads: number;
  water: WebGLVertexArrayObject | null;
  waterBuffer: WebGLBuffer | null;
  waterQuads: number;
}

type Uniforms = Record<string, WebGLUniformLocation | null>;

const mix = (a: number[], b: number[], t: number) => a.map((v, i) => v + (b[i]! - v) * t);
const smooth = (a: number, b: number, x: number) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

/** The colours of the sky over the day. */
export function skyColors(dayTime: number) {
  const angle = dayTime * Math.PI * 2;
  const sun: [number, number, number] = [Math.cos(angle), Math.sin(angle), 0.25];
  const len = Math.hypot(...sun);
  sun.forEach((_, i) => (sun[i]! /= len));
  const day = smooth(-0.12, 0.22, sun[1]);
  const dusk = Math.max(0, 1 - Math.abs(sun[1]) / 0.3) * (sun[1] > -0.2 ? 1 : 0);
  const zenith = mix([0.01, 0.015, 0.05], [0.24, 0.5, 0.95], day);
  const horizon = mix(mix([0.03, 0.04, 0.1], [0.62, 0.8, 1.0], day), [0.98, 0.5, 0.25], dusk * 0.55);
  const glow = [0.9 * dusk, 0.38 * dusk, 0.12 * dusk];
  const skyLight = mix([0.13, 0.16, 0.3], [1, 1, 1], day);
  return { sun, day, zenith, horizon, glow, skyLight };
}

export class Renderer {
  readonly gl: WebGL2RenderingContext;
  private readonly chunk: { program: WebGLProgram; u: Uniforms };
  private readonly sky: { program: WebGLProgram; u: Uniforms };
  private readonly line: { program: WebGLProgram; u: Uniforms };
  private readonly particle: { program: WebGLProgram; u: Uniforms };
  private readonly atlas: WebGLTexture;
  private readonly indices: WebGLBuffer;
  private indexQuads = 0;
  private readonly chunks = new Map<number, GpuChunk>();
  private readonly lineVao: WebGLVertexArrayObject;
  private readonly cubeVao: WebGLVertexArrayObject;
  private readonly particleVao: WebGLVertexArrayObject;
  private readonly particleBuffer: WebGLBuffer;
  private readonly hands = new Map<number, { vao: WebGLVertexArrayObject; quads: number }>();
  private readonly emptyVao: WebGLVertexArrayObject;
  /** Drawn last frame, for the debug screen. */
  stats = { chunks: 0, quads: 0 };

  constructor(readonly canvas: HTMLCanvasElement, tiles: Uint8Array) {
    const gl = canvas.getContext('webgl2', { antialias: false, powerPreference: 'high-performance' });
    if (!gl) throw new Error('WebGL2 is not available');
    this.gl = gl;
    this.chunk = this.program(CHUNK_VS, CHUNK_FS, ['uViewProj', 'uOrigin', 'uCam', 'uTime', 'uAtlas', 'uSkyLight', 'uFogColor', 'uFog', 'uPass']);
    this.sky = this.program(SKY_VS, SKY_FS, ['uInvViewProj', 'uCam', 'uSunDir', 'uZenith', 'uHorizon', 'uGlow', 'uNight', 'uTime', 'uCloudLight']);
    this.line = this.program(LINE_VS, LINE_FS, ['uViewProj', 'uOffset', 'uScale', 'uColor']);
    this.particle = this.program(PARTICLE_VS, PARTICLE_FS, ['uViewProj', 'uScale', 'uAtlas']);

    this.atlas = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D_ARRAY, this.atlas);
    gl.texImage3D(gl.TEXTURE_2D_ARRAY, 0, gl.RGBA8, TILE, TILE, TILES.length, 0, gl.RGBA, gl.UNSIGNED_BYTE, tiles);
    gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MIN_FILTER, gl.NEAREST_MIPMAP_LINEAR);
    gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MAX_LEVEL, 3);
    gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_WRAP_S, gl.REPEAT);
    gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_WRAP_T, gl.REPEAT);
    gl.generateMipmap(gl.TEXTURE_2D_ARRAY);

    this.indices = gl.createBuffer()!;
    this.ensureIndices(32768);

    // The outline: a cube's twelve edges.
    const edges: number[] = [];
    for (const [a, b] of [[0, 1], [1, 3], [3, 2], [2, 0], [4, 5], [5, 7], [7, 6], [6, 4], [0, 4], [1, 5], [2, 6], [3, 7]]) {
      for (const c of [a!, b!]) edges.push(c & 1, (c >> 1) & 1, (c >> 2) & 1);
    }
    this.lineVao = this.positions(new Float32Array(edges));
    // A solid cube for flashing TNT: 6 faces × 2 triangles.
    const tris: number[] = [];
    const face = (o: number[], a: number[], b: number[]) => {
      const p = (s: number, t: number) => o.map((v, i) => v + a[i]! * s + b[i]! * t);
      tris.push(...p(0, 0), ...p(1, 0), ...p(1, 1), ...p(0, 0), ...p(1, 1), ...p(0, 1));
    };
    face([0, 0, 0], [1, 0, 0], [0, 1, 0]);
    face([0, 0, 1], [1, 0, 0], [0, 1, 0]);
    face([0, 0, 0], [0, 0, 1], [0, 1, 0]);
    face([1, 0, 0], [0, 0, 1], [0, 1, 0]);
    face([0, 0, 0], [1, 0, 0], [0, 0, 1]);
    face([0, 1, 0], [1, 0, 0], [0, 0, 1]);
    this.cubeVao = this.positions(new Float32Array(tris));

    this.particleVao = gl.createVertexArray()!;
    this.particleBuffer = gl.createBuffer()!;
    gl.bindVertexArray(this.particleVao);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.particleBuffer);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 4, gl.FLOAT, false, 32, 0);
    gl.enableVertexAttribArray(1);
    gl.vertexAttribPointer(1, 4, gl.FLOAT, false, 32, 16);
    this.emptyVao = gl.createVertexArray()!;
    gl.bindVertexArray(null);
  }

  private program(vs: string, fs: string, names: string[]) {
    const gl = this.gl;
    const compile = (type: number, source: string) => {
      const s = gl.createShader(type)!;
      gl.shaderSource(s, source);
      gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(`Shader: ${gl.getShaderInfoLog(s)}`);
      return s;
    };
    const program = gl.createProgram()!;
    gl.attachShader(program, compile(gl.VERTEX_SHADER, vs));
    gl.attachShader(program, compile(gl.FRAGMENT_SHADER, fs));
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error(`Program: ${gl.getProgramInfoLog(program)}`);
    const u: Uniforms = {};
    for (const name of names) u[name] = gl.getUniformLocation(program, name);
    return { program, u };
  }

  private positions(data: Float32Array): WebGLVertexArrayObject {
    const gl = this.gl;
    const vao = gl.createVertexArray()!;
    gl.bindVertexArray(vao);
    const buffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    gl.bufferData(gl.ARRAY_BUFFER, data, gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 0, 0);
    gl.bindVertexArray(null);
    return vao;
  }

  /**
   * One index buffer serves every chunk: quad n is 4n, 4n+1, 4n+2, 4n, 4n+2, 4n+3.
   * Growing it refills the same buffer object, so the VAOs that point at it stay valid.
   */
  private ensureIndices(quads: number): void {
    if (quads <= this.indexQuads) return;
    let n = Math.max(this.indexQuads, 1024);
    while (n < quads) n *= 2;
    const data = new Uint32Array(n * 6);
    for (let q = 0; q < n; q++) {
      const v = q * 4;
      data.set([v, v + 1, v + 2, v, v + 2, v + 3], q * 6);
    }
    const gl = this.gl;
    gl.bindVertexArray(null);
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.indices);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, data, gl.STATIC_DRAW);
    this.indexQuads = n;
  }

  private vertexArray(data: Uint8Array): [WebGLVertexArrayObject, WebGLBuffer] {
    const gl = this.gl;
    const vao = gl.createVertexArray()!;
    gl.bindVertexArray(vao);
    const buffer = gl.createBuffer()!;
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    gl.bufferData(gl.ARRAY_BUFFER, data, gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 4, gl.SHORT, false, VERTEX_BYTES, 0);
    gl.enableVertexAttribArray(1);
    gl.vertexAttribPointer(1, 4, gl.UNSIGNED_BYTE, false, VERTEX_BYTES, 8);
    gl.enableVertexAttribArray(2);
    gl.vertexAttribPointer(2, 4, gl.UNSIGNED_BYTE, true, VERTEX_BYTES, 12);
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.indices);
    gl.bindVertexArray(null);
    return [vao, buffer];
  }

  setChunk(key: number, cx: number, cz: number, mesh: ChunkMesh): void {
    this.removeChunk(key);
    this.ensureIndices(Math.max(mesh.solidQuads, mesh.waterQuads));
    const g: GpuChunk = { cx, cz, maxY: mesh.maxY, solid: null, solidBuffer: null, solidQuads: mesh.solidQuads, water: null, waterBuffer: null, waterQuads: mesh.waterQuads };
    if (mesh.solidQuads) [g.solid, g.solidBuffer] = this.vertexArray(mesh.solid);
    if (mesh.waterQuads) [g.water, g.waterBuffer] = this.vertexArray(mesh.water);
    this.chunks.set(key, g);
  }

  removeChunk(key: number): void {
    const g = this.chunks.get(key);
    if (!g) return;
    const gl = this.gl;
    gl.deleteVertexArray(g.solid);
    gl.deleteBuffer(g.solidBuffer);
    gl.deleteVertexArray(g.water);
    gl.deleteBuffer(g.waterBuffer);
    this.chunks.delete(key);
  }

  hasChunk(key: number): boolean {
    return this.chunks.has(key);
  }

  clearChunks(): void {
    for (const key of [...this.chunks.keys()]) this.removeChunk(key);
  }

  get chunkCount(): number {
    return this.chunks.size;
  }

  private handMesh(id: number) {
    let hand = this.hands.get(id);
    if (!hand) {
      const mesh = meshBlock(id);
      this.ensureIndices(mesh.quads);
      hand = { vao: this.vertexArray(mesh.data)[0], quads: mesh.quads };
      this.hands.set(id, hand);
    }
    return hand;
  }

  resize(): void {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const w = Math.floor(this.canvas.clientWidth * dpr);
    const h = Math.floor(this.canvas.clientHeight * dpr);
    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas.width = w;
      this.canvas.height = h;
    }
  }

  render(f: Frame): void {
    const gl = this.gl;
    this.resize();
    gl.viewport(0, 0, this.canvas.width, this.canvas.height);
    const viewProj = multiply(f.proj, f.view);
    const sky = skyColors(f.dayTime);
    const fogColor = f.underwater ? [0.08, 0.22, 0.5].map((v) => v * (0.3 + 0.7 * sky.day)) : sky.horizon;
    const far = (f.renderDistance - 0.5) * CHUNK;
    const fog: [number, number] = f.underwater ? [1, 22] : [far * 0.62, far];

    gl.clearColor(fogColor[0]!, fogColor[1]!, fogColor[2]!, 1);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);

    // Sky.
    gl.disable(gl.DEPTH_TEST);
    gl.depthMask(false);
    gl.useProgram(this.sky.program);
    const su = this.sky.u;
    gl.uniformMatrix4fv(su.uInvViewProj!, false, invertViewProj(f));
    gl.uniform3fv(su.uCam!, f.cam);
    gl.uniform3fv(su.uSunDir!, sky.sun);
    gl.uniform3fv(su.uZenith!, sky.zenith);
    gl.uniform3fv(su.uHorizon!, sky.horizon);
    gl.uniform3fv(su.uGlow!, sky.glow);
    gl.uniform1f(su.uNight!, 1 - sky.day);
    gl.uniform1f(su.uTime!, f.time);
    gl.uniform1f(su.uCloudLight!, sky.day);
    gl.bindVertexArray(this.emptyVao);
    if (!f.underwater) gl.drawArrays(gl.TRIANGLES, 0, 3);

    // Chunks.
    gl.enable(gl.DEPTH_TEST);
    gl.depthMask(true);
    gl.enable(gl.CULL_FACE);
    gl.useProgram(this.chunk.program);
    const cu = this.chunk.u;
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D_ARRAY, this.atlas);
    gl.uniform1i(cu.uAtlas!, 0);
    gl.uniformMatrix4fv(cu.uViewProj!, false, viewProj);
    gl.uniform3fv(cu.uCam!, f.cam);
    gl.uniform1f(cu.uTime!, f.time);
    gl.uniform3fv(cu.uSkyLight!, sky.skyLight);
    gl.uniform3fv(cu.uFogColor!, fogColor);
    gl.uniform2fv(cu.uFog!, fog);
    gl.uniform1i(cu.uPass!, 0);
    const planes = frustumPlanes(viewProj);
    const visible: GpuChunk[] = [];
    let quads = 0;
    const [camX, , camZ] = f.cam;
    const limit = (f.renderDistance + 0.75) * CHUNK;
    for (const g of this.chunks.values()) {
      const x0 = g.cx * CHUNK;
      const z0 = g.cz * CHUNK;
      const dx = Math.max(x0 - camX, 0, camX - x0 - CHUNK);
      const dz = Math.max(z0 - camZ, 0, camZ - z0 - CHUNK);
      if (dx * dx + dz * dz > limit * limit) continue;
      if (!boxVisible(planes, x0, 0, z0, x0 + CHUNK, g.maxY + 1, z0 + CHUNK)) continue;
      visible.push(g);
      if (!g.solidQuads) continue;
      gl.uniform3f(cu.uOrigin!, x0, 0, z0);
      gl.bindVertexArray(g.solid);
      gl.drawElements(gl.TRIANGLES, g.solidQuads * 6, gl.UNSIGNED_INT, 0);
      quads += g.solidQuads;
    }

    // The targeted block's outline.
    if (f.target) {
      gl.useProgram(this.line.program);
      gl.uniformMatrix4fv(this.line.u.uViewProj!, false, viewProj);
      gl.uniform3fv(this.line.u.uOffset!, f.target);
      gl.uniform1f(this.line.u.uScale!, 1.004);
      gl.uniform4f(this.line.u.uColor!, 0.05, 0.05, 0.05, 1);
      gl.bindVertexArray(this.lineVao);
      gl.drawArrays(gl.LINES, 0, 24);
    }

    // Particles.
    if (f.particles.length) {
      const data = new Float32Array(f.particles.length * 8);
      f.particles.forEach((p, i) => data.set([p.x, p.y, p.z, p.size, p.u, p.v, p.layer, p.light], i * 8));
      gl.useProgram(this.particle.program);
      gl.uniformMatrix4fv(this.particle.u.uViewProj!, false, viewProj);
      gl.uniform1f(this.particle.u.uScale!, (this.canvas.height * f.proj[5]!) / 2);
      gl.uniform1i(this.particle.u.uAtlas!, 0);
      gl.bindVertexArray(this.particleVao);
      gl.bindBuffer(gl.ARRAY_BUFFER, this.particleBuffer);
      gl.bufferData(gl.ARRAY_BUFFER, data, gl.STREAM_DRAW);
      gl.drawArrays(gl.POINTS, 0, f.particles.length);
    }

    // Water, back to front, seen from above and from below.
    gl.disable(gl.CULL_FACE);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    gl.depthMask(false);
    gl.useProgram(this.chunk.program);
    gl.uniform1i(cu.uPass!, 1);
    const dist = (g: GpuChunk) => (g.cx * CHUNK + 8 - camX) ** 2 + (g.cz * CHUNK + 8 - camZ) ** 2;
    for (const g of visible.filter((g) => g.waterQuads).sort((a, b) => dist(b) - dist(a))) {
      gl.uniform3f(cu.uOrigin!, g.cx * CHUNK, 0, g.cz * CHUNK);
      gl.bindVertexArray(g.water);
      gl.drawElements(gl.TRIANGLES, g.waterQuads * 6, gl.UNSIGNED_INT, 0);
      quads += g.waterQuads;
    }

    // Primed TNT flashing white.
    if (f.flashes.length) {
      gl.useProgram(this.line.program);
      gl.uniformMatrix4fv(this.line.u.uViewProj!, false, viewProj);
      gl.uniform1f(this.line.u.uScale!, 1.02);
      gl.bindVertexArray(this.cubeVao);
      for (const t of f.flashes) {
        if (!t.on) continue;
        gl.uniform3f(this.line.u.uOffset!, t.x, t.y, t.z);
        gl.uniform4f(this.line.u.uColor!, 1, 1, 1, 0.55);
        gl.drawArrays(gl.TRIANGLES, 0, 36);
      }
    }
    gl.depthMask(true);
    gl.disable(gl.BLEND);

    // The block in hand, over everything.
    if (f.hand) {
      gl.clear(gl.DEPTH_BUFFER_BIT);
      gl.enable(gl.CULL_FACE);
      const hand = this.handMesh(f.hand.id);
      const s = f.hand.swing;
      const model = multiply(
        translationOf(0.66 - s * 0.25, -0.6 + f.hand.bob + Math.sin(s * Math.PI) * 0.12, -1.1 - s * 0.15),
        multiply(rotY(0.8 - s * 0.6), multiply(rotX(0.2 - s * 0.9), multiply(scale(0.32), translationOf(-0.5, -0.5, -0.5)))),
      );
      gl.useProgram(this.chunk.program);
      gl.uniform1i(cu.uPass!, 0);
      gl.uniformMatrix4fv(cu.uViewProj!, false, multiply(f.proj, model));
      gl.uniform3f(cu.uOrigin!, 0, 0, 0);
      gl.uniform3f(cu.uCam!, 0.5, 0, 0.5);
      gl.uniform2f(cu.uFog!, 1000, 1001);
      gl.bindVertexArray(hand.vao);
      gl.drawElements(gl.TRIANGLES, hand.quads * 6, gl.UNSIGNED_INT, 0);
    }
    gl.bindVertexArray(null);
    this.stats = { chunks: visible.length, quads };
  }
}

function invertViewProj(f: Frame): Mat4 {
  // The sky only needs directions: drop the camera's translation, add it back in the shader.
  const view = new Float32Array(f.view);
  view[12] = view[13] = view[14] = 0;
  const inv = invert(multiply(f.proj, view));
  // The shader subtracts uCam from the unprojected point; shift by the camera to match.
  const shift = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, f.cam[0], f.cam[1], f.cam[2], 1]);
  return multiply(shift, inv);
}

// Road surfaces (draped ribbons with lane markings) and the Yandex-style
// traffic overlay: one coloured line per direction, width clamped in pixels.

import * as THREE from 'three';
import { decodeLines } from '../data/loader.js';

const MINOR_W = [7.0, 8.0, 5.5];

/** Ribbon builder: polyline points (xyz) -> triangles with along/lateral attributes. */
function ribbon(out, pts, n, width, lift, lanes, flags) {
  const half = width / 2;
  let along = 0;
  const base = out.v;
  for (let k = 0; k < n; k++) {
    const x = pts[3 * k], y = pts[3 * k + 1], z = pts[3 * k + 2];
    const kp = Math.max(0, k - 1), kn = Math.min(n - 1, k + 1);
    let tx = pts[3 * kn] - pts[3 * kp], tz = pts[3 * kn + 2] - pts[3 * kp + 2];
    const L = Math.hypot(tx, tz) || 1;
    tx /= L; tz /= L;
    // miter: average of adjacent segment normals
    let mx = -tz, mz = tx, scale = 1;
    if (k > 0 && k < n - 1) {
      let ax = pts[3 * k] - pts[3 * kp], az = pts[3 * k + 2] - pts[3 * kp + 2];
      const la = Math.hypot(ax, az) || 1; ax /= la; az /= la;
      const dot = (-az) * mx + ax * mz;
      scale = Math.min(2.0, 1 / Math.max(0.5, dot));
    }
    if (k > 0) along += Math.hypot(x - pts[3 * k - 3], z - pts[3 * k - 1]);
    for (const side of [-1, 1]) {
      const i = out.v++;
      out.pos[3 * i] = x + mx * half * scale * side;
      out.pos[3 * i + 1] = y + lift;
      out.pos[3 * i + 2] = z + mz * half * scale * side;
      out.road[4 * i] = along;
      out.road[4 * i + 1] = side;
      out.road[4 * i + 2] = lanes;
      out.road[4 * i + 3] = flags;
    }
    if (k > 0) {
      const a = base + 2 * (k - 1), b = a + 1, c = a + 2, d = a + 3;
      out.idx[out.t++] = a; out.idx[out.t++] = b; out.idx[out.t++] = c;
      out.idx[out.t++] = b; out.idx[out.t++] = d; out.idx[out.t++] = c;
    }
  }
}

function alloc(nPts) {
  return {
    pos: new Float32Array(nPts * 2 * 3), road: new Float32Array(nPts * 2 * 4),
    idx: new Uint32Array(nPts * 6), v: 0, t: 0,
  };
}

function toGeometry(o) {
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(o.pos.slice(0, o.v * 3), 3));
  g.setAttribute('aRoad', new THREE.BufferAttribute(o.road.slice(0, o.v * 4), 4));
  g.setAttribute('normal', new THREE.BufferAttribute(new Float32Array(o.v * 3).map((_, i) => (i % 3 === 1 ? 1 : 0)), 3));
  g.setIndex(new THREE.BufferAttribute(o.idx.slice(0, o.t), 1));
  g.computeBoundingSphere();
  return g;
}

export function roadMaterial(minor) {
  const mat = new THREE.MeshStandardMaterial({
    color: minor ? 0x4a4c50 : 0x3c3f44, roughness: 0.9, metalness: 0,
    polygonOffset: true, polygonOffsetFactor: minor ? -2 : -4, polygonOffsetUnits: minor ? -2 : -4,
  });
  const uniforms = { uSnow: { value: 0 }, uNight: { value: 0 } };
  mat.userData.uniforms = uniforms;
  mat.onBeforeCompile = (sh) => {
    Object.assign(sh.uniforms, uniforms);
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nattribute vec4 aRoad; varying vec4 vRoad;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvRoad = aRoad;');
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', '#include <common>\nvarying vec4 vRoad; uniform float uSnow; uniform float uNight;')
      .replace('#include <color_fragment>', `#include <color_fragment>
  {
    float lanes = max(1.0, vRoad.z);
    float oneway = mod(vRoad.w, 2.0);
    float lat = vRoad.y * 0.5 + 0.5;            // 0..1 across
    float px = fwidth(lat * lanes);
    float vis = 1.0 - smoothstep(0.08, 0.25, px);
    float m = 0.0;
    // edge lines
    m = max(m, 1.0 - smoothstep(0.0, max(0.02, px), min(lat, 1.0 - lat) * lanes - 0.06));
    // lane dividers (dashed)
    float lf = fract(lat * lanes);
    float dl = min(lf, 1.0 - lf);
    float dash = step(0.55, fract(vRoad.x / 12.0));
    float isCentre = oneway < 0.5 ? (1.0 - step(0.5 / lanes, abs(lat - 0.5))) : 0.0;
    float divider = (1.0 - smoothstep(0.0, max(0.02, px), dl * lanes - 0.0));
    m = max(m, divider * mix(dash, 1.0, isCentre) * step(0.001, lat) * step(lat, 0.999));
    m *= vis * (1.0 - step(1.5, vRoad.w));   // residential streets: no paint
    diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.80, 0.80, 0.76), m * 0.85);
    // winter: packed snow at the edges
    float edge = smoothstep(0.35, 0.5, abs(lat - 0.5));
    diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.86, 0.88, 0.9), uSnow * (0.25 + 0.55 * edge));
  }`);
  };
  mat.customProgramCacheKey = () => (minor ? 'road-minor' : 'road-major');
  return mat;
}

export function buildRoadMeshes(data, rg) {
  const R = data.roads;
  // major
  const nPts = rg.xyz.length / 3;
  const o = alloc(nPts + 16);
  for (let s = 0; s < rg.S; s++) {
    const a = rg.off[s], n = rg.off[s + 1] - a;
    const pts = rg.xyz.subarray(3 * a, 3 * (a + n));
    const lanes = R.seg_lf[s] + R.seg_lb[s];
    const flags = (R.seg_lb[s] === 0 ? 1 : 0);
    ribbon(o, pts, n, rg.width[s], 0.45, lanes, flags);
  }
  const major = new THREE.Mesh(toGeometry(o), roadMaterial(false));
  major.receiveShadow = true;
  major.name = 'roads-major';
  major.renderOrder = 2;
  // minor (visual only)
  const M = decodeLines(data.minor);
  const pts = [];
  let total = 0;
  const hf = rg.hf;
  for (let i = 0; i < M.count; i++) {
    const a = M.start[i], b = M.start[i + 1];
    const out = [];
    for (let k = a; k < b; k++) {
      const x = M.xz[2 * k], z = M.xz[2 * k + 1];
      if (k > a) {
        const px = M.xz[2 * k - 2], pz = M.xz[2 * k - 1];
        const d = Math.hypot(x - px, z - pz);
        const ns = Math.floor(d / 40);
        for (let j = 1; j <= ns; j++) { const t = j / (ns + 1); const xx = px + (x - px) * t, zz = pz + (z - pz) * t; out.push(xx, hf.height(xx, zz), zz); }
      }
      out.push(x, hf.height(x, z), z);
    }
    pts.push(out);
    total += out.length / 3;
  }
  const om = alloc(total + 16);
  for (let i = 0; i < M.count; i++) {
    const p = pts[i];
    ribbon(om, p, p.length / 3, MINOR_W[M.kind[i]] || 7, 0.3, 2, 2);
  }
  const minor = new THREE.Mesh(toGeometry(om), roadMaterial(true));
  minor.receiveShadow = true;
  minor.name = 'roads-minor';
  minor.renderOrder = 1;
  return { major, minor };
}

// ------------------------------------------------------------------ traffic overlay

export const RAMP_GLSL = `
vec3 trafficColor(float r){
  // free-flow ratio -> colour (green, yellow, orange, red, dark red)
  vec3 c0 = vec3(0.20, 0.82, 0.45), c1 = vec3(1.00, 0.84, 0.18), c2 = vec3(1.00, 0.50, 0.12), c3 = vec3(0.95, 0.15, 0.13), c4 = vec3(0.50, 0.04, 0.06);
  if (r < 1.25) return mix(c0, c1, smoothstep(1.1, 1.25, r));
  if (r < 1.7) return mix(c1, c2, smoothstep(1.25, 1.7, r));
  if (r < 2.5) return mix(c2, c3, smoothstep(1.7, 2.5, r));
  return mix(c3, c4, smoothstep(2.5, 4.0, r));
}`;

export class TrafficOverlay {
  constructor(rg, net) {
    this.rg = rg; this.net = net;
    const RL = net.roadLinks;
    this.RL = RL;
    // texture with per-link ratio for all 48 slots
    this.texW = 4096;
    this.rows = Math.ceil(RL / this.texW);
    this.texData = new Uint8Array(this.texW * this.rows * 48);
    this.texData.fill(20);
    this.tex = new THREE.DataTexture(this.texData, this.texW, this.rows * 48, THREE.RedFormat, THREE.UnsignedByteType);
    this.tex.magFilter = this.tex.minFilter = THREE.NearestFilter;
    this.tex.needsUpdate = true;
    this.mesh = this.build();
  }

  build() {
    const { rg, net } = this;
    const quads = [];
    let nq = 0;
    const per = [];
    for (let l = 0; l < this.RL; l++) {
      const s = net.seg[l];
      const twoWay = net.twin[l] >= 0;
      const side = twoWay ? Math.max(2.2, net.lanes[l] * 1.7) : 0;
      const pts = rg.linkPoints(s, net.dir[l], side);
      per.push(pts);
      nq += pts.length / 3 - 1;
    }
    const A = new Float32Array(nq * 4 * 3), B = new Float32Array(nq * 4 * 3);
    const meta = new Float32Array(nq * 4 * 4); // side, end, link, along
    const idx = new Uint32Array(nq * 6);
    let q = 0;
    for (let l = 0; l < this.RL; l++) {
      const pts = per[l];
      const n = pts.length / 3;
      let along = 0;
      for (let k = 0; k < n - 1; k++) {
        const seglen = Math.hypot(pts[3 * k + 3] - pts[3 * k], pts[3 * k + 5] - pts[3 * k + 2]);
        for (let c = 0; c < 4; c++) {
          const v = q * 4 + c;
          for (let j = 0; j < 3; j++) { A[3 * v + j] = pts[3 * k + j]; B[3 * v + j] = pts[3 * k + 3 + j]; }
          meta[4 * v] = c & 1 ? 1 : -1;
          meta[4 * v + 1] = c >> 1;
          meta[4 * v + 2] = l;
          meta[4 * v + 3] = along + (c >> 1) * seglen;
        }
        const b = q * 4;
        // counter-clockwise in screen space (corner 0/2 are on the right of travel)
        idx[6 * q] = b; idx[6 * q + 1] = b + 2; idx[6 * q + 2] = b + 1;
        idx[6 * q + 3] = b + 1; idx[6 * q + 4] = b + 2; idx[6 * q + 5] = b + 3;
        along += seglen;
        q++;
      }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(A, 3));
    g.setAttribute('aB', new THREE.BufferAttribute(B, 3));
    g.setAttribute('aMeta', new THREE.BufferAttribute(meta, 4));
    g.setIndex(new THREE.BufferAttribute(idx, 1));
    g.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, 800, 0), 60000);
    this.uniforms = {
      uRatio: { value: this.tex },
      uTexW: { value: this.texW }, uRows: { value: this.rows },
      uSlotA: { value: 16 }, uSlotB: { value: 17 }, uSlotF: { value: 0 },
      uRes: { value: new THREE.Vector2(1, 1) },
      uMinPx: { value: 2.2 }, uMaxPx: { value: 9 }, uWorldW: { value: 3.2 },
      uTime: { value: 0 }, uOpacity: { value: 1 }, uLift: { value: 1.2 },
      uNight: { value: 0 },
    };
    const mat = new THREE.ShaderMaterial({
      uniforms: this.uniforms,
      transparent: true,
      depthWrite: false,
      vertexShader: `
attribute vec3 aB; attribute vec4 aMeta;
uniform vec2 uRes; uniform float uMinPx, uMaxPx, uWorldW, uLift;
uniform sampler2D uRatio; uniform float uTexW, uRows, uSlotA, uSlotB, uSlotF;
varying float vRatio; varying float vAlong; varying float vSide; varying float vDepth;
float ratioAt(float l, float slot){
  float x = mod(l, uTexW), y = floor(l / uTexW) + slot * uRows;
  return texelFetch(uRatio, ivec2(int(x), int(y)), 0).r * 255.0 / 20.0;
}
void main(){
  vec3 pa = position, pb = aB;
  float dist = length(cameraPosition - mix(pa, pb, 0.5));
  float lift = uLift + dist * 0.0012;
  pa.y += lift; pb.y += lift;
  vec4 ca = projectionMatrix * viewMatrix * vec4(pa, 1.0);
  vec4 cb = projectionMatrix * viewMatrix * vec4(pb, 1.0);
  vec2 sa = ca.xy / ca.w * uRes * 0.5, sb = cb.xy / cb.w * uRes * 0.5;
  vec2 dir = sb - sa; float L = length(dir); dir = L > 1e-4 ? dir / L : vec2(1.0, 0.0);
  vec2 nrm = vec2(-dir.y, dir.x);
  vec4 c = aMeta.y > 0.5 ? cb : ca;
  // world width projected to pixels, clamped
  float pxPerM = uRes.y * 0.5 * projectionMatrix[1][1] / c.w;
  float w = clamp(uWorldW * pxPerM, uMinPx, uMaxPx);
  vec2 off = nrm * aMeta.x * w * 0.5 + dir * (aMeta.y > 0.5 ? 1.0 : -1.0) * w * 0.35;
  c.xy += off / (uRes * 0.5) * c.w;
  gl_Position = c;
  vRatio = mix(ratioAt(aMeta.z, uSlotA), ratioAt(aMeta.z, uSlotB), uSlotF);
  vAlong = aMeta.w; vSide = aMeta.x; vDepth = c.w;
}`,
      fragmentShader: `
uniform float uTime; uniform float uOpacity; uniform float uNight;
varying float vRatio; varying float vAlong; varying float vSide; varying float vDepth;
${RAMP_GLSL}
void main(){
  vec3 col = trafficColor(vRatio);
  // flow pulses: move along the direction of travel, slower in jams
  float speed = 14.0 / max(1.0, vRatio);
  float ph = fract((vAlong - uTime * speed) / 60.0);
  float pulse = smoothstep(0.0, 0.08, ph) * (1.0 - smoothstep(0.12, 0.3, ph));
  col = mix(col, col * 1.55 + 0.08, pulse * 0.5 * smoothstep(9000.0, 1500.0, vDepth));
  float edge = 1.0 - smoothstep(0.65, 1.0, abs(vSide));
  gl_FragColor = vec4(pow(col, vec3(2.2)) * (1.0 + uNight * 0.8), uOpacity * mix(0.75, 1.0, edge));
  #include <colorspace_fragment>
}`,
    });
    this.material = mat;
    const mesh = new THREE.Mesh(g, mat);
    mesh.frustumCulled = false;
    mesh.renderOrder = 5;
    mesh.name = 'traffic';
    return mesh;
  }

  /** snapshot.ratio: Uint8Array(48 * RL) slot-major. */
  update(ratio) {
    const RL = this.RL, W = this.texW, rows = this.rows;
    for (let s = 0; s < 48; s++) {
      const src = ratio.subarray(s * RL, (s + 1) * RL);
      this.texData.set(src, s * rows * W);
    }
    this.tex.needsUpdate = true;
  }

  setHour(h) {
    const slot = Math.floor(h * 2) % 48;
    this.uniforms.uSlotA.value = slot;
    this.uniforms.uSlotB.value = (slot + 1) % 48;
    this.uniforms.uSlotF.value = h * 2 - Math.floor(h * 2);
  }
}

/** Golden outline for the selected street (both directions). */
export function selectionMesh(rg, segs, color = 0xffd34d) {
  const pts = [];
  for (const s of segs) {
    const p = rg.linkPoints(s, 1, 0);
    pts.push(p);
  }
  let nq = 0;
  for (const p of pts) nq += p.length / 3 - 1;
  const A = new Float32Array(nq * 12), B = new Float32Array(nq * 12), meta = new Float32Array(nq * 16);
  const idx = new Uint32Array(nq * 6);
  let q = 0;
  for (const p of pts) {
    const n = p.length / 3;
    for (let k = 0; k < n - 1; k++) {
      for (let c = 0; c < 4; c++) {
        const v = q * 4 + c;
        for (let j = 0; j < 3; j++) { A[3 * v + j] = p[3 * k + j]; B[3 * v + j] = p[3 * k + 3 + j]; }
        meta[4 * v] = c & 1 ? 1 : -1; meta[4 * v + 1] = c >> 1;
      }
      const b = q * 4;
      idx.set([b, b + 2, b + 1, b + 1, b + 2, b + 3], 6 * q);
      q++;
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(A, 3));
  g.setAttribute('aB', new THREE.BufferAttribute(B, 3));
  g.setAttribute('aMeta', new THREE.BufferAttribute(meta, 4));
  g.setIndex(new THREE.BufferAttribute(idx, 1));
  const mat = new THREE.ShaderMaterial({
    uniforms: { uRes: { value: new THREE.Vector2(1, 1) }, uColor: { value: new THREE.Color(color) }, uTime: { value: 0 }, uWidthM: { value: 1 } },
    transparent: true, depthWrite: false, depthTest: false,
    vertexShader: `
attribute vec3 aB; attribute vec4 aMeta; uniform vec2 uRes; uniform float uWidthM; varying float vSide;
void main(){
  vec3 pa = position, pb = aB; pa.y += 2.0; pb.y += 2.0;
  vec4 ca = projectionMatrix * viewMatrix * vec4(pa, 1.0), cb = projectionMatrix * viewMatrix * vec4(pb, 1.0);
  vec2 sa = ca.xy / ca.w * uRes * 0.5, sb = cb.xy / cb.w * uRes * 0.5;
  vec2 dir = sb - sa; float L = length(dir); dir = L > 1e-4 ? dir / L : vec2(1.0, 0.0);
  vec4 c = aMeta.y > 0.5 ? cb : ca;
  float pxPerM = uRes.y * 0.5 * projectionMatrix[1][1] / c.w;
  float w = clamp(uWidthM * pxPerM, 6.0, 40.0);
  vec2 off = vec2(-dir.y, dir.x) * aMeta.x * w * 0.5 + dir * (aMeta.y > 0.5 ? 1.0 : -1.0) * w * 0.4;
  c.xy += off / (uRes * 0.5) * c.w;
  gl_Position = c; vSide = aMeta.x;
}`,
    fragmentShader: `
uniform vec3 uColor; uniform float uTime; varying float vSide;
void main(){
  float a = 1.0 - smoothstep(0.55, 1.0, abs(vSide));
  float ring = smoothstep(0.55, 0.75, abs(vSide)) * (1.0 - smoothstep(0.85, 1.0, abs(vSide)));
  gl_FragColor = vec4(uColor * (1.2 + 0.4 * sin(uTime * 4.0)), 0.28 * a + 0.9 * ring);
  #include <colorspace_fragment>
}`,
  });
  const m = new THREE.Mesh(g, mat);
  m.frustumCulled = false;
  m.renderOrder = 8;
  return m;
}

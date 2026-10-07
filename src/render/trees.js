// Street trees and park trees ("город-сад"): instanced, chunked, drawn only near the camera.
// Deciduous crowns turn gold in autumn and bare in winter; Tian Shan spruces stay green.

import * as THREE from 'three';
import { decodeLines } from '../data/loader.js';

const CHUNK = 1500;

function rng(seed) {
  let a = seed >>> 0;
  return () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

function merge(parts) {
  let n = 0, ni = 0;
  for (const g of parts) { n += g.attributes.position.count; ni += g.index.count; }
  const pos = new Float32Array(n * 3), nor = new Float32Array(n * 3), col = new Float32Array(n * 3), kind = new Float32Array(n);
  const idx = new Uint16Array(ni);
  let o = 0, oi = 0;
  for (const g of parts) {
    pos.set(g.attributes.position.array, o * 3);
    nor.set(g.attributes.normal.array, o * 3);
    const c = g.userData.color, k = g.userData.kind;
    for (let i = 0; i < g.attributes.position.count; i++) { col[(o + i) * 3] = c[0]; col[(o + i) * 3 + 1] = c[1]; col[(o + i) * 3 + 2] = c[2]; kind[o + i] = k; }
    for (let i = 0; i < g.index.count; i++) idx[oi++] = g.index.array[i] + o;
    o += g.attributes.position.count;
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
  g.setAttribute('color', new THREE.BufferAttribute(col, 3));
  g.setAttribute('aKind', new THREE.BufferAttribute(kind, 1));
  g.setIndex(new THREE.BufferAttribute(idx, 1));
  return g;
}

function deciduous() {
  const t = new THREE.CylinderGeometry(0.18, 0.28, 3.2, 4, 1, true); t.translate(0, 1.6, 0); t.userData = { color: [0.33, 0.24, 0.17], kind: 0 };
  const crown = new THREE.IcosahedronGeometry(1, 0); crown.scale(2.8, 3.2, 2.8); crown.translate(0, 5.4, 0);
  const c = crown.index ? crown : mergeIndex(crown);
  c.userData = { color: [0.30, 0.45, 0.20], kind: 1 };
  return merge([t, c]);
}

function spruce() {
  const t = new THREE.CylinderGeometry(0.18, 0.3, 2, 4, 1, true); t.translate(0, 1, 0); t.userData = { color: [0.3, 0.22, 0.15], kind: 0 };
  const c = new THREE.ConeGeometry(2.2, 9, 6, 1, true); c.translate(0, 6.5, 0); c.userData = { color: [0.12, 0.25, 0.16], kind: 2 };
  return merge([t, mergeIndex(c)]);
}

function mergeIndex(g) {
  if (g.index) return g;
  const n = g.attributes.position.count;
  const idx = new Uint16Array(n);
  for (let i = 0; i < n; i++) idx[i] = i;
  g.setIndex(new THREE.BufferAttribute(idx, 1));
  return g;
}

export class Trees {
  constructor(data, hf, rg, districtAt) {
    this.group = new THREE.Group();
    this.group.name = 'trees';
    this.hf = hf;
    const pts = new Map(); // chunk key -> { d: [], s: [] } arrays of x,y,z,scale,rot
    const add = (x, z, sp, r) => {
      const key = `${Math.floor(x / CHUNK)},${Math.floor(z / CHUNK)}`;
      let c = pts.get(key);
      if (!c) pts.set(key, (c = { d: [], s: [], cx: (Math.floor(x / CHUNK) + 0.5) * CHUNK, cz: (Math.floor(z / CHUNK) + 0.5) * CHUNK }));
      (sp ? c.s : c.d).push(x, hf.height(x, z) - 0.2, z, 0.75 + r() * 0.6, r() * 6.28);
    };
    const r = rng(7);
    // street trees along residential streets (aryk-lined Almaty)
    const M = decodeLines(data.minor);
    for (let i = 0; i < M.count; i++) {
      const off = 6.2;
      for (let k = M.start[i]; k < M.start[i + 1] - 1; k++) {
        const x0 = M.xz[2 * k], z0 = M.xz[2 * k + 1], x1 = M.xz[2 * k + 2], z1 = M.xz[2 * k + 3];
        const L = Math.hypot(x1 - x0, z1 - z0);
        if (L < 1) continue;
        const nx = -(z1 - z0) / L, nz = (x1 - x0) / L;
        for (let t = 6; t < L - 4; t += 30 + r() * 12) {
          const x = x0 + (x1 - x0) * t / L, z = z0 + (z1 - z0) * t / L;
          if (r() < 0.7) add(x + nx * off, z + nz * off, false, r);
          if (r() < 0.7) add(x - nx * off, z - nz * off, false, r);
        }
      }
    }
    // major streets: rows on both sides
    for (let s = 0; s < rg.S; s++) {
      const off = rg.width[s] / 2 + 3.5;
      if (data.roads.seg_flags[s] & 2) continue;
      for (let i = rg.off[s]; i < rg.off[s + 1] - 1; i++) {
        const x0 = rg.xyz[3 * i], z0 = rg.xyz[3 * i + 2], x1 = rg.xyz[3 * i + 3], z1 = rg.xyz[3 * i + 5];
        const L = Math.hypot(x1 - x0, z1 - z0);
        if (L < 1 || rg.elevLift[i] > 0.5) continue;
        const nx = -(z1 - z0) / L, nz = (x1 - x0) / L;
        for (let t = r() * 10; t < L; t += 20 + r() * 8) {
          const x = x0 + (x1 - x0) * t / L, z = z0 + (z1 - z0) * t / L;
          if (r() < 0.75) add(x + nx * off, z + nz * off, false, r);
          if (r() < 0.75) add(x - nx * off, z - nz * off, false, r);
        }
      }
    }
    // parks and urban forests
    const A = decodeLines(data.areas);
    const cls = data.meta.areas.classes;
    for (let i = 0; i < A.count; i++) {
      const k = cls[A.kind[i]];
      if (k !== 'park' && k !== 'forest' && k !== 'cemetery') continue;
      const a = A.start[i], b = A.start[i + 1];
      let x0 = Infinity, z0 = Infinity, x1 = -Infinity, z1 = -Infinity;
      for (let j = a; j < b; j++) { x0 = Math.min(x0, A.xz[2 * j]); x1 = Math.max(x1, A.xz[2 * j]); z0 = Math.min(z0, A.xz[2 * j + 1]); z1 = Math.max(z1, A.xz[2 * j + 1]); }
      // only inside the city
      if (districtAt((x0 + x1) / 2, (z0 + z1) / 2) < 0) continue;
      const area = (x1 - x0) * (z1 - z0);
      const n = Math.min(1500, Math.floor(area / (k === 'forest' ? 450 : 260)));
      for (let t = 0; t < n; t++) {
        const x = x0 + r() * (x1 - x0), z = z0 + r() * (z1 - z0);
        if (!inside(A.xz, a, b, x, z)) continue;
        add(x, z, r() < (k === 'forest' ? 0.45 : 0.18), r);
      }
    }
    this.mat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.95, metalness: 0 });
    const uniforms = { uAutumn: { value: 0 }, uWinter: { value: 0 } };
    this.mat.userData.uniforms = uniforms;
    this.mat.onBeforeCompile = (sh) => {
      Object.assign(sh.uniforms, uniforms);
      sh.vertexShader = sh.vertexShader
        .replace('#include <common>', '#include <common>\nattribute float aKind; varying float vKind; varying float vRnd; varying float vUp;')
        .replace('#include <begin_vertex>', `#include <begin_vertex>
  vKind = aKind; vUp = normal.y;
  #ifdef USE_INSTANCING
  vRnd = fract(sin(instanceMatrix[3].x * 0.137 + instanceMatrix[3].z * 0.311) * 43758.5);
  #else
  vRnd = 0.5;
  #endif`);
      sh.fragmentShader = sh.fragmentShader
        .replace('#include <common>', '#include <common>\nuniform float uAutumn; uniform float uWinter; varying float vKind; varying float vRnd; varying float vUp;')
        .replace('#include <color_fragment>', `#include <color_fragment>
  if (vKind > 0.5 && vKind < 1.5) {
    vec3 gold = mix(vec3(0.72, 0.52, 0.10), vec3(0.62, 0.25, 0.08), step(0.6, vRnd));
    diffuseColor.rgb = mix(diffuseColor.rgb, pow(gold, vec3(2.2)) * 2.4, uAutumn * smoothstep(0.15, 0.9, vRnd + uAutumn * 0.5));
    diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.16, 0.13, 0.11), uWinter * 0.85);
  }
  if (vKind > 0.5) diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.92, 0.94, 0.97), uWinter * smoothstep(0.35, 0.8, vUp) * 0.85);
  diffuseColor.rgb *= 0.85 + 0.3 * vRnd;`);
    };
    const geoD = deciduous(), geoS = spruce();
    this.geoD = geoD; this.geoS = geoS;
    this.chunks = [];
    const m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), p = new THREE.Vector3(), sc = new THREE.Vector3(), up = new THREE.Vector3(0, 1, 0);
    let total = 0;
    for (const c of pts.values()) {
      const meshes = [];
      for (const [arr, geo] of [[c.d, geoD], [c.s, geoS]]) {
        const n = arr.length / 5;
        if (!n) continue;
        const im = new THREE.InstancedMesh(geo, this.mat, n);
        for (let i = 0; i < n; i++) {
          p.set(arr[5 * i], arr[5 * i + 1], arr[5 * i + 2]);
          const s = arr[5 * i + 3];
          sc.set(s, s * (0.9 + (i % 7) * 0.04), s);
          q.setFromAxisAngle(up, arr[5 * i + 4]);
          m4.compose(p, q, sc);
          im.setMatrixAt(i, m4);
        }
        im.castShadow = false;
        im.receiveShadow = false;
        im.computeBoundingSphere();
        im.visible = false;
        this.group.add(im);
        meshes.push(im);
        total += n;
      }
      this.chunks.push({ cx: c.cx, cz: c.cz, meshes });
    }
    this.total = total;
  }

  /** Plant a new park (circle) chosen by the player. */
  addPark(x, z, r) {
    const rnd = rng(Math.round(x * 13 + z * 7));
    const n = Math.min(3000, Math.round(Math.PI * r * r / 140));
    const m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), p = new THREE.Vector3(), sc = new THREE.Vector3(), up = new THREE.Vector3(0, 1, 0);
    const meshes = [];
    for (const [geo, share] of [[this.geoD, 0.8], [this.geoS, 0.2]]) {
      const k = Math.round(n * share);
      if (!k) continue;
      const im = new THREE.InstancedMesh(geo, this.mat, k);
      for (let i = 0; i < k; i++) {
        const a = rnd() * Math.PI * 2, d = Math.sqrt(rnd()) * r * 0.95;
        const px = x + Math.cos(a) * d, pz = z + Math.sin(a) * d;
        p.set(px, this.hf.height(px, pz) - 0.2, pz);
        const s = 0.55 + rnd() * 0.5;   // young trees
        sc.set(s, s, s);
        q.setFromAxisAngle(up, rnd() * 6.28);
        m4.compose(p, q, sc);
        im.setMatrixAt(i, m4);
      }
      im.castShadow = false; im.receiveShadow = false;
      im.computeBoundingSphere();
      this.group.add(im);
      meshes.push(im);
    }
    this.chunks.push({ cx: x, cz: z, meshes });
  }

  update(target, dist, autumn, winter) {
    const u = this.mat.userData.uniforms;
    u.uAutumn.value = autumn;
    u.uWinter.value = winter;
    const show = dist < 3800;
    const R = Math.max(1600, dist * 1.1);
    for (const c of this.chunks) {
      const v = show && Math.hypot(c.cx - target.x, c.cz - target.z) < R;
      for (const m of c.meshes) m.visible = v;
    }
  }
}

function inside(xz, a, b, x, z) {
  let ins = false;
  for (let i = a, j = b - 1; i < b; j = i++) {
    const xi = xz[2 * i], zi = xz[2 * i + 1], xj = xz[2 * j], zj = xz[2 * j + 1];
    if ((zi > z) !== (zj > z) && x < (xj - xi) * (z - zi) / (zj - zi + 1e-12) + xi) ins = !ins;
  }
  return ins;
}

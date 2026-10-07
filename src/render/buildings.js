// 182k OSM buildings as chunked meshes with a procedural facade shader
// (windows by floor, lit at night, snow on roofs in winter).

import * as THREE from 'three';

export function buildBuildings(data, hf, onProgress) {
  return new Promise((resolve, reject) => {
    const w = new Worker(new URL('./buildingsWorker.js', import.meta.url), { type: 'module' });
    const b = data.buildings;
    w.onmessage = (e) => {
      if (e.data.type === 'progress') { onProgress && onProgress(e.data.f); return; }
      if (e.data.type === 'done') { w.terminate(); resolve(e.data.chunks); }
    };
    w.onerror = (err) => { w.terminate(); reject(err); };
    w.postMessage({
      count: b.count, kind: b.kind, origin: b.origin, delta: b.delta, height: b.height,
      terrain: hf.data, tmeta: { x0: hf.x0, z0: hf.z0, cs: hf.cs, w: hf.w, h: hf.h },
    });
  });
}

export function buildingMaterial() {
  const mat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.82, metalness: 0.0, flatShading: true });
  const uniforms = {
    uNight: { value: 0 },
    uSnow: { value: 0 },
    uLit: { value: 0.3 },        // share of lit windows at this hour
    uHighlight: { value: new THREE.Vector4(0, 0, 0, 0) }, // x,z,radius,strength (selection glow)
  };
  mat.userData.uniforms = uniforms;
  mat.onBeforeCompile = (sh) => {
    Object.assign(sh.uniforms, uniforms);
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', `#include <common>
attribute vec2 aWall; attribute vec4 aInfo;
varying vec2 vWall; varying vec4 vInfo; varying vec3 vWorld;`)
      .replace('#include <worldpos_vertex>', `#include <worldpos_vertex>
vWall = aWall; vInfo = aInfo; vWorld = (modelMatrix * vec4(transformed, 1.0)).xyz;`);
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', `#include <common>
varying vec2 vWall; varying vec4 vInfo; varying vec3 vWorld;
uniform float uNight; uniform float uSnow; uniform float uLit; uniform vec4 uHighlight;
float bh(vec3 p){ p = fract(p * 0.3183099 + vec3(0.71, 0.113, 0.419)); p *= 17.0; return fract(p.x * p.y * p.z * (p.x + p.y + p.z)); }
vec3 s2l(vec3 c){ return pow(c, vec3(2.2)); }
vec3 wallColor(int t, float r){
  if (t == 0) { // private house
    vec3 a = r < 0.33 ? vec3(0.91,0.88,0.80) : r < 0.66 ? vec3(0.86,0.79,0.66) : vec3(0.74,0.58,0.46);
    return a; }
  if (t == 1) { // apartments
    vec3 a = r < 0.25 ? vec3(0.90,0.88,0.84) : r < 0.5 ? vec3(0.83,0.81,0.77) : r < 0.75 ? vec3(0.88,0.83,0.73) : vec3(0.78,0.82,0.83);
    return a; }
  if (t == 2) return r < 0.5 ? vec3(0.78,0.80,0.82) : vec3(0.86,0.84,0.80);   // commercial
  if (t == 3) return r < 0.5 ? vec3(0.72,0.70,0.66) : vec3(0.66,0.66,0.64);   // industrial
  if (t == 4) return r < 0.5 ? vec3(0.90,0.86,0.76) : vec3(0.86,0.80,0.72);   // public
  if (t == 5) return vec3(0.66,0.64,0.60);                                    // garages, sheds
  if (t == 6) return vec3(0.95,0.93,0.88);                                    // religious
  return r < 0.5 ? vec3(0.50,0.60,0.70) : vec3(0.62,0.68,0.74);               // towers
}
vec3 roofColor(int t, float r){
  if (t == 0) return r < 0.3 ? vec3(0.55,0.24,0.18) : r < 0.5 ? vec3(0.26,0.39,0.32) : r < 0.7 ? vec3(0.42,0.43,0.45) : r < 0.85 ? vec3(0.24,0.34,0.47) : vec3(0.42,0.30,0.22);
  if (t == 5) return vec3(0.40,0.40,0.41);
  if (t == 6) return vec3(0.80,0.65,0.30);
  if (t == 3) return vec3(0.56,0.57,0.57);
  return r < 0.5 ? vec3(0.36,0.37,0.39) : vec3(0.45,0.45,0.46);
}`)
      .replace('#include <color_fragment>', `#include <color_fragment>
  if (vInfo.w > 0.5) discard;
  vec3 nW = normalize(cross(dFdx(vWorld), dFdy(vWorld)));
  int btype = int(vInfo.x * 255.0 + 0.5);
  float rnd = vInfo.y;
  bool isRoof = nW.y > 0.45;
  vec3 col;
  float winMask = 0.0, litMask = 0.0;
  if (isRoof) {
    col = roofColor(btype, rnd);
    col = mix(col, vec3(0.94, 0.96, 0.99), uSnow * 0.92 * smoothstep(0.45, 0.8, nW.y));
  } else {
    col = wallColor(btype, rnd);
    float floorH = btype == 2 ? 3.6 : btype == 3 ? 5.0 : btype == 7 ? 3.6 : 3.0;
    float spacing = btype == 0 ? 4.5 : btype == 7 ? 1.8 : btype == 3 ? 6.0 : 3.1;
    vec2 cell = vec2(vWall.x / spacing, (vWall.y - 0.9) / floorH);
    vec2 f = fract(cell);
    float fw = max(fwidth(cell.x), fwidth(cell.y));
    float aa = clamp(1.4 - fw * 2.2, 0.0, 1.0);
    float wx = btype == 7 ? 0.08 : btype == 3 ? 0.35 : 0.22;
    float wy = btype == 7 ? 0.06 : 0.28;
    float win = smoothstep(wx, wx + 0.04, f.x) * smoothstep(1.0 - wx, 0.96 - wx, f.x)
              * smoothstep(wy, wy + 0.05, f.y) * smoothstep(0.92, 0.86, f.y);
    float avg = btype == 7 ? 0.8 : btype == 3 ? 0.15 : 0.3;
    win = mix(avg, win, aa);
    float below = step(0.0, vWall.y - 0.9);
    win *= below;
    if (btype == 5) win = 0.0;
    winMask = win;
    vec3 glass = btype == 7 ? vec3(0.20, 0.28, 0.36) : vec3(0.16, 0.19, 0.23);
    col = mix(col, glass, win * 0.85);
    // floor lines and a darker plinth
    col *= mix(0.86, 1.0, smoothstep(0.0, 1.2, vWall.y));
    // lit windows (per window random)
    float h = bh(vec3(floor(cell.x), floor(cell.y), rnd * 97.0 + floor(vWorld.x * 0.01)));
    litMask = step(h, uLit) * win * aa + (1.0 - aa) * win * uLit;
  }
  // selection glow (district / street highlight)
  float hd = length(vWorld.xz - uHighlight.xy);
  col = mix(col, col * vec3(1.15, 1.08, 0.85), uHighlight.w * (1.0 - smoothstep(uHighlight.z * 0.8, uHighlight.z, hd)));
  diffuseColor.rgb = s2l(col);
`)
      .replace('#include <roughnessmap_fragment>', `#include <roughnessmap_fragment>
  roughnessFactor = mix(roughnessFactor, 0.25, winMask * (btype == 7 ? 1.0 : 0.7));`)
      .replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>
  totalEmissiveRadiance += litMask * uNight * vec3(1.0, 0.72, 0.42) * (btype == 7 ? 1.6 : 2.2);`);
  };
  mat.customProgramCacheKey = () => 'akim-buildings-1';
  return mat;
}

/** Far chunks draw only their big buildings (houses and sheds are sub-pixel there). */
export function lodBuildings(group, camPos, near) {
  for (const m of group.children) {
    const d = m.userData.center.distanceTo(camPos);
    const count = d < near ? m.userData.all : m.userData.big;
    if (m.geometry.drawRange.count !== count) m.geometry.setDrawRange(0, count);
  }
}

/** Hide demolished buildings (aInfo.w = 255 -> discarded in the shader). */
export function hideBuildings(group, ids) {
  const touched = new Set();
  for (const id of ids) {
    const w = group.userData.where.get(id);
    if (!w) continue;
    const [m, a, b] = w;
    const arr = m.geometry.attributes.aInfo.array;
    for (let v = a; v < b; v++) arr[v * 4 + 3] = 255;
    touched.add(m);
  }
  for (const m of touched) m.geometry.attributes.aInfo.needsUpdate = true;
}

export function makeBuildingMeshes(chunks, material) {
  const group = new THREE.Group();
  group.name = 'buildings';
  group.userData.where = new Map(); // building id -> [mesh, start, end]
  for (const c of chunks) {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(c.pos, 3));
    g.setAttribute('aWall', new THREE.BufferAttribute(c.wall, 2));
    g.setAttribute('aInfo', new THREE.BufferAttribute(c.info, 4, true));
    g.setIndex(new THREE.BufferAttribute(c.index, 1));
    const [x0, y0, z0, x1, y1, z1] = c.box;
    g.boundingBox = new THREE.Box3(new THREE.Vector3(x0, y0, z0), new THREE.Vector3(x1, y1, z1));
    g.boundingSphere = g.boundingBox.getBoundingSphere(new THREE.Sphere());
    const m = new THREE.Mesh(g, material);
    m.userData.big = c.big;
    m.userData.all = c.index.length;
    m.userData.center = g.boundingSphere.center;
    m.castShadow = true;
    m.receiveShadow = true;
    m.matrixAutoUpdate = false;
    group.add(m);
    for (let k = 0; k < c.ids.length; k++) group.userData.where.set(c.ids[k], [m, c.vstart[k], c.vstart[k + 1]]);
  }
  return group;
}

// Height field of Almaty and the Trans-Ili Alatau: sampling, ray casting and the terrain mesh.

import * as THREE from 'three';

export class HeightField {
  constructor(tmeta, raw) {
    this.x0 = tmeta.x0; this.z0 = tmeta.z0; this.cs = tmeta.cs;
    this.w = tmeta.w; this.h = tmeta.h;
    this.data = new Float32Array(raw.length);
    for (let i = 0; i < raw.length; i++) this.data[i] = raw[i] * 0.1;
    this.x1 = this.x0 + (this.w - 1) * this.cs;
    this.z1 = this.z0 + (this.h - 1) * this.cs;
  }

  height(x, z) {
    let fx = (x - this.x0) / this.cs, fz = (z - this.z0) / this.cs;
    if (fx < 0) fx = 0; else if (fx > this.w - 1.001) fx = this.w - 1.001;
    if (fz < 0) fz = 0; else if (fz > this.h - 1.001) fz = this.h - 1.001;
    const i = fx | 0, j = fz | 0, u = fx - i, v = fz - j;
    const d = this.data, w = this.w, k = j * w + i;
    return (d[k] * (1 - u) + d[k + 1] * u) * (1 - v) + (d[k + w] * (1 - u) + d[k + w + 1] * u) * v;
  }

  /** Ray march against the height field. Returns THREE.Vector3 or null. */
  raycast(origin, dir, maxDist = 120000) {
    let t = 0;
    let step = 10;
    const p = new THREE.Vector3();
    let prevAbove = origin.y - this.height(origin.x, origin.z);
    if (prevAbove < 0) return null;
    while (t < maxDist) {
      const above = prevAbove;
      step = Math.max(4, Math.min(400, above * 0.5));
      const nt = t + step;
      p.copy(origin).addScaledVector(dir, nt);
      const a = p.y - this.height(p.x, p.z);
      if (a < 0) {
        // bisection between t and nt
        let lo = t, hi = nt;
        for (let k = 0; k < 18; k++) {
          const mid = (lo + hi) / 2;
          p.copy(origin).addScaledVector(dir, mid);
          if (p.y - this.height(p.x, p.z) < 0) hi = mid; else lo = mid;
        }
        p.copy(origin).addScaledVector(dir, (lo + hi) / 2);
        return p;
      }
      prevAbove = a;
      t = nt;
      if (p.y > 9000 && dir.y > 0) return null;
    }
    return null;
  }

  /** Terrain mesh with a stride over the height grid. */
  geometry(stride = 2) {
    const W = Math.floor((this.w - 1) / stride) + 1;
    const H = Math.floor((this.h - 1) / stride) + 1;
    const pos = new Float32Array(W * H * 3);
    const nor = new Float32Array(W * H * 3);
    const cs = this.cs * stride;
    for (let j = 0; j < H; j++) {
      for (let i = 0; i < W; i++) {
        const x = this.x0 + i * cs, z = this.z0 + j * cs;
        const k = (j * W + i) * 3;
        pos[k] = x; pos[k + 1] = this.height(x, z); pos[k + 2] = z;
        const hx = this.height(x + cs * 0.5, z) - this.height(x - cs * 0.5, z);
        const hz = this.height(x, z + cs * 0.5) - this.height(x, z - cs * 0.5);
        const n = new THREE.Vector3(-hx / cs, 1, -hz / cs).normalize();
        nor[k] = n.x; nor[k + 1] = n.y; nor[k + 2] = n.z;
      }
    }
    const idx = new Uint32Array((W - 1) * (H - 1) * 6);
    let o = 0;
    for (let j = 0; j < H - 1; j++) {
      for (let i = 0; i < W - 1; i++) {
        const a = j * W + i, b = a + 1, c = a + W, d = c + 1;
        idx[o++] = a; idx[o++] = c; idx[o++] = b;
        idx[o++] = b; idx[o++] = c; idx[o++] = d;
      }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    g.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
    g.setIndex(new THREE.BufferAttribute(idx, 1));
    g.computeBoundingSphere();
    return g;
  }

  /** RGBA8 normal map at full resolution (xz packed) for per-pixel shading detail. */
  normalTexture() {
    const { w, h, cs } = this;
    const px = new Uint8Array(w * h * 4);
    const d = this.data;
    for (let j = 0; j < h; j++) {
      for (let i = 0; i < w; i++) {
        const l = d[j * w + Math.max(0, i - 1)], r = d[j * w + Math.min(w - 1, i + 1)];
        const u = d[Math.max(0, j - 1) * w + i], b = d[Math.min(h - 1, j + 1) * w + i];
        let nx = -(r - l) / (2 * cs), nz = -(b - u) / (2 * cs), ny = 1;
        const len = Math.hypot(nx, ny, nz);
        nx /= len; ny /= len; nz /= len;
        const k = (j * w + i) * 4;
        px[k] = (nx * 0.5 + 0.5) * 255;
        px[k + 1] = (ny * 0.5 + 0.5) * 255;
        px[k + 2] = (nz * 0.5 + 0.5) * 255;
        px[k + 3] = 255;
      }
    }
    const t = new THREE.DataTexture(px, w, h, THREE.RGBAFormat);
    t.magFilter = THREE.LinearFilter;
    t.minFilter = THREE.LinearMipmapLinearFilter;
    t.generateMipmaps = true;
    t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping;
    t.needsUpdate = true;
    return t;
  }

  heightTexture() {
    const t = new THREE.DataTexture(this.data, this.w, this.h, THREE.RedFormat, THREE.FloatType);
    t.magFilter = THREE.LinearFilter;
    t.minFilter = THREE.LinearFilter;
    t.needsUpdate = true;
    return t;
  }
}

/** Terrain material: natural colours by altitude/slope + painted city ground + seasonal snow. */
export function terrainMaterial(hf, groundTex, groundBounds, normalTex) {
  const mat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.96, metalness: 0 });
  const uniforms = {
    uGround: { value: groundTex },
    uGroundB: { value: new THREE.Vector4(groundBounds.x0, groundBounds.z0, groundBounds.w, groundBounds.h) },
    uNormal: { value: normalTex },
    uTB: { value: new THREE.Vector4(hf.x0, hf.z0, (hf.w - 1) * hf.cs, (hf.h - 1) * hf.cs) },
    uSnow: { value: 0 },          // 0..1 seasonal snow cover in the valley
    uSnowLine: { value: 3300 },   // metres
    uAutumn: { value: 0 },
    uNight: { value: 0 },
  };
  mat.userData.uniforms = uniforms;
  mat.onBeforeCompile = (sh) => {
    Object.assign(sh.uniforms, uniforms);
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vW;')
      .replace('#include <worldpos_vertex>', '#include <worldpos_vertex>\nvW = (modelMatrix * vec4(transformed, 1.0)).xyz;');
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', `#include <common>
varying vec3 vW;
uniform sampler2D uGround; uniform vec4 uGroundB; uniform sampler2D uNormal; uniform vec4 uTB;
uniform float uSnow; uniform float uSnowLine; uniform float uAutumn; uniform float uNight;
float h21(vec2 p){ p = fract(p*vec2(123.34, 456.21)); p += dot(p, p+45.32); return fract(p.x*p.y); }
float vnoise(vec2 p){ vec2 i=floor(p), f=fract(p); f=f*f*(3.0-2.0*f);
  return mix(mix(h21(i),h21(i+vec2(1,0)),f.x), mix(h21(i+vec2(0,1)),h21(i+vec2(1,1)),f.x), f.y); }
float fbm(vec2 p){ float a=0.5, s=0.0; for(int i=0;i<4;i++){ s+=a*vnoise(p); p*=2.03; a*=0.5;} return s; }
`)
      .replace('#include <normal_fragment_begin>', `#include <normal_fragment_begin>
  vec2 tuv = (vW.xz - uTB.xy) / uTB.zw;
  vec3 nW = texture2D(uNormal, tuv).xyz * 2.0 - 1.0;
  normal = normalize((viewMatrix * vec4(nW, 0.0)).xyz);
`)
      .replace('#include <color_fragment>', `#include <color_fragment>
  {
    vec2 tuv = (vW.xz - uTB.xy) / uTB.zw;
    vec3 nW = normalize(texture2D(uNormal, tuv).xyz * 2.0 - 1.0);
    float slope = 1.0 - nW.y;               // 0 flat .. 1 vertical
    float h = vW.y;
    float n1 = fbm(vW.xz * 0.0011);
    float n2 = fbm(vW.xz * 0.008);
    // natural palette (linear-ish sRGB values)
    vec3 steppe = mix(vec3(0.50, 0.49, 0.33), vec3(0.40, 0.45, 0.27), n1);
    vec3 orchard = mix(vec3(0.30, 0.39, 0.22), vec3(0.42, 0.44, 0.26), n2);
    vec3 spruce = mix(vec3(0.13, 0.21, 0.15), vec3(0.18, 0.26, 0.17), n2);
    vec3 meadow = mix(vec3(0.38, 0.44, 0.27), vec3(0.47, 0.47, 0.32), n1);
    vec3 alpine = mix(vec3(0.43, 0.42, 0.35), vec3(0.50, 0.47, 0.40), n2);
    vec3 rock = mix(vec3(0.42, 0.40, 0.38), vec3(0.55, 0.52, 0.49), n2);
    vec3 snow = vec3(0.93, 0.95, 0.98);
    vec3 c = steppe;
    c = mix(c, orchard, smoothstep(900.0, 1150.0, h + n1 * 120.0));
    float north = smoothstep(0.05, -0.25, nW.z);   // north-facing slopes keep the Tian Shan spruce
    vec3 forest = mix(meadow, spruce, clamp(north * 1.2 + n2 * 0.4, 0.0, 1.0));
    c = mix(c, forest, smoothstep(1500.0, 1750.0, h + n1 * 150.0));
    c = mix(c, alpine, smoothstep(2650.0, 2900.0, h + n1 * 200.0));
    c = mix(c, rock, smoothstep(0.38, 0.62, slope) * smoothstep(1800.0, 2400.0, h));
    c = mix(c, rock, smoothstep(3000.0, 3300.0, h + n2 * 200.0) * 0.8);
    // autumn tint on low vegetation
    c = mix(c, c * vec3(1.25, 1.0, 0.62), uAutumn * smoothstep(2600.0, 1200.0, h) * 0.6);
    c = pow(c, vec3(2.2));               // palette above is sRGB
    // painted city ground (texture is sRGB-decoded by three)
    vec2 guv = (vW.xz - uGroundB.xy) / uGroundB.zw;
    vec4 g = texture2D(uGround, guv);
    float inG = step(0.0, guv.x) * step(guv.x, 1.0) * step(0.0, guv.y) * step(guv.y, 1.0);
    c = mix(c, g.rgb, g.a * inG);
    // snow: permanent above the snow line, seasonal in the valley
    float line = mix(uSnowLine, 450.0, uSnow);
    float sn = smoothstep(line - 120.0, line + 180.0, h + (n2 - 0.5) * 300.0) * (1.0 - smoothstep(0.45, 0.75, slope));
    sn = max(sn, smoothstep(0.62, 0.5, slope) * smoothstep(3500.0, 3800.0, h));
    c = mix(c, pow(snow, vec3(2.2)), clamp(sn, 0.0, 1.0));
    diffuseColor.rgb = c;
  }
`);
  };
  return mat;
}

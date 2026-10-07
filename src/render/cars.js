// Animated cars: a sample of the simulated vehicles drives along the road links
// at the simulated speed of the current hour; at night head- and tail-lights glow.

import * as THREE from 'three';

const PALETTE = [0xf2f2f2, 0xf2f2f2, 0xd9dcdf, 0xc0c4c8, 0x25272b, 0x3a3d42, 0x7d8288, 0x1f3550, 0x6e1d1d, 0xe3dccb, 0x2f4a36];

function carGeometry() {
  // body + cabin, x = forward
  const parts = [];
  const box = (sx, sy, sz, ox, oy, oz) => {
    const g = new THREE.BoxGeometry(sx, sy, sz);
    g.translate(ox, oy, oz);
    return g;
  };
  parts.push(box(4.4, 0.75, 1.8, 0, 0.55, 0));
  parts.push(box(2.3, 0.62, 1.6, -0.25, 1.22, 0));
  // light flags: 1 front, 2 rear (vertices on the end faces of the body)
  const geos = parts.map((g, gi) => {
    const pos = g.attributes.position;
    const flag = new Float32Array(pos.count);
    if (gi === 0) {
      for (let i = 0; i < pos.count; i++) {
        const x = pos.getX(i), y = pos.getY(i);
        const nx = g.attributes.normal.getX(i);
        if (nx > 0.9 && x > 2.1 && y > 0.5) flag[i] = 1;
        if (nx < -0.9 && x < -2.1 && y > 0.5) flag[i] = 2;
      }
    }
    g.setAttribute('aLight', new THREE.BufferAttribute(flag, 1));
    return g;
  });
  // merge manually
  let n = 0, ni = 0;
  for (const g of geos) { n += g.attributes.position.count; ni += g.index.count; }
  const pos = new Float32Array(n * 3), nor = new Float32Array(n * 3), lf = new Float32Array(n), idx = new Uint16Array(ni);
  let o = 0, oi = 0;
  for (const g of geos) {
    pos.set(g.attributes.position.array, o * 3);
    nor.set(g.attributes.normal.array, o * 3);
    lf.set(g.attributes.aLight.array, o);
    for (let i = 0; i < g.index.count; i++) idx[oi++] = g.index.array[i] + o;
    o += g.attributes.position.count;
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
  g.setAttribute('aLight', new THREE.BufferAttribute(lf, 1));
  g.setIndex(new THREE.BufferAttribute(idx, 1));
  return g;
}

export class Cars {
  constructor(rg, net, max = 9000) {
    this.rg = rg; this.net = net; this.max = max;
    const RL = net.roadLinks;
    this.RL = RL;
    // per link polyline (offset into the right lane), cumulative lengths
    const off = new Uint32Array(RL + 1);
    const lists = [];
    let tot = 0;
    for (let l = 0; l < RL; l++) {
      const twoWay = net.twin[l] >= 0;
      const side = twoWay ? 0.6 + net.lanes[l] * 1.7 : 0;
      const p = rg.linkPoints(net.seg[l], net.dir[l], side);
      lists.push(p);
      tot += p.length / 3;
      off[l + 1] = tot;
    }
    this.off = off;
    this.pts = new Float32Array(tot * 3);
    this.cum = new Float32Array(tot);
    for (let l = 0; l < RL; l++) {
      const p = lists[l];
      this.pts.set(p, off[l] * 3);
      let c = 0;
      for (let k = 0; k < p.length / 3; k++) {
        if (k) c += Math.hypot(p[3 * k] - p[3 * k - 3], p[3 * k + 2] - p[3 * k - 1]);
        this.cum[off[l] + k] = c;
      }
    }
    this.len = new Float32Array(RL);
    for (let l = 0; l < RL; l++) this.len[l] = this.cum[off[l + 1] - 1] || 1;
    // car state
    this.link = new Int32Array(max).fill(-1);
    this.s = new Float32Array(max);
    this.k = new Uint32Array(max);       // current piece index
    this.lane = new Float32Array(max);   // lateral jitter
    this.active = 0;
    // flows of the current hour
    this.speed = new Float32Array(RL).fill(10);
    this.weight = new Float32Array(RL);
    this.cdf = new Float32Array(RL);
    this.total = 0;
    const geo = carGeometry();
    this.material = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.35, metalness: 0.3 });
    const uniforms = { uNight: { value: 0 } };
    this.material.userData.uniforms = uniforms;
    this.material.onBeforeCompile = (sh) => {
      Object.assign(sh.uniforms, uniforms);
      sh.vertexShader = sh.vertexShader.replace('#include <common>', '#include <common>\nattribute float aLight; varying float vLight;')
        .replace('#include <begin_vertex>', '#include <begin_vertex>\nvLight = aLight;');
      sh.fragmentShader = sh.fragmentShader.replace('#include <common>', '#include <common>\nvarying float vLight; uniform float uNight;')
        .replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>
  if (vLight > 0.5) {
    vec3 lc = vLight < 1.5 ? vec3(1.0, 0.92, 0.75) * 9.0 : vec3(1.0, 0.08, 0.05) * 6.0;
    totalEmissiveRadiance += lc * (0.06 + uNight);
  }`);
    };
    this.mesh = new THREE.InstancedMesh(geo, this.material, max);
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.mesh.count = 0;
    this.mesh.frustumCulled = false;
    this.mesh.castShadow = false;
    this.mesh.receiveShadow = true;
    const col = new THREE.Color();
    for (let i = 0; i < max; i++) {
      col.setHex(PALETTE[(i * 7919) % PALETTE.length]);
      this.mesh.setColorAt(i, col);
    }
    this.mesh.instanceColor.needsUpdate = true;
    this.mesh.name = 'cars';
    this._m = new THREE.Matrix4();
    this._q = new THREE.Quaternion();
    this._v = new THREE.Vector3();
    this._s = new THREE.Vector3(1, 1, 1);
    this._up = new THREE.Vector3(0, 1, 0);
  }

  /** Set the flows of the displayed hour: volumes and speed ratios (snapshot arrays). */
  setFlows(snap, hour) {
    if (!snap) return;
    const RL = this.RL, slot = Math.floor(hour * 2) % 48;
    const net = this.net;
    let tot = 0;
    for (let l = 0; l < RL; l++) {
      const v = snap.vol[slot * RL + l] * 2;          // veh/h
      const r = Math.max(1, snap.ratio[slot * RL + l] / 20);
      const ff = net.len[l] / net.t0[l];               // m/s free flow
      const sp = ff / r;
      this.speed[l] = sp;
      // vehicles on the link = flow * travel time
      const n = v * (this.len[l] / sp) / 3600;
      this.weight[l] = n;
      tot += n;
      this.cdf[l] = tot;
    }
    this.total = tot;
    // ~1 rendered car per 12 simulated vehicles, capped
    const want = Math.min(this.max, Math.round(tot / 12));
    for (let i = this.active; i < want; i++) this.spawn(i);
    this.active = want;
    this.mesh.count = want;
  }

  spawn(i) {
    if (this.total <= 0) { this.link[i] = -1; return; }
    const u = Math.random() * this.total;
    let lo = 0, hi = this.RL - 1;
    while (lo < hi) { const m = (lo + hi) >> 1; if (this.cdf[m] < u) lo = m + 1; else hi = m; }
    this.link[i] = lo;
    this.s[i] = Math.random() * this.len[lo];
    this.k[i] = this.off[lo];
    this.lane[i] = Math.random() - 0.5;
  }

  /** Next link at the end node, weighted by flow; random respawn keeps the density honest. */
  next(i) {
    const l = this.link[i];
    const net = this.net;
    const v = net.to[l];
    let best = -1, sum = 0;
    if (Math.random() < 0.92) {
      for (let e = net.first[v]; e < net.first[v + 1]; e++) {
        const o = net.out[e];
        if (o >= this.RL || o === net.twin[l]) continue;
        const w = this.weight[o] + 0.01;
        sum += w;
        if (Math.random() * sum < w) best = o;
      }
    }
    if (best < 0) { this.spawn(i); this.s[i] = 0; return; }
    this.link[i] = best;
    this.s[i] = 0;
    this.k[i] = this.off[best];
  }

  update(dt, timeScale, visible) {
    if (!visible || this.active === 0) { this.mesh.visible = false; return; }
    this.mesh.visible = true;
    const m = this._m, q = this._q, p = this._v, sc = this._s, up = this._up;
    const pts = this.pts, cum = this.cum, off = this.off;
    const arr = this.mesh.instanceMatrix.array;
    for (let i = 0; i < this.active; i++) {
      let l = this.link[i];
      if (l < 0) { this.spawn(i); l = this.link[i]; if (l < 0) continue; }
      this.s[i] += this.speed[l] * dt * timeScale;
      let guard = 0;
      while (this.s[i] > this.len[l] && guard++ < 4) {
        const over = this.s[i] - this.len[l];
        this.next(i);
        l = this.link[i];
        this.s[i] = Math.min(over, this.len[l] * 0.5);
      }
      // advance piece index
      let k = this.k[i];
      const end = off[l + 1] - 1;
      if (k < off[l] || k >= end) k = off[l];
      while (k < end - 1 && cum[k + 1] < this.s[i]) k++;
      this.k[i] = k;
      const k2 = Math.min(end, k + 1);
      const segL = cum[k2] - cum[k] || 1;
      const t = Math.min(1, Math.max(0, (this.s[i] - cum[k]) / segL));
      const x0 = pts[3 * k], y0 = pts[3 * k + 1], z0 = pts[3 * k + 2];
      const x1 = pts[3 * k2], y1 = pts[3 * k2 + 1], z1 = pts[3 * k2 + 2];
      let dx = x1 - x0, dz = z1 - z0;
      const L = Math.hypot(dx, dz) || 1;
      dx /= L; dz /= L;
      const lj = this.lane[i] * Math.max(0, this.net.lanes[l] * 3.4 - 2.6);
      p.set(x0 + (x1 - x0) * t - dz * lj, y0 + (y1 - y0) * t + 0.45, z0 + (z1 - z0) * t + dx * lj);
      // yaw: model forward is +x
      const yaw = Math.atan2(-dz, dx);
      q.setFromAxisAngle(up, yaw);
      m.compose(p, q, sc);
      m.toArray(arr, i * 16);
    }
    this.mesh.instanceMatrix.needsUpdate = true;
  }
}

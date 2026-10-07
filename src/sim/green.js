// Mission 2 model: parks per capita and walking access to a park, from real
// OSM parks and per-building population estimates (residential floor area).

import { decodeLines } from '../data/loader.js';

const CELL = 50;          // raster cell (m)
const WALK = 700;         // ~10 minutes on foot
const T_HOUSE = 0, T_APART = 1, T_SMALL = 5;

export class GreenModel {
  constructor(data) {
    const meta = data.meta;
    this.meta = meta;
    this.draster = data.districts.d;
    const r = meta.districtRaster;
    this.x0 = r.x0; this.z0 = r.z0;
    this.w = Math.ceil((r.w * r.cs) / CELL); this.h = Math.ceil((r.h * r.cs) / CELL);
    this.park = new Uint8Array(this.w * this.h);
    this.access = new Uint8Array(this.w * this.h);
    // base parks: OSM leisure=park/garden polygons >= 1 ha inside the city
    const A = decodeLines(data.areas);
    const cls = meta.areas.classes;
    this.baseArea = 0;
    for (const p of meta.parks) this.baseArea += p.area;
    for (let i = 0; i < A.count; i++) {
      if (cls[A.kind[i]] !== 'park') continue;
      const a = A.start[i], b = A.start[i + 1];
      if (polyArea(A.xz, a, b) < 10000) continue;
      this.fillPoly(A.xz, a, b);
    }
    this.recomputeAccess();
    // buildings: centroid, population weight, type
    const B = decodeLines(data.buildings);
    const n = B.count;
    this.bx = new Float32Array(n); this.bz = new Float32Array(n);
    this.bpop = new Float32Array(n); this.btype = B.kind; this.bd = new Uint8Array(n);
    this.bgone = new Uint8Array(n);
    const dpop = new Float64Array(8);
    for (let i = 0; i < n; i++) {
      const a = B.start[i], b = B.start[i + 1];
      let cx = 0, cz = 0;
      for (let k = a; k < b; k++) { cx += B.xz[2 * k]; cz += B.xz[2 * k + 1]; }
      cx /= b - a; cz /= b - a;
      this.bx[i] = cx; this.bz[i] = cz;
      const t = B.kind[i];
      const floors = Math.max(1, Math.round(data.buildings.height[i] * 0.1 / 3.1));
      const area = polyArea(B.xz, a, b);
      this.bpop[i] = t === T_HOUSE || t === T_APART ? area * floors : 0;
      const d = this.districtAt(cx, cz);
      this.bd[i] = d < 0 ? 255 : d;
      if (d >= 0) dpop[d] += this.bpop[i];
    }
    // scale to the official district populations
    for (let i = 0; i < n; i++) {
      const d = this.bd[i];
      if (d < 8 && dpop[d] > 0) this.bpop[i] *= meta.districts[d].pop / dpop[d];
    }
    // spatial grid of buildings for park placement
    this.grid = new Map();
    for (let i = 0; i < n; i++) {
      const k = `${Math.floor(this.bx[i] / 200)},${Math.floor(this.bz[i] / 200)}`;
      let a = this.grid.get(k);
      if (!a) this.grid.set(k, (a = []));
      a.push(i);
    }
    this.extra = [];
    this.extraArea = 0;
  }

  districtAt(x, z) {
    const r = this.meta.districtRaster;
    const i = Math.floor((x - r.x0) / r.cs), j = Math.floor((z - r.z0) / r.cs);
    if (i < 0 || j < 0 || i >= r.w || j >= r.h) return -1;
    return this.draster[j * r.w + i] - 1;
  }

  fillPoly(xz, a, b) {
    let z0 = Infinity, z1 = -Infinity;
    for (let k = a; k < b; k++) { z0 = Math.min(z0, xz[2 * k + 1]); z1 = Math.max(z1, xz[2 * k + 1]); }
    const j0 = Math.max(0, Math.floor((z0 - this.z0) / CELL)), j1 = Math.min(this.h - 1, Math.floor((z1 - this.z0) / CELL));
    for (let j = j0; j <= j1; j++) {
      const z = this.z0 + (j + 0.5) * CELL;
      const xs = [];
      for (let k = a, m = b - 1; k < b; m = k++) {
        const za = xz[2 * k + 1], zb = xz[2 * m + 1];
        if ((za > z) !== (zb > z)) xs.push(xz[2 * k] + (z - za) / (zb - za) * (xz[2 * m] - xz[2 * k]));
      }
      xs.sort((p, q) => p - q);
      for (let t = 0; t + 1 < xs.length; t += 2) {
        const i0 = Math.max(0, Math.ceil((xs[t] - this.x0) / CELL - 0.5)), i1 = Math.min(this.w - 1, Math.floor((xs[t + 1] - this.x0) / CELL - 0.5));
        for (let i = i0; i <= i1; i++) this.park[j * this.w + i] = 1;
      }
    }
  }

  /** Cells within WALK of any park cell (chamfer distance transform). */
  recomputeAccess() {
    const { w, h } = this;
    const INF = 1e9;
    const d = new Float32Array(w * h);
    for (let i = 0; i < w * h; i++) d[i] = this.park[i] ? 0 : INF;
    const a = CELL, b = CELL * Math.SQRT2;
    for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) {
      const k = j * w + i;
      let v = d[k];
      if (i > 0) v = Math.min(v, d[k - 1] + a);
      if (j > 0) { v = Math.min(v, d[k - w] + a); if (i > 0) v = Math.min(v, d[k - w - 1] + b); if (i < w - 1) v = Math.min(v, d[k - w + 1] + b); }
      d[k] = v;
    }
    for (let j = h - 1; j >= 0; j--) for (let i = w - 1; i >= 0; i--) {
      const k = j * w + i;
      let v = d[k];
      if (i < w - 1) v = Math.min(v, d[k + 1] + a);
      if (j < h - 1) { v = Math.min(v, d[k + w] + a); if (i < w - 1) v = Math.min(v, d[k + w + 1] + b); if (i > 0) v = Math.min(v, d[k + w - 1] + b); }
      d[k] = v;
    }
    for (let i = 0; i < w * h; i++) this.access[i] = d[i] <= WALK ? 1 : 0;
  }

  cellOf(x, z) {
    const i = Math.floor((x - this.x0) / CELL), j = Math.floor((z - this.z0) / CELL);
    if (i < 0 || j < 0 || i >= this.w || j >= this.h) return -1;
    return j * this.w + i;
  }

  /** { perCapita (m²), access[8] (share of residents within 10 min walk), areaHa } */
  stats(population) {
    const acc = new Float64Array(8), tot = new Float64Array(8);
    for (let i = 0; i < this.bx.length; i++) {
      const d = this.bd[i];
      if (d >= 8 || this.bgone[i] || !this.bpop[i]) continue;
      tot[d] += this.bpop[i];
      const c = this.cellOf(this.bx[i], this.bz[i]);
      if (c >= 0 && this.access[c]) acc[d] += this.bpop[i];
    }
    const area = this.baseArea + this.extraArea;
    return {
      perCapita: area / Math.max(1, population),
      access: Array.from(acc, (v, d) => (tot[d] ? v / tot[d] : 0)),
      areaHa: area / 1e4,
    };
  }

  /** Buildings under a circular park and what clearing them costs. */
  survey(x, z, r) {
    const out = { houses: 0, small: 0, apartments: 0, other: 0, ids: [], parkShare: 0 };
    const g0 = Math.floor((x - r) / 200), g1 = Math.floor((x + r) / 200);
    const h0 = Math.floor((z - r) / 200), h1 = Math.floor((z + r) / 200);
    for (let gx = g0; gx <= g1; gx++) for (let gz = h0; gz <= h1; gz++) {
      for (const i of this.grid.get(`${gx},${gz}`) || []) {
        if (this.bgone[i] || Math.hypot(this.bx[i] - x, this.bz[i] - z) > r) continue;
        const t = this.btype[i];
        if (t === T_HOUSE) out.houses++;
        else if (t === T_SMALL) out.small++;
        else if (t === T_APART || t === 7) out.apartments++;
        else out.other++;
        out.ids.push(i);
      }
    }
    // overlap with existing parks
    let pc = 0, all = 0;
    const step = Math.max(CELL, r / 8);
    for (let dx = -r; dx <= r; dx += step) for (let dz = -r; dz <= r; dz += step) {
      if (dx * dx + dz * dz > r * r) continue;
      all++;
      const c = this.cellOf(x + dx, z + dz);
      if (c >= 0 && this.park[c]) pc++;
    }
    out.parkShare = all ? pc / all : 0;
    return out;
  }

  addPark(x, z, r, ids) {
    for (const i of ids) this.bgone[i] = 1;
    const i0 = Math.floor((x - r - this.x0) / CELL), i1 = Math.floor((x + r - this.x0) / CELL);
    const j0 = Math.floor((z - r - this.z0) / CELL), j1 = Math.floor((z + r - this.z0) / CELL);
    for (let j = Math.max(0, j0); j <= Math.min(this.h - 1, j1); j++) {
      for (let i = Math.max(0, i0); i <= Math.min(this.w - 1, i1); i++) {
        const cx = this.x0 + (i + 0.5) * CELL, cz = this.z0 + (j + 0.5) * CELL;
        if (Math.hypot(cx - x, cz - z) <= r) this.park[j * this.w + i] = 1;
      }
    }
    // access within WALK of the new park
    const R = r + WALK;
    const a0 = Math.floor((x - R - this.x0) / CELL), a1 = Math.floor((x + R - this.x0) / CELL);
    const b0 = Math.floor((z - R - this.z0) / CELL), b1 = Math.floor((z + R - this.z0) / CELL);
    for (let j = Math.max(0, b0); j <= Math.min(this.h - 1, b1); j++) {
      for (let i = Math.max(0, a0); i <= Math.min(this.w - 1, a1); i++) {
        const cx = this.x0 + (i + 0.5) * CELL, cz = this.z0 + (j + 0.5) * CELL;
        if (Math.hypot(cx - x, cz - z) <= R) this.access[j * this.w + i] = 1;
      }
    }
    this.extraArea += Math.PI * r * r;
    this.extra.push({ x, z, r });
  }

  /** Floor area of private houses per district (coal stoves heat these in winter). */
  houseShare() {
    const s = new Float64Array(8);
    for (let i = 0; i < this.bx.length; i++) if (this.btype[i] === T_HOUSE && this.bd[i] < 8 && !this.bgone[i]) s[this.bd[i]] += this.bpop[i];
    const t = s.reduce((a, b) => a + b, 0) || 1;
    return Array.from(s, v => v / t);
  }
}

function polyArea(xz, a, b) {
  let s = 0;
  for (let i = a, j = b - 1; i < b; j = i++) s += xz[2 * j] * xz[2 * i + 1] - xz[2 * i] * xz[2 * j + 1];
  return Math.abs(s) / 2;
}

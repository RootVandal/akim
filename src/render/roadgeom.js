// Shared road geometry: draped polylines per segment, per directed link and a
// spatial index for picking. Used by the road surfaces, the traffic overlay and the cars.

const STEP = 35; // max distance between draped points (m)

export class RoadGeom {
  constructor(meta, R, hf, net) {
    this.meta = meta; this.R = R; this.hf = hf; this.net = net;
    const S = meta.roads.segCount;
    this.S = S;
    // draped polyline per segment: xyz + cumulative length
    const off = new Uint32Array(S + 1);
    const tmp = [];
    let total = 0;
    for (let s = 0; s < S; s++) {
      const p0 = R.seg_p0[s], pn = R.seg_pn[s];
      const pts = [];
      for (let k = 0; k < pn; k++) {
        const x = R.pts[2 * (p0 + k)], z = R.pts[2 * (p0 + k) + 1];
        const e = R.elev[p0 + k] * 0.25;
        if (k > 0) {
          const [px, , pz, pe] = pts[pts.length - 1];
          const d = Math.hypot(x - px, z - pz);
          const nsub = Math.floor(d / STEP);
          for (let j = 1; j <= nsub; j++) {
            const t = j / (nsub + 1);
            pts.push([px + (x - px) * t, 0, pz + (z - pz) * t, pe + (e - pe) * t]);
          }
        }
        pts.push([x, 0, z, e]);
      }
      tmp.push(pts);
      total += pts.length;
      off[s + 1] = total;
    }
    this.off = off;
    this.xyz = new Float32Array(total * 3);
    this.cum = new Float32Array(total);
    this.elevLift = new Float32Array(total);
    for (let s = 0; s < S; s++) {
      const pts = tmp[s];
      let c = 0;
      for (let k = 0; k < pts.length; k++) {
        const i = off[s] + k;
        const [x, , z, e] = pts[k];
        if (k > 0) c += Math.hypot(x - pts[k - 1][0], z - pts[k - 1][2]);
        this.xyz[3 * i] = x;
        this.xyz[3 * i + 1] = hf.height(x, z) + e;
        this.xyz[3 * i + 2] = z;
        this.cum[i] = c;
        this.elevLift[i] = e;
      }
    }
    // widths
    this.width = new Float32Array(S);
    for (let s = 0; s < S; s++) {
      const lanes = R.seg_lf[s] + R.seg_lb[s];
      const oneway = R.seg_lb[s] === 0;
      this.width[s] = lanes * 3.4 + (oneway ? 1.2 : 2.4);
    }
    this.buildIndex();
  }

  segLength(s) { return this.cum[this.off[s + 1] - 1]; }

  /** Uniform grid of segment pieces for nearest-road queries. */
  buildIndex() {
    const C = this.cell = 150;
    const map = new Map();
    for (let s = 0; s < this.S; s++) {
      for (let i = this.off[s]; i < this.off[s + 1] - 1; i++) {
        const x0 = this.xyz[3 * i], z0 = this.xyz[3 * i + 2], x1 = this.xyz[3 * i + 3], z1 = this.xyz[3 * i + 5];
        const gx0 = Math.floor(Math.min(x0, x1) / C), gx1 = Math.floor(Math.max(x0, x1) / C);
        const gz0 = Math.floor(Math.min(z0, z1) / C), gz1 = Math.floor(Math.max(z0, z1) / C);
        for (let gx = gx0; gx <= gx1; gx++) for (let gz = gz0; gz <= gz1; gz++) {
          const k = gx * 100003 + gz;
          let a = map.get(k);
          if (!a) map.set(k, (a = []));
          a.push(i, s);
        }
      }
    }
    this.grid = map;
  }

  /** Nearest segment to (x,z) within maxDist. Returns { seg, dist, t } or null. */
  nearest(x, z, maxDist, filter) {
    const C = this.cell;
    const r = Math.ceil(maxDist / C);
    const gx = Math.floor(x / C), gz = Math.floor(z / C);
    let best = null, bd = maxDist;
    for (let i = -r; i <= r; i++) for (let j = -r; j <= r; j++) {
      const a = this.grid.get((gx + i) * 100003 + (gz + j));
      if (!a) continue;
      for (let k = 0; k < a.length; k += 2) {
        const p = a[k], s = a[k + 1];
        if (filter && !filter(s)) continue;
        const x0 = this.xyz[3 * p], z0 = this.xyz[3 * p + 2], x1 = this.xyz[3 * p + 3], z1 = this.xyz[3 * p + 5];
        const dx = x1 - x0, dz = z1 - z0;
        const L2 = dx * dx + dz * dz || 1;
        let t = ((x - x0) * dx + (z - z0) * dz) / L2;
        t = t < 0 ? 0 : t > 1 ? 1 : t;
        const d = Math.hypot(x - (x0 + t * dx), z - (z0 + t * dz)) - this.width[s] * 0.5;
        if (d < bd) { bd = d; best = { seg: s, dist: Math.max(0, d), piece: p }; }
      }
    }
    return best;
  }

  /**
   * Points of a directed link (dir +1 forward, -1 backward) offset to the right
   * by `side` metres. Returns Float32Array xyz.
   */
  linkPoints(seg, dir, side) {
    const a = this.off[seg], b = this.off[seg + 1];
    const n = b - a;
    const out = new Float32Array(n * 3);
    for (let k = 0; k < n; k++) {
      const i = dir > 0 ? a + k : b - 1 - k;
      const ip = dir > 0 ? Math.max(a, i - 1) : Math.min(b - 1, i + 1);
      const inx = dir > 0 ? Math.min(b - 1, i + 1) : Math.max(a, i - 1);
      let tx = this.xyz[3 * inx] - this.xyz[3 * ip], tz = this.xyz[3 * inx + 2] - this.xyz[3 * ip + 2];
      const L = Math.hypot(tx, tz) || 1;
      tx /= L; tz /= L;
      // right of travel direction (x east, z south, y up): (-tz, tx)
      out[3 * k] = this.xyz[3 * i] - tz * side;
      out[3 * k + 1] = this.xyz[3 * i + 1];
      out[3 * k + 2] = this.xyz[3 * i + 2] + tx * side;
    }
    return out;
  }
}

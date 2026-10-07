// Builds the extruded building geometry off the main thread, chunked in 2 km tiles.
import { ShapeUtils } from '../../vendor/three/three.core.js';

const TILE = 2000;
const T_HOUSE = 0;

self.onmessage = (e) => {
  const { count, kind, origin, delta, height, terrain, tmeta } = e.data;
  const hf = makeHeight(terrain, tmeta);
  // decode rings
  const start = new Uint32Array(count.length + 1);
  for (let i = 0; i < count.length; i++) start[i + 1] = start[i] + count[i];
  const xz = new Float32Array(start[count.length] * 2);
  let d = 0;
  for (let i = 0; i < count.length; i++) {
    let x = origin[2 * i], z = origin[2 * i + 1];
    let o = start[i] * 2;
    xz[o++] = x * 0.1; xz[o++] = z * 0.1;
    for (let k = 1; k < count[i]; k++) { x += delta[d++]; z += delta[d++]; xz[o++] = x * 0.1; xz[o++] = z * 0.1; }
  }
  // bucket by tile of the first vertex
  const buckets = new Map();
  for (let i = 0; i < count.length; i++) {
    const a = start[i] * 2;
    const key = `${Math.floor(xz[a] / TILE)},${Math.floor(xz[a + 1] / TILE)}`;
    let b = buckets.get(key);
    if (!b) buckets.set(key, (b = []));
    b.push(i);
  }
  const chunks = [];
  const transfer = [];
  let done = 0;
  for (const [key, list0] of buckets) {
    // big buildings first: far away only that part of the index range is drawn
    const isSmall = i => (kind[i] === 0 || kind[i] === 5) && height[i] < 95;
    const list = list0.filter(i => !isSmall(i)).concat(list0.filter(isSmall));
    let tBig = -1;
    // size estimate
    let nv = 0, ni = 0;
    for (const i of list) {
      const n = count[i];
      const gable = kind[i] === T_HOUSE && n === 4 && height[i] < 90;
      nv += 2 * (n + 1) + (gable ? 18 : 0);
      ni += (3 * n + (gable ? 6 : 0)) * 3;
    }
    const pos = new Float32Array(nv * 3);
    const wall = new Float32Array(nv * 2);
    const info = new Uint8Array(nv * 4);
    const idx = new Uint32Array(ni);
    let v = 0, t = 0;
    let minX = Infinity, minY = Infinity, minZ = Infinity, maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
    const put = (x, y, z, u, h, typ, rnd, flag) => {
      pos[v * 3] = x; pos[v * 3 + 1] = y; pos[v * 3 + 2] = z;
      wall[v * 2] = u; wall[v * 2 + 1] = h;
      info[v * 4] = typ; info[v * 4 + 1] = rnd; info[v * 4 + 2] = flag; info[v * 4 + 3] = 0;
      if (x < minX) minX = x; if (x > maxX) maxX = x;
      if (y < minY) minY = y; if (y > maxY) maxY = y;
      if (z < minZ) minZ = z; if (z > maxZ) maxZ = z;
      return v++;
    };
    const ids = new Uint32Array(list.length), vstart = new Uint32Array(list.length + 1);
    let bi = 0;
    for (const i of list) {
      if (tBig < 0 && isSmall(i)) tBig = t;
      ids[bi] = i; vstart[bi] = v; bi++;
      const n = count[i];
      const a = start[i] * 2;
      const typ = kind[i];
      const H = Math.max(2.5, height[i] * 0.1);
      // base: lowest terrain point under the footprint
      let base = Infinity, area = 0;
      for (let k = 0; k < n; k++) {
        const x = xz[a + 2 * k], z = xz[a + 2 * k + 1];
        const h = hf(x, z);
        if (h < base) base = h;
        const k2 = (k + 1) % n;
        area += x * xz[a + 2 * k2 + 1] - xz[a + 2 * k2] * z;
      }
      const sigma = area >= 0 ? 1 : -1;
      const rnd = (hash(xz[a], xz[a + 1]) * 255) | 0;
      const bot = base - 2.0;
      const gable = typ === T_HOUSE && n === 4 && H < 9;
      const eave = gable ? H - Math.min(2.6, 0.9 + H * 0.18) : H;
      const top = base + eave;
      // walls: ring of n+1 vertices bottom and top (u = perimeter coordinate)
      const b0 = v;
      let u = 0;
      for (let k = 0; k <= n; k++) {
        const kk = k % n;
        const x = xz[a + 2 * kk], z = xz[a + 2 * kk + 1];
        if (k > 0) { const kp = (k - 1) % n; u += Math.hypot(x - xz[a + 2 * kp], z - xz[a + 2 * kp + 1]); }
        put(x, bot, z, u, -2.0, typ, rnd, 0);
        put(x, top, z, u, eave, typ, rnd, 0);
      }
      for (let k = 0; k < n; k++) {
        const A = b0 + 2 * k, B = b0 + 2 * (k + 1), At = A + 1, Bt = B + 1;
        if (sigma > 0) { idx[t++] = A; idx[t++] = At; idx[t++] = B; idx[t++] = B; idx[t++] = At; idx[t++] = Bt; }
        else { idx[t++] = A; idx[t++] = B; idx[t++] = At; idx[t++] = B; idx[t++] = Bt; idx[t++] = At; }
      }
      if (gable) {
        // ridge along the longer axis of the rectangle
        const P = k => [xz[a + 2 * k], xz[a + 2 * k + 1]];
        const p = [P(0), P(1), P(2), P(3)];
        const l01 = Math.hypot(p[1][0] - p[0][0], p[1][1] - p[0][1]);
        const l12 = Math.hypot(p[2][0] - p[1][0], p[2][1] - p[1][1]);
        const s = l01 >= l12 ? 0 : 1; // long edge starts at s
        const q = [p[s], p[(s + 1) % 4], p[(s + 2) % 4], p[(s + 3) % 4]];
        const mA = [(q[3][0] + q[0][0]) / 2, (q[3][1] + q[0][1]) / 2];
        const mB = [(q[1][0] + q[2][0]) / 2, (q[1][1] + q[2][1]) / 2];
        const ridge = base + H;
        const tri = (P1, P2, P3, uu) => {
          const i1 = put(P1[0], P1[2], P1[1], uu, P1[3], typ, rnd, 1);
          const i2 = put(P2[0], P2[2], P2[1], uu, P2[3], typ, rnd, 1);
          const i3 = put(P3[0], P3[2], P3[1], uu, P3[3], typ, rnd, 1);
          upTri(pos, idx, t, i1, i2, i3, P1, P2, P3);
          t += 3;
        };
        const V = (pt, y, hh) => [pt[0], pt[1], y, hh];
        // two slopes (each as 2 triangles), two gables
        const r0 = V(q[0], top, eave), r1 = V(q[1], top, eave), r2 = V(q[2], top, eave), r3 = V(q[3], top, eave);
        const ra = V(mA, ridge, H), rb = V(mB, ridge, H);
        tri(r0, r1, rb, 0); tri(r0, rb, ra, 0);
        tri(r2, r3, ra, 0); tri(r2, ra, rb, 0);
        // gables are walls: orient outward by the footprint centre
        const cx = (q[0][0] + q[2][0]) / 2, cz = (q[0][1] + q[2][1]) / 2;
        gableTri(put, idx, () => t, k => { t = k; }, r1, r2, rb, cx, cz, typ, rnd);
        gableTri(put, idx, () => t, k => { t = k; }, r3, r0, ra, cx, cz, typ, rnd);
      } else {
        // flat roof on the top ring
        const ring = [];
        for (let k = 0; k < n; k++) ring.push(b0 + 2 * k + 1);
        if (n === 3) {
          t = roofTri(pos, idx, t, ring[0], ring[1], ring[2]);
        } else if (n === 4 && convex4(xz, a)) {
          t = roofTri(pos, idx, t, ring[0], ring[1], ring[2]);
          t = roofTri(pos, idx, t, ring[0], ring[2], ring[3]);
        } else {
          const contour = [];
          for (let k = 0; k < n; k++) contour.push({ x: xz[a + 2 * k], y: xz[a + 2 * k + 1] });
          let tris;
          try { tris = ShapeUtils.triangulateShape(contour, []); } catch { tris = []; }
          for (const [i0, i1, i2] of tris) {
            if (t + 3 > idx.length) break;
            t = roofTri(pos, idx, t, ring[i0], ring[i1], ring[i2]);
          }
        }
      }
      done++;
    }
    vstart[bi] = v;
    const P = pos.slice(0, v * 3), W = wall.slice(0, v * 2), I = info.slice(0, v * 4), X = idx.slice(0, t);
    chunks.push({ key, pos: P, wall: W, info: I, index: X, ids, vstart, big: tBig < 0 ? t : tBig, box: [minX, minY, minZ, maxX, maxY, maxZ] });
    transfer.push(P.buffer, W.buffer, I.buffer, X.buffer, ids.buffer, vstart.buffer);
    self.postMessage({ type: 'progress', f: done / count.length });
  }
  self.postMessage({ type: 'done', chunks }, transfer);
};

function roofTri(pos, idx, t, i0, i1, i2) {
  // make the face point up
  const ax = pos[i1 * 3] - pos[i0 * 3], az = pos[i1 * 3 + 2] - pos[i0 * 3 + 2];
  const bx = pos[i2 * 3] - pos[i0 * 3], bz = pos[i2 * 3 + 2] - pos[i0 * 3 + 2];
  const ny = az * bx - ax * bz;
  if (ny >= 0) { idx[t++] = i0; idx[t++] = i1; idx[t++] = i2; }
  else { idx[t++] = i0; idx[t++] = i2; idx[t++] = i1; }
  return t;
}

function upTri(pos, idx, t, i0, i1, i2) {
  roofTri(pos, idx, t, i0, i1, i2);
}

function gableTri(put, idx, getT, setT, P1, P2, P3, cx, cz, typ, rnd) {
  let t = getT();
  // outward normal of the gable: from the footprint centre to the gable's base midpoint
  const mx = (P1[0] + P2[0]) / 2, mz = (P1[1] + P2[1]) / 2;
  const ox = mx - cx, oz = mz - cz;
  const i1 = put(P1[0], P1[2], P1[1], 0, P1[3], typ, rnd, 0);
  const i2 = put(P2[0], P2[2], P2[1], Math.hypot(P2[0] - P1[0], P2[1] - P1[1]), P2[3], typ, rnd, 0);
  const i3 = put(P3[0], P3[2], P3[1], Math.hypot(P3[0] - P1[0], P3[1] - P1[1]), P3[3], typ, rnd, 0);
  // normal of (P1,P2,P3) projected on xz: (B-A) x (C-A)
  const ax = P2[0] - P1[0], ay = P2[2] - P1[2], az = P2[1] - P1[1];
  const bx = P3[0] - P1[0], by = P3[2] - P1[2], bz = P3[1] - P1[1];
  const nx = ay * bz - az * by, nz = ax * by - ay * bx;
  if (nx * ox + nz * oz >= 0) { idx[t++] = i1; idx[t++] = i2; idx[t++] = i3; }
  else { idx[t++] = i1; idx[t++] = i3; idx[t++] = i2; }
  setT(t);
}

function convex4(xz, a) {
  let sign = 0;
  for (let k = 0; k < 4; k++) {
    const x0 = xz[a + 2 * k], z0 = xz[a + 2 * k + 1];
    const x1 = xz[a + 2 * ((k + 1) % 4)], z1 = xz[a + 2 * ((k + 1) % 4) + 1];
    const x2 = xz[a + 2 * ((k + 2) % 4)], z2 = xz[a + 2 * ((k + 2) % 4) + 1];
    const c = (x1 - x0) * (z2 - z1) - (z1 - z0) * (x2 - x1);
    if (c !== 0) { if (sign === 0) sign = Math.sign(c); else if (Math.sign(c) !== sign) return false; }
  }
  return true;
}

function hash(x, z) {
  const s = Math.sin(x * 12.9898 + z * 78.233) * 43758.5453;
  return s - Math.floor(s);
}

function makeHeight(data, t) {
  const { x0, z0, cs, w, h } = t;
  return (x, z) => {
    let fx = (x - x0) / cs, fz = (z - z0) / cs;
    fx = Math.max(0, Math.min(w - 1.001, fx)); fz = Math.max(0, Math.min(h - 1.001, fz));
    const i = fx | 0, j = fz | 0, u = fx - i, v = fz - j, k = j * w + i;
    return ((data[k] * (1 - u) + data[k + 1] * u) * (1 - v) + (data[k + w] * (1 - u) + data[k + w + 1] * u) * v);
  };
}

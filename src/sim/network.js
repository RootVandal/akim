// Directed routing network built from the road segments of roads.bin.
// Zone nodes (internal zones + external gates) are appended after the
// road nodes and joined by connector links that carry no metrics.

import {
  CRUISE_KMH, LINK_CRUISE_KMH, CAP_PER_LANE, LINK_CAP_PER_LANE, CAPACITY_SCALE, TUNE,
} from './params.js';

export const F_ROUTABLE = 1, F_LINK = 2, F_BRIDGE = 4, F_TUNNEL = 8, F_ROUNDABOUT = 16, F_ONEWAY = 32;

export function buildNetwork(meta, R) {
  const S = meta.roads.segCount;
  const N = meta.roads.nodeCount;
  const zones = meta.zones;
  const gates = meta.roads.gates;
  const Z = zones.length, G = gates.length, K = Z + G;

  // count links
  let L = 0;
  for (let s = 0; s < S; s++) {
    if (!(R.seg_flags[s] & F_ROUTABLE)) continue;
    if (R.seg_lf[s] > 0) L++;
    if (R.seg_lb[s] > 0) L++;
  }
  const roadLinks = L;
  for (const z of zones) L += 2 * z.conn.length;
  for (const g of gates) L += 2 * g.nodes.length;

  const net = {
    N, S, Z, G, K, nodes: N + K, links: L, roadLinks,
    from: new Int32Array(L), to: new Int32Array(L), seg: new Int32Array(L), dir: new Int8Array(L),
    cls: new Uint8Array(L), isLink: new Uint8Array(L), lanes: new Uint8Array(L), bus: new Uint8Array(L),
    len: new Float32Array(L), t0: new Float32Array(L), cap: new Float32Array(L), district: new Uint8Array(L),
    parking: new Uint8Array(L), // 1 = curb parking reduces capacity
    twin: new Int32Array(L).fill(-1), // opposite direction of the same segment
    segLinks: new Int32Array(S * 2).fill(-1), // [fwd, bwd] link per segment
    zoneNode: k => N + k,
  };
  let l = 0;
  const addRoad = (s, a, b, dir, lanes, bus) => {
    const c = R.seg_cls[s];
    const isLink = (R.seg_flags[s] & F_LINK) !== 0;
    const len = Math.max(5, R.seg_len[s]);
    const lim = R.seg_speed[s];
    let v = isLink ? LINK_CRUISE_KMH : CRUISE_KMH[c];
    v = Math.min(v, lim * 0.95);
    net.from[l] = a; net.to[l] = b; net.seg[l] = s; net.dir[l] = dir;
    net.cls[l] = c; net.isLink[l] = isLink ? 1 : 0;
    net.lanes[l] = lanes; net.bus[l] = Math.min(bus, Math.max(0, lanes - 1));
    net.len[l] = len;
    net.t0[l] = len / (v / 3.6);
    net.parking[l] = (!isLink && c >= 3 && !(R.seg_flags[s] & F_BRIDGE)) ? 1 : 0;
    net.cap[l] = (isLink ? LINK_CAP_PER_LANE : CAP_PER_LANE[c]) * CAPACITY_SCALE * TUNE.capacity; // per lane
    net.district[l] = R.seg_district[s];
    net.segLinks[s * 2 + (dir > 0 ? 0 : 1)] = l;
    return l++;
  };
  for (let s = 0; s < S; s++) {
    if (!(R.seg_flags[s] & F_ROUTABLE)) continue;
    const a = R.seg_a[s], b = R.seg_b[s];
    let f = -1, r = -1;
    if (R.seg_lf[s] > 0) f = addRoad(s, a, b, 1, R.seg_lf[s], R.seg_bf[s]);
    if (R.seg_lb[s] > 0) r = addRoad(s, b, a, -1, R.seg_lb[s], R.seg_bb[s]);
    if (f >= 0 && r >= 0) { net.twin[f] = r; net.twin[r] = f; }
  }
  const nodeX = R.nodes;
  const addConn = (a, b, t) => {
    net.from[l] = a; net.to[l] = b; net.seg[l] = -1; net.dir[l] = 0;
    net.cls[l] = 255; net.lanes[l] = 0; net.len[l] = 0; net.t0[l] = t; net.cap[l] = 1e9;
    net.district[l] = 255;
    return l++;
  };
  net.zoneConn = [];
  zones.forEach((z, k) => {
    const zn = N + k;
    const list = [];
    z.conn.forEach((c, i) => {
      // walk/drive-in time from the activity centroid to the major road
      const t = 50 + (z.connD[i] * 1.35) / (24 / 3.6);
      list.push(addConn(zn, c, t), addConn(c, zn, t));
    });
    net.zoneConn.push(list);
  });
  gates.forEach((g, gi) => {
    const zn = N + Z + gi;
    const list = [];
    for (const c of g.nodes) list.push(addConn(zn, c, 20), addConn(c, zn, 20));
    net.zoneConn.push(list);
  });
  net.isConn = l => net.seg[l] < 0;

  // CSR adjacency (outgoing links)
  const nn = N + K;
  const first = new Int32Array(nn + 1);
  for (let i = 0; i < L; i++) first[net.from[i] + 1]++;
  for (let i = 0; i < nn; i++) first[i + 1] += first[i];
  const fill = first.slice(0, nn);
  const out = new Int32Array(L);
  for (let i = 0; i < L; i++) out[fill[net.from[i]]++] = i;
  net.first = first;
  net.out = out;
  // incoming adjacency (for the visual car flow and interchanges)
  const firstIn = new Int32Array(nn + 1);
  for (let i = 0; i < L; i++) firstIn[net.to[i] + 1]++;
  for (let i = 0; i < nn; i++) firstIn[i + 1] += firstIn[i];
  const fillIn = firstIn.slice(0, nn);
  const inc = new Int32Array(L);
  for (let i = 0; i < L; i++) inc[fillIn[net.to[i]]++] = i;
  net.firstIn = firstIn;
  net.inc = inc;
  net.nodeX = nodeX;
  return net;
}

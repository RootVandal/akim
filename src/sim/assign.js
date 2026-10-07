// Shortest-path trees (Dijkstra, binary heap on typed arrays) and
// all-or-nothing loading of many trip purposes onto one tree at once.

export class Router {
  constructor(net) {
    const n = net.nodes;
    this.net = net;
    this.dist = new Float64Array(n);
    this.pred = new Int32Array(n);
    this.order = new Int32Array(n);
    this.nOrder = 0;
    this.done = new Uint8Array(n);
    const cap = net.links + n + 16;
    this.hN = new Int32Array(cap);
    this.hK = new Float64Array(cap);
  }

  /** Shortest-path tree from `src` with per-link costs (Infinity = closed link). */
  tree(src, cost) {
    const { first, out, to, N } = this.net;
    const dist = this.dist, pred = this.pred, done = this.done, order = this.order;
    const hN = this.hN, hK = this.hK;
    dist.fill(Infinity);
    pred.fill(-1);
    done.fill(0);
    let size = 0, nOrder = 0;
    dist[src] = 0;
    hN[0] = src; hK[0] = 0; size = 1;
    while (size > 0) {
      const u = hN[0], d = hK[0];
      // pop
      size--;
      if (size > 0) {
        const lastN = hN[size], lastK = hK[size];
        let i = 0;
        for (;;) {
          const lc = 2 * i + 1;
          if (lc >= size) break;
          const rc = lc + 1;
          const c = rc < size && hK[rc] < hK[lc] ? rc : lc;
          if (hK[c] >= lastK) break;
          hN[i] = hN[c]; hK[i] = hK[c];
          i = c;
        }
        hN[i] = lastN; hK[i] = lastK;
      }
      if (done[u]) continue;
      done[u] = 1;
      order[nOrder++] = u;
      if (u >= N && u !== src) continue; // zones are sinks: no routing through a zone
      for (let e = first[u], end = first[u + 1]; e < end; e++) {
        const l = out[e];
        const c = cost[l];
        if (!(c < Infinity)) continue;
        const v = to[l];
        const nd = d + c;
        if (nd < dist[v]) {
          dist[v] = nd;
          pred[v] = l;
          // push
          let i = size++;
          while (i > 0) {
            const p = (i - 1) >> 1;
            if (hK[p] <= nd) break;
            hN[i] = hN[p]; hK[i] = hK[p];
            i = p;
          }
          hN[i] = v; hK[i] = nd;
        }
      }
    }
    this.nOrder = nOrder;
  }

  /**
   * Push the demand accumulated at nodes (acc[node * P + p]) up the current tree
   * into link loads (loads[p][link]). acc is cleared as it goes.
   */
  load(acc, P, loads, scale = 1) {
    const { from } = this.net;
    const order = this.order, pred = this.pred;
    for (let i = this.nOrder - 1; i > 0; i--) {
      const v = order[i];
      const l = pred[v];
      if (l < 0) continue;
      const u = from[l];
      const bv = v * P, bu = u * P;
      for (let p = 0; p < P; p++) {
        const f = acc[bv + p];
        if (f !== 0) {
          loads[p][l] += f * scale;
          acc[bu + p] += f;
          acc[bv + p] = 0;
        }
      }
    }
    // clear the root
    const b0 = this.order[0] * P;
    for (let p = 0; p < P; p++) acc[b0 + p] = 0;
  }
}

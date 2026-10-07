// Monthly traffic model: demand by purpose and half-hour, route choice that
// adapts month to month (method of successive averages), BPR delays and a
// TomTom-style congestion index per district.

import * as P from './params.js';
import { buildNetwork } from './network.js';
import { Router } from './assign.js';
import { Demand } from './demand.js';
import { buildProfiles, NPD, PD, DEFAULT_SCHEDULE } from './profiles.js';
import { computeMods } from './policies.js';

const { SLOTS, REGIMES, regimeOfSlot } = P;
const SLOT_REG = Uint8Array.from({ length: SLOTS }, (_, s) => regimeOfSlot(s));
// purposes whose destination can be priced (paid parking)
const DEST_PRICED = new Uint8Array(NPD);
[PD.HWg, PD.HWb, PD.HO, PD.EW, PD.WE, PD.TT].forEach(p => { DEST_PRICED[p] = 1; });

export class TrafficModel {
  constructor(meta, R) {
    this.meta = meta;
    this.R = R;
    const net = this.net = buildNetwork(meta, R);
    this.router = new Router(net);
    this.K = net.K;
    this.zoneDistrict = new Uint8Array(this.K).fill(255);
    meta.zones.forEach((z, i) => { this.zoneDistrict[i] = z.d; });
    const L = net.links;
    this.costR = Array.from({ length: REGIMES }, () => Float32Array.from(net.t0));
    this.skim = this.computeSkim();
    this.demand = new Demand(meta, this.skim);
    this.demand.distribute();
    this.loads = Array.from({ length: NPD * REGIMES }, () => new Float32Array(L));
    this.aon = Array.from({ length: NPD * REGIMES }, () => new Float32Array(L));
    this.vol = new Float32Array(SLOTS * L);
    this.ratio = new Float32Array(SLOTS * L);
    this.cap = new Float32Array(SLOTS * L);
    this.schedule = DEFAULT_SCHEDULE();
    this.profiles = buildProfiles(this.schedule);
    this.pdScale = new Float32Array(NPD).fill(1);
    this.policies = [];
    this.mods = computeMods(net, [], this.schedule, this.K, this.zoneDistrict);
    this.events = { capCity: 1, segCap: null };
    this.iter = 0;
    this.calMonth = 9; // October
  }

  /** Free-flow zone-to-zone travel times in minutes (K x K). */
  computeSkim() {
    const { K, N } = this.net;
    const sk = new Float32Array(K * K);
    for (let i = 0; i < K; i++) {
      this.router.tree(N + i, this.net.t0);
      for (let j = 0; j < K; j++) {
        const d = this.router.dist[N + j];
        sk[i * K + j] = d < Infinity ? d / 60 : 1e9;
      }
    }
    return sk;
  }

  setSchedule(sched) {
    this.schedule = { ...this.schedule, ...sched, school: [...(sched.school || this.schedule.school)] };
    this.profiles = buildProfiles(this.schedule);
  }

  setPolicies(policies) {
    this.policies = policies;
    this.mods = computeMods(this.net, policies, this.schedule, this.K, this.zoneDistrict);
  }

  /** Season, remote work and event factors that apply instantly (no re-routing needed). */
  monthContext(calMonth, events = {}) {
    this.calMonth = calMonth;
    const s = P.SEASON;
    const school = s.schoolActive(calMonth) ? 1 : 0.04;
    const work = s.workFactor(calMonth);
    const remote = this.schedule.remote || 0;
    for (let p = 0; p < NPD; p++) this.pdScale[p] = 1;
    this.pdScale[PD.HWg] = this.pdScale[PD.WHg] = work * (1 - 0.2 * remote);
    this.pdScale[PD.HWb] = this.pdScale[PD.WHb] = work * (1 - 0.04 * remote);
    this.pdScale[PD.EW] = this.pdScale[PD.WE] = work * (1 - 0.03 * remote);
    for (let d = 0; d < 8; d++) this.pdScale[PD.HS + d] = this.pdScale[PD.SH + d] = school;
    this.pdScale[PD.HU] = this.pdScale[PD.UH] = calMonth >= 5 && calMonth <= 7 ? 0.1 : 1;
    this.pdScale[PD.HO] = this.pdScale[PD.OH] = s.otherFactor(calMonth);
    if (this.schedule.ebus) for (let p = 0; p < NPD; p++) if (p !== PD.TT && p !== PD.COM) this.pdScale[p] *= 0.97;
    const cams = this.schedule.cameras ? 1.04 : 1;
    this.events = { capCity: (events.capCity || 1) * s.winterCap(calMonth) * cams, segCap: events.segCap || null };
  }

  /** One all-or-nothing assignment with the current regime costs into this.aon. */
  allOrNothing() {
    const net = this.net, K = this.K, N = net.N;
    const od = this.demand.od;
    const prof = this.profiles;
    for (const a of this.aon) a.fill(0);
    // regime weight of every purpose
    const w = new Float32Array(NPD * REGIMES);
    for (let p = 0; p < NPD; p++) for (let s = 0; s < SLOTS; s++) w[p * REGIMES + SLOT_REG[s]] += prof[p * SLOTS + s];
    const { originScale, destScale } = this.mods;
    for (let r = 0; r < REGIMES; r++) {
      const active = [];
      for (let p = 0; p < NPD; p++) if (w[p * REGIMES + r] > 0.002 && this.demand.totals[p] > 0) active.push(p);
      if (!active.length) continue;
      const Pn = active.length;
      const acc = this.acc && this.acc.length >= net.nodes * Pn ? this.acc : (this.acc = new Float64Array(net.nodes * NPD));
      const loads = active.map(p => this.aon[p * REGIMES + r]);
      const cost = this.regimeCost(r);
      for (let o = 0; o < K; o++) {
        // skip origins without demand in this regime
        let any = false;
        for (const p of active) {
          const row = od[p];
          for (let k = 0, b = o * K; k < K; k++) if (row[b + k] > 0) { any = true; break; }
          if (any) break;
        }
        if (!any) continue;
        this.router.tree(N + o, cost);
        const dist = this.router.dist;
        for (let ip = 0; ip < Pn; ip++) {
          const p = active[ip];
          const row = od[p], b = o * K;
          const priced = DEST_PRICED[p];
          for (let k = 0; k < K; k++) {
            let v = row[b + k];
            if (!v) continue;
            if (!(dist[N + k] < Infinity)) continue;
            if (priced) v *= destScale[k];
            acc[(N + k) * Pn + ip] += v;
          }
        }
        this.router.load(acc, Pn, loads, originScale[o]);
      }
    }
  }

  /** Link costs for route choice in regime r (closed links are impassable). */
  regimeCost(r) {
    const c = this.costR[r];
    const closed = this.mods.closed;
    if (!this._cost) this._cost = new Float32Array(this.net.links);
    const out = this._cost;
    for (let l = 0; l < out.length; l++) out[l] = closed[l] ? Infinity : c[l];
    return out;
  }

  /** Blend the latest all-or-nothing loads into the running loads. */
  blend(lambda) {
    for (let i = 0; i < this.loads.length; i++) {
      const a = this.loads[i], b = this.aon[i];
      for (let l = 0; l < a.length; l++) a[l] += lambda * (b[l] - a[l]);
    }
  }

  /** Half-hour volumes of a set of loads (index p * REGIMES + r) into out (SLOTS * L). */
  slotVolumes(loads, out) {
    const L = this.net.links, RL = this.net.roadLinks;
    const prof = this.profiles;
    out.fill(0);
    for (let s = 0; s < SLOTS; s++) {
      const r = SLOT_REG[s];
      const vs = out.subarray(s * L, (s + 1) * L);
      for (let p = 0; p < NPD; p++) {
        const f = prof[p * SLOTS + s] * this.pdScale[p];
        if (f < 1e-5) continue;
        const ld = loads[p * REGIMES + r];
        for (let l = 0; l < RL; l++) vs[l] += f * ld[l];
      }
    }
  }

  /** Capacities (veh/h) per slot under the current measures and events. */
  computeCaps() {
    const net = this.net, L = net.links, RL = net.roadLinks;
    const { lanes, capMul } = this.mods;
    const capCity = this.events.capCity, segCap = this.events.segCap;
    for (let l = 0; l < RL; l++) {
      let cl = net.cap[l] * capMul[l] * capCity;
      if (segCap && segCap[net.seg[l]]) cl *= segCap[net.seg[l]];
      for (let s = 0; s < SLOTS; s++) this.cap[s * L + l] = cl * lanes[l * 3 + SLOT_REG[s]];
    }
  }

  /**
   * Frank-Wolfe line search: the share of drivers that switch to this month's
   * best routes minimises total travel time (never makes the city worse).
   */
  lineSearch(maxStep) {
    const net = this.net, L = net.links, RL = net.roadLinks;
    this.computeCaps();
    if (!this.volA) this.volA = new Float32Array(SLOTS * L);
    this.slotVolumes(this.loads, this.vol);
    this.slotVolumes(this.aon, this.volA);
    const V = this.vol, A = this.volA, cap = this.cap;
    const { t0Mul } = this.mods;
    const alpha = P.TUNE.alpha, maxR = P.ROUTE_MAX_RATIO;
    const g = lam => {
      let sum = 0;
      for (let l = 0; l < RL; l++) {
        const tff = net.t0[l] * t0Mul[l];
        for (let s = 0; s < SLOTS; s++) {
          const i = s * L + l;
          const d = A[i] - V[i];
          if (d === 0) continue;
          const x = (2 * (V[i] + lam * d)) / cap[i];
          let q = 1 + alpha * x * x * x * x;
          if (q > maxR) q = maxR;
          sum += tff * q * d;
        }
      }
      return sum;
    };
    if (g(0) >= 0) return 0;
    if (g(maxStep) <= 0) return maxStep;
    let lo = 0, hi = maxStep;
    for (let k = 0; k < 14; k++) {
      const mid = (lo + hi) / 2;
      if (g(mid) < 0) lo = mid; else hi = mid;
    }
    return (lo + hi) / 2;
  }

  /** Slot volumes, capacities, delays, regime costs and all metrics. */
  evaluate(volumesReady = false) {
    const net = this.net, L = net.links, RL = net.roadLinks;
    const prof = this.profiles;
    const vol = this.vol, ratio = this.ratio;
    if (!volumesReady) { this.slotVolumes(this.loads, vol); this.computeCaps(); }
    const { t0Mul, closed } = this.mods;
    const nd = 8;
    const VT = new Float64Array(nd), VT0 = new Float64Array(nd), VKM = new Float64Array(nd);
    const slotVT = new Float64Array(SLOTS), slotVT0 = new Float64Array(SLOTS);
    const dSlotVT = new Float64Array(nd * SLOTS), dSlotVT0 = new Float64Array(nd * SLOTS);
    const linkVT = new Float32Array(RL), linkVT0 = new Float32Array(RL);
    let lost = 0, vkm = 0;
    const costSum = Array.from({ length: REGIMES }, () => new Float64Array(L));
    const volSum = Array.from({ length: REGIMES }, () => new Float64Array(L));
    const alpha = P.TUNE.alpha, beta = P.BPR_BETA, maxR = P.ROUTE_MAX_RATIO, showR = P.MAX_RATIO;
    for (let l = 0; l < RL; l++) {
      const d = net.district[l];
      const t0 = net.t0[l];
      const tff = t0 * t0Mul[l];
      for (let s = 0; s < SLOTS; s++) {
        const r = SLOT_REG[s];
        const i = s * L + l;
        const v = vol[i];
        const cap = this.cap[i];
        let q;
        if (closed[l]) q = 1;
        else {
          const x = (2 * v) / cap;
          q = 1 + alpha * x * x * x * x;
          if (beta !== 4) q = 1 + alpha * Math.pow(x, beta);
          if (q > maxR) q = maxR;
        }
        const t = tff * q;                       // what drivers experience (route choice)
        const tm = tff * Math.min(q, showR);     // what the index counts (capped)
        ratio[i] = tm / t0;
        if (v > 0) {
          const vt = v * tm, vt0 = v * t0;
          linkVT[l] += vt; linkVT0[l] += vt0;
          slotVT[s] += vt; slotVT0[s] += vt0;
          if (d < nd) {
            VT[d] += vt; VT0[d] += vt0; VKM[d] += v * net.len[l] / 1000;
            dSlotVT[d * SLOTS + s] += vt; dSlotVT0[d * SLOTS + s] += vt0;
          }
          lost += v * (tm - t0);
          vkm += v * net.len[l] / 1000;
        }
        costSum[r][l] += (v + 0.5) * t;
        volSum[r][l] += v + 0.5;
      }
    }
    for (let r = 0; r < REGIMES; r++) {
      const c = this.costR[r], cs = costSum[r], vs = volSum[r];
      for (let l = 0; l < RL; l++) c[l] = cs[l] / vs[l];
      for (let l = RL; l < L; l++) c[l] = net.t0[l];
    }
    let tVT = 0, tVT0 = 0;
    const ci = new Float32Array(nd);
    for (let d = 0; d < nd; d++) {
      ci[d] = VT0[d] > 0 ? VT[d] / VT0[d] - 1 : 0;
      tVT += VT[d]; tVT0 += VT0[d];
    }
    const slotCI = new Float32Array(SLOTS);
    const dSlotCI = new Float32Array(nd * SLOTS);
    for (let s = 0; s < SLOTS; s++) {
      slotCI[s] = slotVT0[s] > 0 ? slotVT[s] / slotVT0[s] - 1 : 0;
      for (let d = 0; d < nd; d++) {
        const k = d * SLOTS + s;
        dSlotCI[k] = dSlotVT0[k] > 0 ? dSlotVT[k] / dSlotVT0[k] - 1 : 0;
      }
    }
    const slotVol = new Float32Array(SLOTS);
    for (let s = 0; s < SLOTS; s++) {
      let t = 0;
      for (let p = 0; p < NPD; p++) t += prof[p * SLOTS + s] * this.pdScale[p] * this.demand.totals[p];
      slotVol[s] = t;
    }
    return {
      ci: tVT0 > 0 ? tVT / tVT0 - 1 : 0, ciD: ci, VT, VT0, VTsum: tVT, VT0sum: tVT0,
      slotCI, dSlotCI, slotVol, lostHours: lost / 3600, vkm, vkmD: VKM, linkVT, linkVT0,
    };
  }

  /**
   * Demand changed (city growth, mode shift, paid entry): scale each purpose's
   * current loads to the new trip totals, keeping route shares, so the line
   * search compares like with like.
   */
  rescaleLoads() {
    const net = this.net, L = net.links, RL = net.roadLinks, N = net.N;
    for (let i = 0; i < this.loads.length; i++) {
      const a = this.loads[i], b = this.aon[i];
      let ta = 0, tb = 0;
      for (let l = RL; l < L; l++) if (net.from[l] >= N) { ta += a[l]; tb += b[l]; }
      if (tb <= 0) { if (ta > 0) a.fill(0); continue; }
      if (ta <= 0) { a.set(b); continue; }
      const k = tb / ta;
      if (Math.abs(k - 1) > 1e-5) for (let l = 0; l < L; l++) a[l] *= k;
    }
  }

  /** Blend loads and their slot volumes by the line-search step. */
  advance(maxStep) {
    if (this.iter > 0) this.rescaleLoads();
    const lam = this.iter === 0 ? 1 : this.lineSearch(maxStep);
    if (this.iter === 0) this.computeCaps();
    this.blend(lam);
    if (this.iter === 0) this.slotVolumes(this.loads, this.vol);
    else {
      const V = this.vol, A = this.volA;
      for (let i = 0; i < V.length; i++) V[i] += lam * (A[i] - V[i]);
    }
    this.lastStep = lam;
    this.iter++;
  }

  /** Initial equilibrium (Frank-Wolfe with exact line search). */
  warmup(iters = P.WARMUP_ITERS, onProgress, keepContext = false) {
    if (!keepContext) this.monthContext(this.calMonth);
    let m = null;
    for (let k = 0; k < iters; k++) {
      this.allOrNothing();
      this.advance(1);
      m = this.evaluate(true);
      if (onProgress) onProgress((k + 1) / iters, m);
    }
    return m;
  }

  /** One simulated month: part of the drivers switch to better routes (at most MSA_STEP). */
  step(calMonth, events) {
    this.monthContext(calMonth, events);
    this.allOrNothing();
    this.advance(P.MSA_STEP);
    return this.evaluate(true);
  }

  /** Grow the city by a year and redistribute trips. */
  grow(yearIndex, mul = 1) {
    this.demand.grow(yearIndex, mul);
    this.demand.distribute();
  }

  /** Quantized per-slot ratio (x20) and volume for road links, for the renderer. */
  snapshot() {
    const L = this.net.links, RL = this.net.roadLinks;
    const q = new Uint8Array(SLOTS * RL);
    const v = new Uint16Array(SLOTS * RL);
    for (let s = 0; s < SLOTS; s++) {
      for (let l = 0; l < RL; l++) {
        const i = s * L + l;
        q[s * RL + l] = Math.min(255, Math.round(this.ratio[i] * 20));
        v[s * RL + l] = Math.min(65535, Math.round(this.vol[i]));
      }
    }
    return { ratio: q, vol: v };
  }

  /** AM-peak volume of each direction of a segment (to orient reversible lanes). */
  amVolumes(seg) {
    const L = this.net.links;
    const f = this.net.segLinks[2 * seg], b = this.net.segLinks[2 * seg + 1];
    let vf = 0, vb = 0;
    for (let s = 12; s < 21; s++) {
      if (f >= 0) vf += this.vol[s * L + f];
      if (b >= 0) vb += this.vol[s * L + b];
    }
    return [vf, vb];
  }
}

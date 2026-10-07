// Trip generation and gravity distribution between traffic zones.
// Zones: Z internal (1.5 km cells with population/jobs/schools from OSM),
// then G external gates (highways entering the city).

import { DEMAND, GRAVITY_BETA, INTRAZONAL_MIN, GROWTH, TUNE } from './params.js';
import { PD, NPD } from './profiles.js';

export class Demand {
  constructor(meta, skim) {
    this.meta = meta;
    this.Z = meta.zones.length;
    this.G = meta.roads.gates.length;
    this.K = this.Z + this.G;
    this.skim = skim; // Float32Array K*K free-flow minutes
    this.zoneDistrict = new Uint8Array(this.K).fill(255);
    meta.zones.forEach((z, i) => { this.zoneDistrict[i] = z.d; });
    // mutable zone attributes (grow over time)
    const Z = this.Z;
    this.pop = new Float64Array(Z);
    this.jobs = new Float64Array(Z);
    this.gov = new Float64Array(Z);
    this.school = new Float64Array(Z);
    this.uni = new Float64Array(Z);
    this.retail = new Float64Array(Z);
    meta.zones.forEach((z, i) => {
      this.pop[i] = z.pop; this.jobs[i] = z.jobs; this.gov[i] = Math.min(z.gov, z.jobs * 0.8);
      this.school[i] = z.school; this.uni[i] = z.uni; this.retail[i] = z.retail;
    });
    // flatten: a wide ring road at the edge is not where most commuters come from
    this.gateW = meta.roads.gates.map(g => Math.sqrt(Math.max(1, g.w)));
    this.od = Array.from({ length: NPD }, () => new Float32Array(this.K * this.K));
    this.totals = new Float64Array(NPD);
    this.intrazonal = 0;
    this.year = 0;
    this.extGrowth = 1;
    this.motor = 1;
  }

  basePop() { let t = 0; for (const v of this.pop) t += v; return t; }

  /** Advance zone attributes by one year of growth (yearIndex from 0). */
  grow(yearIndex, mul = 1) {
    const g = GROWTH;
    const f = Math.min(1, yearIndex / g.popYears);
    const rate = (g.popStart + (g.popEnd - g.popStart) * f) * mul;
    const fm = Math.min(1, yearIndex / g.motorYears);
    const mrate = (g.motorStart + (g.motorEnd - g.motorStart) * fm) * mul;
    const dk = this.meta.districts.map(d => g.district[d.key] ?? 1);
    // normalise district multipliers so the city grows by `rate`
    let num = 0, den = 0;
    for (let i = 0; i < this.Z; i++) { num += this.pop[i] * dk[this.zoneDistrict[i]]; den += this.pop[i]; }
    const norm = den / num;
    let addPop = 0;
    for (let i = 0; i < this.Z; i++) {
      const r = rate * dk[this.zoneDistrict[i]] * norm;
      const dp = this.pop[i] * r;
      this.pop[i] += dp;
      addPop += dp;
      this.school[i] *= 1 + r;
    }
    // jobs grow with the city, slightly concentrated where jobs already are
    let jt = 0;
    for (let i = 0; i < this.Z; i++) jt += this.jobs[i];
    for (let i = 0; i < this.Z; i++) {
      const dj = (addPop * 0.5) * (this.jobs[i] / jt);
      this.gov[i] *= 1 + 0.4 * dj / Math.max(1, this.jobs[i]);
      this.jobs[i] += dj;
    }
    this.extGrowth *= 1 + rate * 1.3;
    this.motor *= 1 + mrate;
    this.year = yearIndex + 1;
  }

  /** Recompute all OD matrices for the current zone attributes. */
  distribute() {
    const { Z, G, K, skim } = this;
    const D = DEMAND;
    const imp = beta => {
      const F = new Float32Array(K * K);
      for (let i = 0; i < K; i++) for (let j = 0; j < K; j++) {
        const t = i === j ? INTRAZONAL_MIN : skim[i * K + j];
        F[i * K + j] = t < 1e6 ? Math.exp(-beta * t) : 0;
      }
      return F;
    };
    const Fw = imp(GRAVITY_BETA.work), Fs = imp(GRAVITY_BETA.school), Fu = imp(GRAVITY_BETA.uni);
    const Fo = imp(GRAVITY_BETA.other), Fe = imp(GRAVITY_BETA.ext), Fc = imp(GRAVITY_BETA.com);
    for (const m of this.od) m.fill(0);
    let intra = 0;
    const motor = this.motor * TUNE.demand;
    // production-constrained distribution of P (len Z or K) to attractions A over destinations
    const prodConstrained = (out, P, A, F, origins, dests) => {
      for (const i of origins) {
        if (!(P[i] > 0)) continue;
        let s = 0;
        for (const j of dests) s += A[j] * F[i * K + j];
        if (s <= 0) continue;
        const k = P[i] / s;
        for (const j of dests) {
          const v = A[j] * F[i * K + j] * k;
          if (i === j) { intra += v; continue; }
          out[i * K + j] += v;
        }
      }
    };
    const zonesIdx = Array.from({ length: Z }, (_, i) => i);
    const gatesIdx = Array.from({ length: G }, (_, i) => Z + i);
    const popT = this.pop.reduce((a, b) => a + b, 0);
    // --- work (doubly constrained by Furness), gov and business separately
    const furness = (out, P, A, F) => {
      const T = new Float64Array(K * K);
      for (const i of zonesIdx) for (const j of zonesIdx) T[i * K + j] = P[i] * A[j] * F[i * K + j];
      for (let it = 0; it < 8; it++) {
        for (const i of zonesIdx) { // rows
          let s = 0; for (const j of zonesIdx) s += T[i * K + j];
          if (s > 0) { const k = P[i] / s; for (const j of zonesIdx) T[i * K + j] *= k; }
        }
        for (const j of zonesIdx) { // columns
          let s = 0; for (const i of zonesIdx) s += T[i * K + j];
          if (s > 0) { const k = A[j] / s; for (const i of zonesIdx) T[i * K + j] *= k; }
        }
      }
      for (const i of zonesIdx) for (const j of zonesIdx) {
        if (i === j) intra += T[i * K + j]; else out[i * K + j] += T[i * K + j];
      }
    };
    const jobsT = this.jobs.reduce((a, b) => a + b, 0);
    const govT = this.gov.reduce((a, b) => a + b, 0);
    const extShare = Math.min(0.35, D.externalCommuters * this.extGrowth / (jobsT * D.workCarTripsPerJob));
    const ext = this.extGrowth * TUNE.demand;
    const tripsGov = govT * D.workCarTripsPerJob * motor * (1 - extShare);
    const tripsBiz = (jobsT - govT) * D.workCarTripsPerJob * motor * (1 - extShare);
    const Pg = new Float64Array(K), Pb = new Float64Array(K), Ag = new Float64Array(K), Ab = new Float64Array(K);
    for (const i of zonesIdx) {
      Pg[i] = tripsGov * this.pop[i] / popT;
      Pb[i] = tripsBiz * this.pop[i] / popT;
      Ag[i] = tripsGov * this.gov[i] / govT;
      Ab[i] = tripsBiz * (this.jobs[i] - this.gov[i]) / (jobsT - govT);
    }
    furness(this.od[PD.HWg], Pg, Ag, Fw);
    furness(this.od[PD.HWb], Pb, Ab, Fw);
    // --- schools: production constrained, split by the school's district
    {
      const tmp = new Float32Array(K * K);
      const P = new Float64Array(K), A = new Float64Array(K);
      const pupils = this.school.reduce((a, b) => a + b, 0);
      // every driven pupil = one drop-off, part of them also one pick-up
      const driven = pupils * D.pupilsDriven * (1 + D.pickupShare) * motor;
      for (const i of zonesIdx) { P[i] = driven * this.pop[i] / popT; A[i] = this.school[i]; }
      prodConstrained(tmp, P, A, Fs, zonesIdx, zonesIdx);
      for (const i of zonesIdx) for (const j of zonesIdx) {
        const v = tmp[i * K + j];
        if (!v) continue;
        const d = this.zoneDistrict[j];
        this.od[PD.HS + d][i * K + j] += v;
      }
    }
    // --- universities
    {
      const P = new Float64Array(K), A = new Float64Array(K);
      const st = this.meta.zones.reduce((a, z) => a + z.uni, 0) * D.uniCarShare * motor;
      for (const i of zonesIdx) { P[i] = st * this.pop[i] / popT; A[i] = this.uni[i]; }
      prodConstrained(this.od[PD.HU], P, A, Fu, zonesIdx, zonesIdx);
    }
    // --- errands / shopping
    {
      const P = new Float64Array(K), A = new Float64Array(K);
      for (const i of zonesIdx) {
        P[i] = this.pop[i] * D.otherPerResident * motor;
        A[i] = this.retail[i] + 0.4 * this.jobs[i] / 1000 + 0.15 * this.pop[i] / 1000;
      }
      prodConstrained(this.od[PD.HO], P, A, Fo, zonesIdx, zonesIdx);
    }
    // --- external commuters (gates -> jobs)
    {
      const P = new Float64Array(K), A = new Float64Array(K);
      const gw = this.gateW.reduce((a, b) => a + b, 0);
      for (const g of gatesIdx) P[g] = D.externalCommuters * ext * this.gateW[g - Z] / gw;
      for (const j of zonesIdx) A[j] = this.jobs[j];
      prodConstrained(this.od[PD.EW], P, A, Fe, gatesIdx, zonesIdx);
    }
    // --- through traffic between gates that are far apart
    {
      const m = this.od[PD.TT];
      let s = 0;
      const pairs = [];
      for (const g of gatesIdx) for (const h of gatesIdx) {
        if (g === h) continue;
        const ga = this.meta.roads.gates[g - Z], hb = this.meta.roads.gates[h - Z];
        if (Math.hypot(ga.x - hb.x, ga.z - hb.z) < 9000) continue;
        if (/БАКАД/i.test(ga.name) && /БАКАД/i.test(hb.name)) continue; // they bypass the city on the ring
        const w = this.gateW[g - Z] * this.gateW[h - Z];
        pairs.push([g, h, w]); s += w;
      }
      for (const [g, h, w] of pairs) m[g * K + h] = D.throughTrips * ext * w / s;
    }
    // --- taxis, deliveries, service vans
    {
      const P = new Float64Array(K), A = new Float64Array(K);
      for (const i of zonesIdx) {
        P[i] = (this.pop[i] + this.jobs[i]) * D.commercialPerCapita * motor;
        A[i] = this.pop[i] + 1.6 * this.jobs[i];
      }
      prodConstrained(this.od[PD.COM], P, A, Fc, zonesIdx, zonesIdx);
    }
    // --- return trips are the transposes
    const transpose = (src, dst) => {
      for (let i = 0; i < K; i++) for (let j = 0; j < K; j++) dst[j * K + i] += src[i * K + j];
    };
    transpose(this.od[PD.HWg], this.od[PD.WHg]);
    transpose(this.od[PD.HWb], this.od[PD.WHb]);
    for (let d = 0; d < 8; d++) transpose(this.od[PD.HS + d], this.od[PD.SH + d]);
    transpose(this.od[PD.HU], this.od[PD.UH]);
    transpose(this.od[PD.HO], this.od[PD.OH]);
    transpose(this.od[PD.EW], this.od[PD.WE]);
    for (let p = 0; p < NPD; p++) {
      let t = 0; const m = this.od[p];
      for (let i = 0; i < m.length; i++) t += m[i];
      this.totals[p] = t;
    }
    this.intrazonal = intra;
  }

  totalTrips() {
    let t = this.intrazonal;
    for (const v of this.totals) t += v;
    return t;
  }

  population() { return this.pop.reduce((a, b) => a + b, 0); }
}

// Departure-time profiles of every trip purpose over 48 half-hour slots.
// A profile row sums to 1: the share of the purpose's daily trips per slot.

import { SLOTS, DEMAND } from './params.js';

// Purpose-direction (PD) layout. School PDs are split by the district of the
// school so every district can run its own bell schedule.
export const PD = {
  HWg: 0, WHg: 1, HWb: 2, WHb: 3,
  HS: 4, SH: 12,                       // + district (0..7)
  HU: 20, UH: 21, HO: 22, OH: 23, EW: 24, WE: 25, TT: 26, COM: 27,
};
export const NPD = 28;
export const PD_LABEL = [
  'Дом → работа (госслужба)', 'Работа → дом (госслужба)', 'Дом → работа', 'Работа → дом',
  ...Array.from({ length: 8 }, (_, d) => `В школу (р-н ${d})`),
  ...Array.from({ length: 8 }, (_, d) => `Из школы (р-н ${d})`),
  'В вуз', 'Из вуза', 'По делам', 'Домой с дел', 'Въезд из области', 'Выезд в область', 'Транзит', 'Такси и доставка',
];
// Coarse groups for the 24 h chart.
export const PD_GROUP = new Uint8Array(NPD);
(() => {
  const g = (p, v) => { PD_GROUP[p] = v; };
  [0, 1, 2, 3, 24, 25].forEach(p => g(p, 0));          // work
  for (let d = 0; d < 8; d++) { g(4 + d, 1); g(12 + d, 1); } // school
  [20, 21].forEach(p => g(p, 2));                       // university
  [22, 23].forEach(p => g(p, 3));                       // errands
  [26, 27].forEach(p => g(p, 4));                       // transit & commercial
})();
export const GROUP_LABEL = ['Работа', 'Школы', 'Вузы', 'Дела', 'Транзит и такси'];

const SQ2 = Math.SQRT2;
function erf(x) {
  // Abramowitz–Stegun 7.1.26
  const s = x < 0 ? -1 : 1;
  x = Math.abs(x);
  const t = 1 / (1 + 0.3275911 * x);
  const y = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-x * x);
  return s * y;
}
const cdf = (x, c, s) => 0.5 * (1 + erf((x - c) / (s * SQ2)));

function addGauss(row, c, sigma, w) {
  for (let s = 0; s < SLOTS; s++) {
    const a = s * 0.5, b = a + 0.5;
    let v = 0;
    for (const k of [-24, 0, 24]) v += cdf(b + k, c, sigma) - cdf(a + k, c, sigma);
    row[s] += w * v;
  }
}
function addUniform(row, h0, h1, w) {
  // h0..h1 may wrap past midnight
  const span = ((h1 - h0) % 24 + 24) % 24 || 24;
  for (let s = 0; s < SLOTS; s++) {
    const mid = s * 0.5 + 0.25;
    const rel = ((mid - h0) % 24 + 24) % 24;
    if (rel < span) row[s] += w * 0.5 / span;
  }
}
function normalize(row) {
  let t = 0;
  for (let s = 0; s < SLOTS; s++) t += row[s];
  if (t > 0) for (let s = 0; s < SLOTS; s++) row[s] /= t;
}

/**
 * schedule: { school: number[8] (start hour), gov, biz, uni, flex (0..0.6), nightFreight (0..1) }
 * returns Float32Array(NPD * SLOTS)
 */
export function buildProfiles(sch) {
  const P = new Float32Array(NPD * SLOTS);
  const row = p => P.subarray(p * SLOTS, (p + 1) * SLOTS);
  const flex = sch.flex || 0;
  const work = (r, center, sigma) => {
    addGauss(r, center, sigma, 1 - flex);
    addGauss(r, center - 1, sigma, flex / 2);
    addGauss(r, center + 1, sigma, flex / 2);
  };
  // government offices
  addGauss(row(PD.HWg), sch.gov - 0.6, 0.5, 0.85); addGauss(row(PD.HWg), sch.gov + 1.5, 2.0, 0.15);
  addGauss(row(PD.WHg), sch.gov + 9.1, 0.7, 0.85); addGauss(row(PD.WHg), sch.gov + 11, 2.0, 0.15);
  // business: core + a tail of shift / retail workers
  { const r = row(PD.HWb); work(r, sch.biz - 0.65, 0.62); addGauss(r, sch.biz + 1.8, 2.2, 0.3); }
  { const r = row(PD.WHb); work(r, sch.biz + 9.2, 0.85); addGauss(r, sch.biz + 11.5, 2.2, 0.3); }
  // schools: first shift drop-off/pick-up, second shift drop-off/pick-up
  const sh2 = DEMAND.secondShift, pick = DEMAND.pickupShare;
  for (let d = 0; d < 8; d++) {
    const st = sch.school[d];
    for (const [p, off] of [[PD.HS + d, 0], [PD.SH + d, 0.22]]) {
      const r = row(p);
      addGauss(r, st - 0.3 + off, 0.25, 1 - sh2);
      addGauss(r, st + 5.3 + off, 0.6, (1 - sh2) * pick);
      addGauss(r, st + 5.6 + off, 0.3, sh2);
      addGauss(r, st + 10.7 + off, 0.5, sh2 * pick);
    }
  }
  { const r = row(PD.HU); addGauss(r, sch.uni - 0.6, 0.38, 0.72); addGauss(r, sch.uni + 3, 1.4, 0.28); }
  { const r = row(PD.UH); addGauss(r, sch.uni + 6.4, 1.4, 1); }
  { const r = row(PD.HO); addGauss(r, 8.2, 0.9, 0.08); addGauss(r, 11.8, 1.6, 0.42); addGauss(r, 17.7, 1.3, 0.5); }
  { const r = row(PD.OH); addGauss(r, 13.9, 1.8, 0.4); addGauss(r, 19.7, 1.5, 0.6); }
  // commuters from the agglomeration leave early and spread out (long trips, shifts, markets)
  { const r = row(PD.EW); work(r, sch.biz - 1.3, 1.0); addGauss(r, sch.biz + 2, 2.8, 0.35); }
  { const r = row(PD.WE); work(r, sch.biz + 8.9, 1.1); addGauss(r, sch.biz + 12, 2.8, 0.35); }
  { const r = row(PD.TT); addUniform(r, 6, 22, 0.85); addUniform(r, 22, 6, 0.15); }
  {
    const r = row(PD.COM), nf = sch.nightFreight || 0;
    // 55 % taxis/services follow the commute; 45 % freight, part of it can be moved to the night
    addGauss(r, 8.6, 1.2, 0.55 * 0.3); addGauss(r, 13, 2.6, 0.55 * 0.3); addGauss(r, 18.6, 1.6, 0.55 * 0.4);
    addGauss(r, 11, 2.4, 0.45 * (1 - nf) * 0.6); addGauss(r, 15.5, 2.2, 0.45 * (1 - nf) * 0.4);
    addUniform(r, 22, 6, 0.45 * nf);
  }
  for (let p = 0; p < NPD; p++) {
    const r = row(p);
    normalize(r);
    // a trip occupies the network for a while: spread each departure over 1.5 h
    const c = new Float32Array(SLOTS);
    for (let s = 0; s < SLOTS; s++) {
      c[s] += 0.5 * r[s];
      c[(s + 1) % SLOTS] += 0.35 * r[s];
      c[(s + 2) % SLOTS] += 0.15 * r[s];
    }
    r.set(c);
  }
  return P;
}

export const DEFAULT_SCHEDULE = () => ({
  school: [8, 8, 8, 8, 8, 8, 8, 8], gov: 9, biz: 9, uni: 8.5, flex: 0, nightFreight: 0,
});

export function fmtHour(h) {
  const m = Math.round(h * 60);
  return `${String(Math.floor(m / 60) % 24).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
}

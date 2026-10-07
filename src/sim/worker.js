// Traffic worker: owns the TrafficModel, answers one message per simulated month.

import { fetchMeta, loadRoads } from '../data/loader.js';
import { TrafficModel } from './traffic.js';

let model = null;
let base = null; // { meta, R } kept to rebuild the model when a save is loaded

function packMetrics(m) {
  return {
    ci: m.ci, ciD: Array.from(m.ciD), VT: Array.from(m.VT), VT0: Array.from(m.VT0),
    VTsum: m.VTsum, VT0sum: m.VT0sum,
    slotCI: m.slotCI, dSlotCI: m.dSlotCI, slotVol: m.slotVol,
    lostHours: m.lostHours, vkm: m.vkm, vkmD: Array.from(m.vkmD),
    linkDaily: dailyRatio(m), linkVT0: m.linkVT0,
  };
}
function dailyRatio(m) {
  const n = m.linkVT.length;
  const out = new Float32Array(n);
  for (let l = 0; l < n; l++) out[l] = m.linkVT0[l] > 0 ? m.linkVT[l] / m.linkVT0[l] : 1;
  return out;
}

function transferables(res) {
  const t = [res.snap.ratio.buffer, res.snap.vol.buffer, res.metrics.linkDaily.buffer, res.metrics.linkVT0.buffer];
  return t;
}

function info() {
  const d = model.demand;
  return {
    population: d.population(),
    trips: d.totalTrips(),
    totals: Array.from(d.totals),
    links: model.net.links,
    roadLinks: model.net.roadLinks,
    schedule: model.schedule,
  };
}

self.onmessage = async (e) => {
  const msg = e.data;
  try {
    if (msg.type === 'init') {
      const t0 = performance.now();
      const meta = await fetchMeta();
      const R = await loadRoads(meta);
      base = { meta, R };
      model = new TrafficModel(meta, R);
      if (msg.calMonth != null) model.calMonth = msg.calMonth;
      self.postMessage({ type: 'progress', f: 0.05, stage: 'network' });
      const iters = msg.iters ?? undefined;
      const m = model.warmup(iters, (f) => self.postMessage({ type: 'progress', f: 0.05 + 0.95 * f, stage: 'warmup' }));
      const res = { type: 'ready', metrics: packMetrics(m), snap: model.snapshot(), info: info(), ms: performance.now() - t0 };
      self.postMessage(res, transferables(res));
    } else if (msg.type === 'step') {
      const t0 = performance.now();
      if (msg.schedule) model.setSchedule(msg.schedule);
      if (msg.policies) model.setPolicies(msg.policies);
      if (msg.grow != null) model.grow(msg.grow, msg.growthMul ?? 1);
      const m = model.step(msg.calMonth, msg.events || {});
      const res = { type: 'month', id: msg.id, metrics: packMetrics(m), snap: model.snapshot(), info: info(), ms: performance.now() - t0 };
      self.postMessage(res, transferables(res));
    } else if (msg.type === 'restore') {
      // rebuild the city as it was in the save: growth, timetable, measures, then fresh route choice
      const t0 = performance.now();
      model = new TrafficModel(base.meta, base.R);
      model.calMonth = msg.calMonth;
      for (let y = 0; y < msg.years; y++) model.demand.grow(y, msg.growthMul ?? 1);
      if (msg.years) model.demand.distribute();
      model.setSchedule(msg.schedule);
      model.setPolicies(msg.policies);
      model.monthContext(msg.calMonth, msg.events || {});
      const m = model.warmup(msg.iters ?? 10, (f) => self.postMessage({ type: 'progress', f, stage: 'restore' }), true);
      const res = { type: 'restored', id: msg.id, metrics: packMetrics(m), snap: model.snapshot(), info: info(), ms: performance.now() - t0 };
      self.postMessage(res, transferables(res));
    } else if (msg.type === 'amVolumes') {
      const out = msg.segs.map(s => model.amVolumes(s));
      self.postMessage({ type: 'amVolumes', id: msg.id, out });
    } else if (msg.type === 'save') {
      self.postMessage({ type: 'saved', id: msg.id, loads: model.loads.map(a => a.slice()) });
    }
  } catch (err) {
    self.postMessage({ type: 'error', message: String(err && err.stack || err) });
  }
};

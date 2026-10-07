// HUD, panels, tools, map interaction and the month loop.

import * as THREE from 'three';
import { STREET_TOOLS, NODE_TOOLS, SCHEDULE_TOOLS, PARK_TOOL, AIR_TOOLS, GATE_TOOLS } from '../sim/policies.js';
import { fmtHour } from '../sim/profiles.js';
import { MISSIONS } from '../sim/missions.js';
import { TERM_MONTHS, DIFFICULTY, SAVE_KEY } from '../sim/game.js';
import { distGen } from '../sim/names.js';
import { pct, num, km, money, ciColor, moodColor, el, esc, ICONS } from './fmt.js';
import { drawDay, drawLines, drawHistory } from './charts.js';
import { Labels } from './labels.js';

const $ = id => document.getElementById(id);
// one simulated month = one animated day; seconds of real time per month by speed
const SEC_PER_MONTH = [0, 32, 14, 6];
const CLS_RU = ['магистраль', 'скоростная', 'главная улица', 'улица районного значения', 'местная улица'];
const COMPASS = ['север', 'северо-восток', 'восток', 'юго-восток', 'юг', 'юго-запад', 'запад', 'северо-запад'];

export class UI {
  constructor({ data, net, engine, game, traffic }) {
    Object.assign(this, { data, net, engine, game, traffic });
    this.R = data.roads;
    this.meta = data.meta;
    this.names = this.meta.roads.names;
    this.speed = 0;
    this.busy = false;
    this.dayPlay = true;
    this.panel = { type: 'city' };
    this.sel = null;
    this.labels = new Labels($('labels'), engine.camera);
    this.buildAdjacency();
    this.findJunctions();
    this.findGates();
    this.bind();
    this.makeLabels();
    engine.frameHooks.push(dt => this.frame(dt));
  }

  // ------------------------------------------------------------------ setup
  buildAdjacency() {
    const R = this.R, S = this.meta.roads.segCount;
    this.nodeSegs = new Map();
    for (let s = 0; s < S; s++) {
      for (const n of [R.seg_a[s], R.seg_b[s]]) {
        let a = this.nodeSegs.get(n);
        if (!a) this.nodeSegs.set(n, (a = []));
        a.push(s);
      }
    }
  }

  /** Candidate junctions for interchanges: two named major streets meet at grade. */
  findJunctions() {
    const R = this.R, net = this.net;
    const cand = [];
    for (const [n, segs] of this.nodeSegs) {
      if (n >= net.N) continue;
      const names = new Set();
      let minCls = 9, bridge = false;
      for (const s of segs) {
        if (R.seg_flags[s] & 4) bridge = true;
        if (R.seg_flags[s] & 2) continue;
        if (R.seg_cls[s] > 3 || !R.seg_name[s]) continue;
        names.add(R.seg_name[s]);
        minCls = Math.min(minCls, R.seg_cls[s]);
      }
      if (names.size >= 2 && minCls <= 2 && !bridge) cand.push({ n, names: [...names], x: R.nodes[2 * n], z: R.nodes[2 * n + 1] });
    }
    // merge dual-carriageway corners within 70 m
    const out = [];
    for (const c of cand) {
      const o = out.find(j => Math.hypot(j.x - c.x, j.z - c.z) < 70 && c.names.some(nm => j.names.includes(nm)));
      if (o) { o.nodes.push(c.n); for (const nm of c.names) if (!o.names.includes(nm)) o.names.push(nm); }
      else out.push({ ...c, nodes: [c.n] });
    }
    for (const j of out) {
      j.label = j.names.slice(0, 2).map(i => this.names[i - 1]).join(' × ');
      const c = this.engine.hf.height(j.x, j.z);
      j.y = c;
      const dr = this.districtAt(j.x, j.z);
      j.d = dr;
    }
    this.junctions = out;
  }

  /** City entrances (highway gates of the model) with a readable name and the first road links. */
  findGates() {
    const net = this.net, R = this.R;
    const dirs = ['северный', 'северо-восточный', 'восточный', 'юго-восточный', 'южный', 'юго-западный', 'западный', 'северо-западный'];
    this.gates = this.meta.roads.gates.map((g, i) => {
      const ang = (Math.atan2(g.x, -g.z) + 2 * Math.PI) % (2 * Math.PI);
      const dir = dirs[Math.round(ang / (Math.PI / 4)) % 8];
      const links = [];
      for (const n of g.nodes) for (let e = net.first[n]; e < net.first[n + 1]; e++) { const l = net.out[e]; if (l < net.roadLinks) links.push(l); }
      // the road a driver from the region actually takes into town
      const roadName = links.map(l => R.seg_name[net.seg[l]]).find(x => x) || 0;
      const nm = roadName ? this.names[roadName - 1] : '';
      return { i, x: g.x, z: g.z, links, label: `${dir[0].toUpperCase() + dir.slice(1)} въезд${nm ? ` · ${nm}` : ''}`, name: `${dir} въезд${nm ? ` (${nm})` : ''}`, w: g.w };
    });
  }

  gateLoad(g) {
    const m = this.last?.metrics, snap = this.engine.snap;
    if (!m || !snap) return { ci: 0, cars: 0 };
    const RL = this.net.roadLinks;
    let vt = 0, vt0 = 0, cars = 0;
    for (const l of g.links) {
      vt += m.linkDaily[l] * m.linkVT0[l]; vt0 += m.linkVT0[l];
      for (let s = 0; s < 48; s++) cars += snap.vol[s * RL + l];
    }
    return { ci: vt0 ? vt / vt0 - 1 : 0, cars };
  }

  districtAt(x, z) {
    const r = this.meta.districtRaster;
    const i = Math.floor((x - r.x0) / r.cs), j = Math.floor((z - r.z0) / r.cs);
    if (i < 0 || j < 0 || i >= r.w || j >= r.h) return -1;
    return this.data.districts.d[j * r.w + i] - 1;
  }

  bind() {
    $('speed').addEventListener('click', e => {
      const b = e.target.closest('button');
      if (b) this.setSpeed(+b.dataset.speed);
    });
    window.addEventListener('keydown', e => {
      if (e.code === 'Space' && !e.target.closest('input,textarea')) { e.preventDefault(); this.setSpeed(this.speed ? 0 : (this.lastSpeed || 1)); }
      if (e.code === 'Escape') { this.clearSelection(); this.openPanel({ type: 'city' }); }
      if (e.code === 'Digit1') this.setSpeed(1);
      if (e.code === 'Digit2') this.setSpeed(2);
      if (e.code === 'Digit3') this.setSpeed(3);
    });
    $('dock').addEventListener('click', e => {
      const b = e.target.closest('button');
      if (!b) return;
      if (b.dataset.panel) { this.clearSelection(); this.openPanel({ type: b.dataset.panel }); }
      if (b.dataset.layer) {
        const k = b.dataset.layer;
        this.engine.layers[k] = !this.engine.layers[k];
        b.classList.toggle('on', this.engine.layers[k]);
      }
      if (b.dataset.action === 'help') this.showHelp();
      if (b.dataset.action === 'settings') this.showSettings();
    });
    // day line scrub
    const chart = $('dayChart');
    const scrub = e => {
      const r = chart.getBoundingClientRect();
      const h = Math.max(0, Math.min(23.9, ((e.clientX - r.left) / r.width) * 24));
      this.engine.setHour(h);
      this.updateDaylineCursor();
    };
    chart.addEventListener('pointerdown', e => { chart.setPointerCapture(e.pointerId); this.scrubbing = true; scrub(e); });
    chart.addEventListener('pointermove', e => { if (this.scrubbing) scrub(e); });
    chart.addEventListener('pointerup', () => { this.scrubbing = false; });
    $('dayPlay').addEventListener('click', () => this.setSpeed(this.speed ? 0 : (this.lastSpeed || 1)));
    new ResizeObserver(() => this.updateDayline()).observe(chart);
    // map interaction
    const ctl = this.engine.controls;
    let lastHover = 0;
    ctl.onHover = (e) => {
      const now = performance.now();
      if (now - lastHover < 50) return;
      lastHover = now;
      this.hover(e);
    };
    ctl.onClick = e => this.click(e);
    this.engine.renderer.domElement.addEventListener('pointerleave', () => $('hover').classList.add('hidden'));
  }

  makeLabels() {
    const hf = this.engine.hf;
    this.dLabels = this.meta.districts.map(d => {
      const e = el('div', 'dlabel', `<div class="dn">${esc(d.name.replace('ский', 'ский'))}</div><div class="dc num">—</div>`);
      e.addEventListener('click', () => this.openDistrict(d.id, true));
      const item = this.labels.add(e, d.lx, hf.height(d.lx, d.lz) + 60, d.lz, { minDist: 1500, maxDist: 70000, group: 'districts' });
      return { item, badge: e.querySelector('.dc') };
    });
    for (const l of this.meta.landmarks) {
      if (l.k === 'park' && !/парк|сад/i.test(l.name)) continue;
      const e = el('div', 'lmark', esc(l.name));
      const y = hf.height(l.x, l.z) + (l.k === 'tower' ? 380 : 30);
      this.labels.add(e, l.x, y, l.z, { minDist: 300, maxDist: l.k === 'tower' || l.k === 'airport' ? 40000 : 11000, group: 'landmarks' });
    }
  }

  showJunctions(on) {
    this.labels.removeGroup('junctions');
    if (!on) return;
    const built = new Set(this.game.s.policies.filter(p => p.type === 'interchange' && p.status !== 'cancelled').map(p => p.node));
    for (const j of this.junctions) {
      const e = el('div', 'nodeMark' + (built.has(j.nodes[0]) ? ' built' : ''));
      e.title = j.label;
      e.addEventListener('click', ev => { ev.stopPropagation(); this.openJunction(j); });
      this.labels.add(e, j.x, j.y + 8, j.z, { maxDist: 16000, group: 'junctions' });
    }
  }

  // ------------------------------------------------------------------ month loop
  setSpeed(s) {
    if (this.game.s.over && s > 0) return;
    if (s > 0) this.lastSpeed = s;
    this.speed = s;
    for (const b of $('speed').querySelectorAll('button')) b.classList.toggle('on', +b.dataset.speed === s);
    $('dayPlay').classList.toggle('on', s > 0);
    this.onSpeed && this.onSpeed(s);
  }

  /** Midnight: close the month (money, moods, news), then simulate the next one. */
  async endOfDay() {
    if (this.busy || this.game.s.over) return;
    this.busy = true;
    const report = this.game.endMonth(this.last.metrics, { busyStreets: this.streets.slice(0, 15), population: this.last.info.population });
    this.afterMonth(report);
    if (!this.game.s.over) {
      const ctx = this.game.beginMonth();
      const res = await this.traffic.step({
        calMonth: ctx.calMonth, events: ctx.events, schedule: ctx.schedule, policies: ctx.policies, grow: ctx.grow, growthMul: ctx.growthMul,
      });
      this.applyResult(res);
      this.refresh();
    }
    this.busy = false;
    this.save();
  }

  // ------------------------------------------------------------------ save / load
  save() {
    if (!this.started) return;
    try {
      if (this.game.s.over) { localStorage.removeItem(SAVE_KEY); return; }
      const c = this.engine.controls.cur;
      localStorage.setItem(SAVE_KEY, JSON.stringify({
        v: 1, game: this.game.serialize(), cam: { x: c.x, z: c.z, dist: c.dist, yaw: c.yaw, pitch: c.pitch },
        hour: this.engine.hour, label: this.game.dateLabel(), month: this.game.s.month,
        difficulty: this.game.s.difficulty, mission: this.game.s.mission, savedAt: Date.now(),
      }));
    } catch (e) { console.warn('save failed', e); }
  }

  static loadSave() {
    try {
      const t = localStorage.getItem(SAVE_KEY);
      const o = t ? JSON.parse(t) : null;
      return o && o.v === 1 && o.game ? o : null;
    } catch { return null; }
  }

  applyResult(res) {
    this.last = res;
    this.engine.setSnapshot(res.snap);
    this.engine.month = this.game.date().cal;
    this.streets = this.computeStreets(res.metrics);
  }

  afterMonth(report) {
    const air = this.game.air();
    if (air) this.engine.smogScale = Math.max(0.15, air.winterAqi / 183);
    for (const n of report.news) this.pushNews(n);
    if (report.missionComplete) this.showMissionComplete(report.missionComplete);
    if (report.over && report.over.type !== 'victory') this.showGameOver(report.over);
    this.refresh();
  }

  computeStreets(m) {
    const net = this.net, R = this.R;
    const map = new Map();
    for (let l = 0; l < net.roadLinks; l++) {
      const vt0 = m.linkVT0[l];
      if (!vt0) continue;
      const s = net.seg[l];
      const nm = R.seg_name[s];
      const d = net.district[l];
      if (!nm || d >= 8) continue;
      const key = nm * 16 + d;
      let e = map.get(key);
      if (!e) map.set(key, (e = { nameIdx: nm, district: d, vt: 0, vt0: 0, segs: new Set() }));
      e.vt += m.linkDaily[l] * vt0;
      e.vt0 += vt0;
      e.segs.add(s);
    }
    const out = [];
    for (const e of map.values()) {
      out.push({ ...e, segs: [...e.segs], ci: e.vt / e.vt0 - 1, delay: e.vt - e.vt0, name: this.names[e.nameIdx - 1] });
    }
    out.sort((a, b) => b.delay - a.delay);
    return out;
  }

  // ------------------------------------------------------------------ per frame
  frame(dt) {
    const eng = this.engine;
    if (this.speed > 0 && !this.scrubbing && !this.game.s.over && this.last) {
      let h = eng.hour + dt * 24 / SEC_PER_MONTH[this.speed];
      if (h >= 24 && !this.busy) { h -= 24; this.endOfDay(); }
      if (h >= 24) h = 23.99;
      eng.setHour(h);
      this._dl = (this._dl || 0) + dt;
      if (this._dl > 0.2) { this._dl = 0; this.updateDaylineCursor(); }
    }
    const r = eng.renderer.domElement;
    this.labels.update(r.clientWidth, r.clientHeight);
  }

  // ------------------------------------------------------------------ hover & click
  pickRoad(e) {
    const ctl = this.engine.controls;
    const p = ctl.groundAt(ctl.ndc(e));
    if (!p) return { p: null };
    const tol = Math.max(12, ctl.cur.dist * 0.012);
    const hit = this.engine.rg.nearest(p.x, p.z, tol);
    return { p, hit };
  }

  hover(e) {
    const hv = $('hover');
    if (this.placing) { this.hoverPark(e); return; }
    const { p, hit } = this.pickRoad(e);
    const canvas = this.engine.renderer.domElement;
    if (!p) { hv.classList.add('hidden'); canvas.classList.remove('pick'); return; }
    if (hit) {
      const s = hit.seg;
      const nm = this.R.seg_name[s] ? this.names[this.R.seg_name[s] - 1] : 'Безымянная дорога';
      const r = this.segRatioNow(s);
      hv.innerHTML = `<b>${esc(nm)}</b> · <span style="color:${ciColor(r - 1)}">${r < 1.12 ? 'свободно' : `+${Math.round((r - 1) * 100)}% ко времени`}</span>`;
      canvas.classList.add('pick');
    } else {
      const d = this.districtAt(p.x, p.z);
      if (d >= 0) hv.innerHTML = `${esc(this.meta.districts[d].name)} район`;
      else { hv.classList.add('hidden'); canvas.classList.remove('pick'); return; }
      canvas.classList.remove('pick');
    }
    hv.style.left = `${e.clientX}px`;
    hv.style.top = `${e.clientY}px`;
    hv.classList.remove('hidden');
  }

  segRatioNow(s) {
    const snap = this.engine.snap;
    if (!snap) return 1;
    const RL = this.net.roadLinks;
    const slot = Math.floor(this.engine.hour * 2) % 48;
    let r = 1;
    for (const l of [this.net.segLinks[2 * s], this.net.segLinks[2 * s + 1]]) {
      if (l >= 0 && l < RL) r = Math.max(r, snap.ratio[slot * RL + l] / 20);
    }
    return r;
  }

  click(e) {
    if (this.placing) { this.placePark(e); return; }
    if (this.panel.type === 'nodes') {
      const ctl = this.engine.controls;
      const p = ctl.groundAt(ctl.ndc(e));
      if (p) {
        const tol = Math.max(60, ctl.cur.dist * 0.03);
        let best = null, bd = tol;
        for (const j of this.junctions) { const d = Math.hypot(j.x - p.x, j.z - p.z); if (d < bd) { bd = d; best = j; } }
        if (best) { this.openJunction(best); return; }
      }
    }
    const { p, hit } = this.pickRoad(e);
    if (hit) { this.selectStreet(hit.seg, 'district'); return; }
    if (p) {
      const d = this.districtAt(p.x, p.z);
      if (d >= 0) { this.clearSelection(); this.openDistrict(d, false); return; }
    }
    this.clearSelection();
    this.openPanel({ type: 'city' });
  }

  /** Named street through `seg` (connected pieces), limited to the district if scope = district. */
  streetSegs(seg, scope) {
    const R = this.R;
    const name = R.seg_name[seg];
    const d = R.seg_district[seg];
    const out = new Set([seg]);
    const q = [seg];
    let lenSum = 0;
    while (q.length) {
      const s = q.pop();
      lenSum += R.seg_len[s];
      for (const n of [R.seg_a[s], R.seg_b[s]]) {
        for (const t of this.nodeSegs.get(n) || []) {
          if (out.has(t)) continue;
          if (name ? R.seg_name[t] !== name : (R.seg_name[t] !== 0 || R.seg_cls[t] !== R.seg_cls[seg] || lenSum > 2500)) continue;
          if (scope === 'district' && R.seg_district[t] !== d) continue;
          if (!(R.seg_flags[t] & 1)) continue;
          out.add(t);
          q.push(t);
        }
      }
    }
    return [...out];
  }

  selectStreet(seg, scope) {
    const segs = this.streetSegs(seg, scope);
    const R = this.R;
    const nameIdx = R.seg_name[seg];
    const name = nameIdx ? this.names[nameIdx - 1] : 'Безымянная дорога';
    const d = R.seg_district[seg];
    this.sel = { seg, segs, name, district: d < 8 ? d : -1, scope };
    this.engine.select(segs);
    this.openPanel({ type: 'street' });
  }

  clearSelection() {
    this.sel = null;
    this.engine.select(null);
  }

  flyToSegs(segs) {
    const rg = this.engine.rg;
    let x0 = Infinity, z0 = Infinity, x1 = -Infinity, z1 = -Infinity;
    for (const s of segs) {
      for (let i = rg.off[s]; i < rg.off[s + 1]; i++) {
        const x = rg.xyz[3 * i], z = rg.xyz[3 * i + 2];
        x0 = Math.min(x0, x); x1 = Math.max(x1, x); z0 = Math.min(z0, z); z1 = Math.max(z1, z);
      }
    }
    const span = Math.max(x1 - x0, z1 - z0);
    this.engine.controls.flyTo({ x: (x0 + x1) / 2, z: (z0 + z1) / 2, dist: Math.max(900, span * 1.25), pitch: 0.85 });
  }

  // ------------------------------------------------------------------ panels
  openPanel(p) {
    if (p.type !== 'parks') this.stopPlacing();
    this.panel = p;
    for (const b of $('dock').querySelectorAll('[data-panel]')) b.classList.toggle('on', b.dataset.panel === p.type);
    this.showJunctions(p.type === 'nodes' || p.type === 'junction');
    this.renderPanel();
  }

  refresh() {
    this.updateTop();
    this.updateLabels();
    this.updateDayline();
    // never rebuild the panel under the cursor; catch up when the mouse leaves it
    if (this.panelHover) this.panelStale = true;
    else this.renderPanel();
  }

  /** What the panel is showing: the scroll position survives re-renders of the same thing. */
  panelKey() {
    const p = this.panel;
    return [p.type, p.d ?? '', p.j ? p.j.nodes[0] : '', this.sel && p.type === 'street' ? `${this.sel.seg}/${this.sel.scope}` : ''].join(':');
  }

  renderPanel() {
    const body = $('panelBody');
    const key = this.panelKey();
    const keep = key === this._panelKey ? body.scrollTop : 0;
    this._panelKey = key;
    this.panelStale = false;
    const t = this.panel.type;
    let html = '';
    if (t === 'city') html = this.cityPanel();
    else if (t === 'district') html = this.districtPanel(this.panel.d);
    else if (t === 'street') html = this.sel ? this.streetPanel() : this.cityPanel();
    else if (t === 'schedule') html = this.schedulePanel();
    else if (t === 'nodes') html = this.nodesPanel();
    else if (t === 'junction') html = this.junctionPanel(this.panel.j);
    else if (t === 'policies') html = this.policiesPanel();
    else if (t === 'parks') html = this.parksPanel();
    else if (t === 'air') html = this.airPanel();
    body.innerHTML = html;
    body.scrollTop = keep;
    this.wirePanel(body);
  }

  wirePanel(body) {
    body.onmouseenter = () => { this.panelHover = true; };
    body.onmouseleave = () => { this.panelHover = false; if (this.panelStale) this.renderPanel(); };
    body.querySelectorAll('[data-go-street]').forEach(e => e.addEventListener('click', () => {
      const st = this.streets[+e.dataset.goStreet];
      if (!st) return;
      this.selectStreet(st.segs[0], 'district');
      this.flyToSegs(this.sel.segs);
    }));
    body.querySelectorAll('[data-go-district]').forEach(e => e.addEventListener('click', () => this.openDistrict(+e.dataset.goDistrict, true)));
    body.querySelectorAll('[data-close]').forEach(e => e.addEventListener('click', () => { this.clearSelection(); this.openPanel({ type: 'city' }); }));
    body.querySelectorAll('[data-scope]').forEach(e => e.addEventListener('click', () => this.selectStreet(this.sel.seg, e.dataset.scope)));
    body.querySelectorAll('[data-apply]').forEach(e => e.addEventListener('click', () => this.applyStreet(e.dataset.apply, e.dataset.dir)));
    body.querySelectorAll('[data-sched]').forEach(e => e.addEventListener('click', () => this.applySchedule(e.dataset.sched, +e.dataset.v, e.dataset.d != null ? +e.dataset.d : null)));
    body.querySelectorAll('[data-cancel]').forEach(e => e.addEventListener('click', () => { this.game.cancel(+e.dataset.cancel); this.flushNews(); this.refresh(); this.renderPanel(); }));
    body.querySelectorAll('[data-park-size]').forEach(e => e.addEventListener('click', () => { this.parkHa = +e.dataset.parkSize; this.startPlacing(); this.renderPanel(); }));
    body.querySelectorAll('[data-park-stop]').forEach(e => e.addEventListener('click', () => { this.stopPlacing(); this.renderPanel(); }));
    body.querySelectorAll('[data-air]').forEach(e => e.addEventListener('click', () => {
      const res = this.game.applyAir(e.dataset.air, e.dataset.d != null ? +e.dataset.d : -1);
      if (res.error) { this.toast(res.error, true); return; }
      this.flushNews(); this.refresh(); this.renderPanel();
    }));
    body.querySelectorAll('[data-build-junction]').forEach(e => e.addEventListener('click', () => this.buildJunction(this.panel.j)));
    body.querySelectorAll('[data-fly-policy]').forEach(e => e.addEventListener('click', () => {
      const p = this.game.s.policies.find(x => x.id === +e.dataset.flyPolicy);
      if (p && p.segs) { this.sel = { seg: p.segs[0], segs: p.segs, name: p.name, district: p.district, scope: 'district' }; this.engine.select(p.segs); this.flyToSegs(p.segs); this.openPanel({ type: 'street' }); }
      else if (p && p.x != null) this.engine.controls.flyTo({ x: p.x, z: p.z, dist: 1400 });
    }));
    // charts
    const cv = body.querySelector('canvas[data-chart]');
    if (cv) requestAnimationFrame(() => this.drawPanelChart(cv));
    const hc = body.querySelector('canvas[data-history]');
    if (hc) requestAnimationFrame(() => {
      const h = this.game.s.history;
      drawHistory(hc, h.map(x => Math.max(0, x.ci)), 0.3);
    });
  }

  // ---- city
  cityPanel() {
    const g = this.game, s = g.s;
    const m = this.last?.metrics;
    const prog = g.missionProgress();
    const mi = g.mission;
    const roll = g.rolling();
    let html = `<div class="p-kicker">${esc(mi.kicker)}</div><div class="p-title">${esc(mi.title)}</div>
      <div class="p-sub">${esc(mi.goals[0])}; ${esc(mi.goals[1] || '')}</div>
      <div class="sec">`;
    for (const it of prog.items) {
      html += `<div class="goal ${it.ok ? 'ok' : ''}"><div class="gl">${esc(it.label)}</div><div class="gv">${esc(it.value)} <small>цель ${esc(it.target)}</small></div><div class="gbar"><i style="width:${Math.round(it.frac * 100)}%"></i></div></div>`;
    }
    html += `</div>`;
    if (m) {
      const info = this.last.info;
      html += `<div class="sec"><h4>Город сейчас</h4><div class="kpis">
        <div class="kpi"><div class="k">Пробки за месяц</div><div class="v" style="color:${ciColor(m.ci)}">${pct(m.ci)}</div><div class="d">за 6 мес ${pct(roll.ci)}</div></div>
        <div class="kpi"><div class="k">Часов в пробках / день</div><div class="v">${num(m.lostHours / 1000)} тыс</div><div class="d">≈ ${money(m.lostHours * 1600)} в день</div></div>
        <div class="kpi"><div class="k">Жителей</div><div class="v">${(info.population / 1e6).toFixed(2).replace('.', ',')} млн</div><div class="d">растёт ~2% в год</div></div>
        <div class="kpi"><div class="k">Поездок на авто</div><div class="v">${(info.trips / 1e6).toFixed(2).replace('.', ',')} млн</div><div class="d">в будний день</div></div>
      </div>
      <canvas class="chart" data-history style="height:64px;margin-top:10px"></canvas>
      <div class="legend2"><span><i style="background:#2ec5e6"></i>индекс по месяцам</span><span><i style="background:#f6c447"></i>цель 30%</span></div></div>`;
      html += `<div class="sec"><h4><span>Районы</span><span>6 мес · цель ≤ 50%</span></h4><div class="rows">`;
      const order = this.meta.districts.map(d => d.id).sort((a, b) => roll.ciD[b] - roll.ciD[a]);
      for (const d of order) {
        const v = roll.ciD[d];
        const mood = g.districtMood(d);
        html += `<div class="row" data-go-district="${d}"><div class="nm"><span class="mood" style="background:${moodColor(mood)}" title="Настроение ${Math.round(mood)}"></span>${esc(this.meta.districts[d].name)}</div>
          <div class="bar"><i style="width:${Math.min(100, v * 100)}%;background:${ciColor(v)}"></i><b style="left:50%"></b></div><div class="pc" style="color:${v <= 0.5 ? 'var(--ok)' : 'var(--text)'}">${pct(v)}</div></div>`;
      }
      html += `</div></div>`;
      html += this.streetList(this.streets.slice(0, 10), 'Где хуже всего');
    }
    html += `<div class="sec"><h4>Лента</h4>${s.news.slice(0, 6).map(n => `<div class="p-sub" style="margin-bottom:8px"><span style="color:var(--dim)">${esc(n.date)} ·</span> ${esc(n.text)}</div>`).join('')}</div>`;
    return html;
  }

  streetList(list, title) {
    if (!list.length) return '';
    let html = `<div class="sec"><h4><span>${esc(title)}</span><span>за сутки</span></h4><div class="rows">`;
    for (const st of list) {
      const i = this.streets.indexOf(st);
      html += `<div class="row" data-go-street="${i}"><div class="nm">${esc(st.name)} <span style="color:var(--dim)">· ${esc(this.meta.districts[st.district].name.replace('ский', '.'))}</span></div>
        <div class="bar"><i style="width:${Math.min(100, st.ci * 70)}%;background:${ciColor(st.ci)}"></i></div><div class="pc">${pct(st.ci)}</div></div>`;
    }
    return html + '</div></div>';
  }

  // ---- district
  openDistrict(d, fly) {
    this.openPanel({ type: 'district', d });
    if (fly) {
      const dd = this.meta.districts[d];
      this.engine.controls.flyTo({ x: dd.lx, z: dd.lz, dist: Math.max(4500, Math.sqrt(dd.areaKm2) * 1400), pitch: 0.95 });
    }
  }

  districtPanel(d) {
    const g = this.game, dd = this.meta.districts[d];
    const roll = g.rolling();
    const m = this.last?.metrics;
    const mood = g.districtMood(d);
    const sch = g.s.schedule.school[d];
    let html = `<button class="p-close" data-close>✕</button><div class="p-kicker">Район</div><div class="p-title">${esc(dd.name)}</div>
      <div class="p-sub">${esc(dd.nameKk)} ауданы · ${dd.areaKm2} км² · ${num(dd.pop)} жителей (оценка 2025)</div>
      <div class="sec"><div class="kpis">
        <div class="kpi"><div class="k">Пробки за 6 мес</div><div class="v" style="color:${ciColor(roll.ciD[d])}">${pct(roll.ciD[d])}</div><div class="d">цель ≤ 50%</div></div>
        <div class="kpi"><div class="k">Настроение</div><div class="v" style="color:${moodColor(mood)}">${Math.round(mood)}</div><div class="d">из 100</div></div>
        <div class="kpi"><div class="k">Школ</div><div class="v">${dd.schools}</div><div class="d">уроки с ${fmtHour(sch)}</div></div>
        <div class="kpi"><div class="k">Этот месяц</div><div class="v">${m ? pct(m.ciD[d]) : '—'}</div><div class="d">индекс пробок</div></div>
      </div></div>
      <div class="sec"><h4>Пробки по часам</h4><canvas class="chart" data-chart="district"></canvas></div>
      <div class="sec"><h4><span>Начало уроков</span><span>${money(SCHEDULE_TOOLS.school.cost)}</span></h4>
        <div class="seg">${SCHEDULE_TOOLS.school.options.map(v => `<button class="${v === sch ? 'on' : ''}" data-sched="school" data-v="${v}" data-d="${d}">${fmtHour(v)}</button>`).join('')}</div>
        <div class="note" style="margin-top:8px">Сдвиг школ разводит утренний пик: родители везут детей не одновременно с офисами. Поначалу родители ${esc(distGen(dd.name))} района будут недовольны.</div>
      </div>`;
    html += this.streetList(this.streets.filter(s => s.district === d).slice(0, 8), 'Проблемные улицы района');
    return html;
  }

  // ---- street
  streetPanel() {
    const sel = this.sel, R = this.R, net = this.net;
    const segs = sel.segs;
    const lenKm = segs.reduce((a, s) => a + R.seg_len[s], 0) / 1000;
    const s0 = sel.seg;
    const lf = R.seg_lf[s0], lb = R.seg_lb[s0];
    const cls = R.seg_cls[s0];
    const dname = sel.district >= 0 ? this.meta.districts[sel.district].name : 'за городом';
    const axis = this.selAxis();
    const dirA = COMPASS[Math.round(axis.ang / (Math.PI / 4)) % 8];
    const dirB = COMPASS[(Math.round(axis.ang / (Math.PI / 4)) + 4) % 8];
    sel.axis = axis; sel.dirA = dirA; sel.dirB = dirB;
    const busF = R.seg_bf[s0] + R.seg_bb[s0];
    const pols = this.game.s.policies.filter(p => p.status !== 'cancelled' && p.segs && p.segs.some(s => segs.includes(s)));
    let html = `<button class="p-close" data-close>✕</button><div class="p-kicker">Улица</div><div class="p-title">${esc(sel.name)}</div>
      <div class="p-sub">${esc(dname)} · ${km(lenKm)} · ${lb ? `${lf}+${lb} полосы` : `${lf} пол., одностор.`}${busF ? ' · есть выделенка' : ''} · ${CLS_RU[cls]}</div>
      <div class="seg" style="margin-top:10px"><button class="${sel.scope === 'district' ? 'on' : ''}" data-scope="district">В районе</button><button class="${sel.scope === 'all' ? 'on' : ''}" data-scope="all">Вся улица</button></div>
      <div class="sec"><h4>Время в пути к свободной дороге</h4><canvas class="chart" data-chart="street"></canvas>
      <div class="legend2"><span><i style="background:#2ec5e6"></i>на ${dirA}</span><span><i style="background:#f6c447"></i>на ${dirB}</span></div></div>`;
    if (pols.length) {
      html += `<div class="sec"><h4>Действует</h4>${pols.map(p => this.policyRow(p)).join('')}</div>`;
    }
    html += `<div class="sec"><h4>Меры</h4>`;
    for (const [key, tool] of Object.entries(STREET_TOOLS)) {
      const q = this.game.streetQuote(key, segs, R, net);
      const dis = !!q.reason;
      let action;
      if (key === 'oneway') {
        action = `<button class="btn" ${dis ? 'disabled' : ''} data-apply="oneway" data-dir="A">→ на ${dirA}</button><button class="btn" ${dis ? 'disabled' : ''} data-apply="oneway" data-dir="B">→ на ${dirB}</button>`;
      } else action = `<button class="btn" ${dis ? 'disabled' : ''} data-apply="${key}">Ввести</button>`;
      html += `<div class="tool ${dis ? 'disabled' : ''}"><div class="ic">${ICONS[tool.icon] || ''}</div><div class="tn">${esc(tool.name)}</div>
        <div class="tc">${money(q.cost)}${q.upkeep ? `<div style="font-size:11px;color:var(--mute);font-family:var(--f-ui);font-weight:400">+${money(q.upkeep)}/мес</div>` : ''}</div>
        <div class="td">${esc(tool.desc)}</div>
        <div class="ta">${action}${q.reason ? `<span class="why">${esc(q.reason)}</span>` : `<span class="why" style="color:var(--mute)">${tool.build} мес. на внедрение</span>`}</div></div>`;
    }
    html += `</div>`;
    return html;
  }

  /** Principal axis of the selection (angle from north, clockwise). */
  selAxis() {
    const R = this.R;
    let sx = 0, sz = 0;
    for (const s of this.sel.segs) {
      const a = R.seg_a[s], b = R.seg_b[s];
      let dx = R.nodes[2 * b] - R.nodes[2 * a], dz = R.nodes[2 * b + 1] - R.nodes[2 * a + 1];
      // align to the running sum
      if (dx * sx + dz * sz < 0) { dx = -dx; dz = -dz; }
      sx += dx; sz += dz;
    }
    // prefer north- or east-pointing axis
    if (sz > 0 && Math.abs(sz) > Math.abs(sx) || sx < 0 && Math.abs(sx) >= Math.abs(sz)) { sx = -sx; sz = -sz; }
    let ang = Math.atan2(sx, -sz);
    if (ang < 0) ang += 2 * Math.PI;
    return { x: sx, z: sz, ang };
  }

  drawPanelChart(cv) {
    const snap = this.engine.snap;
    if (!snap) return;
    const RL = this.net.roadLinks;
    if (cv.dataset.chart === 'street' && this.sel) {
      const ax = this.sel.axis || this.selAxis();
      const A = new Float64Array(48), Aw = new Float64Array(48), B = new Float64Array(48), Bw = new Float64Array(48);
      for (const s of this.sel.segs) {
        const sdx = this.R.nodes[2 * this.R.seg_b[s]] - this.R.nodes[2 * this.R.seg_a[s]];
        const sdz = this.R.nodes[2 * this.R.seg_b[s] + 1] - this.R.nodes[2 * this.R.seg_a[s] + 1];
        const along = sdx * ax.x + sdz * ax.z >= 0;
        for (const [k, l] of [[0, this.net.segLinks[2 * s]], [1, this.net.segLinks[2 * s + 1]]]) {
          if (l < 0 || l >= RL) continue;
          const isA = (k === 0) === along;
          for (let t = 0; t < 48; t++) {
            const w = (snap.vol[t * RL + l] + 1) * this.net.len[l];
            const r = snap.ratio[t * RL + l] / 20;
            if (isA) { A[t] += r * w; Aw[t] += w; } else { B[t] += r * w; Bw[t] += w; }
          }
        }
      }
      const series = [];
      if (Aw[0] > 0) series.push({ color: '#2ec5e6', data: Array.from(A, (v, i) => (v / Aw[i] - 1) * 100) });
      if (Bw[0] > 0) series.push({ color: '#f6c447', data: Array.from(B, (v, i) => (v / Bw[i] - 1) * 100) });
      drawLines(cv, series, this.engine.hour, { ymax: 50, fmtY: v => `+${Math.round(v)}%` });
    } else if (cv.dataset.chart === 'district') {
      const d = this.panel.d;
      const m = this.last.metrics;
      const data = Array.from({ length: 48 }, (_, s) => Math.max(0, m.dSlotCI[d * 48 + s]) * 100);
      drawLines(cv, [{ color: '#2ec5e6', data, fill: 'rgba(46,197,230,0.12)' }], this.engine.hour, { ymax: 50, fmtY: v => `${Math.round(v)}%` });
    }
  }

  applyStreet(key, dir) {
    const sel = this.sel;
    if (!sel) return;
    const R = this.R, net = this.net, snap = this.engine.snap, RL = net.roadLinks;
    const params = {};
    if (key === 'oneway') {
      const ax = sel.axis || this.selAxis();
      params.fwd = sel.segs.map(s => {
        const dx = R.nodes[2 * R.seg_b[s]] - R.nodes[2 * R.seg_a[s]], dz = R.nodes[2 * R.seg_b[s] + 1] - R.nodes[2 * R.seg_a[s] + 1];
        const along = dx * ax.x + dz * ax.z >= 0;
        return dir === 'A' ? along : !along;
      });
    }
    if (key === 'reverse') {
      params.amFwd = sel.segs.map(s => {
        const f = net.segLinks[2 * s], b = net.segLinks[2 * s + 1];
        let vf = 0, vb = 0;
        for (let t = 13; t < 20; t++) {
          if (f >= 0 && f < RL) vf += snap.vol[t * RL + f];
          if (b >= 0 && b < RL) vb += snap.vol[t * RL + b];
        }
        return vf >= vb;
      });
    }
    const name = sel.name + (key === 'oneway' ? ` (на ${dir === 'A' ? sel.dirA : sel.dirB})` : '');
    const res = this.game.applyStreet(key, sel.segs, R, net, { name: sel.name, district: sel.district, params });
    if (res.error) { this.toast(res.error, true); return; }
    res.policy.label = name;
    this.toast(`${STREET_TOOLS[key].name}: ${sel.name} — ${money(res.policy.cost)}`);
    this.flushNews();
    this.refresh();
    this.renderPanel();
  }

  // ---- schedule
  schedulePanel() {
    const g = this.game, s = g.s;
    let html = `<div class="p-kicker">Расписание города</div><div class="p-title">Разведите город по времени</div>
      <div class="p-sub">Утренний пик — это когда школы, госучреждения, вузы и офисы стартуют одновременно. Сдвиньте их, и пик расплывётся.</div>
      <div class="sec"><h4>Город по часам</h4><canvas class="chart" data-chart="profile" style="height:110px"></canvas></div>
      <div class="sec sched">`;
    const row = (key, cur, extra = '') => {
      const t = SCHEDULE_TOOLS[key];
      const labels = t.labels || t.options.map(fmtHour);
      const up = t.upkeepPerStep ? ` · ${t.upkeepPerStep > 0 ? '+' : ''}${money(-t.upkeepPerStep)}/мес за шаг`.replace('+−', '−') : '';
      return `<div class="srow"><div class="sh">${esc(t.name)} <small>${money(t.cost)}${up}</small></div>
        <div class="seg">${t.options.map((v, i) => `<button class="${v === cur ? 'on' : ''}" data-sched="${key}" data-v="${v}" ${extra}>${labels[i]}</button>`).join('')}</div>
        <div class="p-sub" style="margin-top:6px;font-size:12px">${esc(t.desc)}</div></div>`;
    };
    html += row('gov', s.schedule.gov);
    html += row('uni', s.schedule.uni);
    html += row('flex', SCHEDULE_TOOLS.flex.options[s.levels.flex]);
    html += row('remote', SCHEDULE_TOOLS.remote.options[s.levels.remote]);
    html += row('freight', SCHEDULE_TOOLS.freight.options[s.levels.freight]);
    html += row('parking', SCHEDULE_TOOLS.parking.options[s.levels.parking]);
    html += `</div><div class="sec"><h4><span>Школы по районам</span><span>${money(SCHEDULE_TOOLS.school.cost)}</span></h4><div class="sched">`;
    for (const d of this.meta.districts) {
      const cur = s.schedule.school[d.id];
      html += `<div class="srow"><div class="sh">${esc(d.name)} <small>${d.schools} школ</small></div><div class="seg">${SCHEDULE_TOOLS.school.options.map(v => `<button class="${v === cur ? 'on' : ''}" data-sched="school" data-v="${v}" data-d="${d.id}">${fmtHour(v)}</button>`).join('')}</div></div>`;
    }
    html += `</div></div>`;
    return html;
  }

  applySchedule(key, v, d) {
    const res = this.game.setSchedule(key, v, d);
    if (res.error) { this.toast(res.error, true); return; }
    this.flushNews();
    this.refresh();
    this.renderPanel();
  }

  // ---- junctions
  nodesPanel() {
    const t = NODE_TOOLS.interchange;
    const list = this.junctions.map(j => ({ j, load: this.junctionLoad(j) })).sort((a, b) => b.load.delay - a.load.delay).slice(0, 12);
    let html = `<div class="p-kicker">Развязки и въезды</div><div class="p-title">Перекрёстки и въезды</div>
      <div class="p-sub">Золотые кольца на карте — перекрёстки главных улиц в одном уровне. ${esc(t.desc)}</div>
      <div class="sec"><div class="kpis"><div class="kpi"><div class="k">Стоимость</div><div class="v">${money(t.cost)}</div><div class="d">+${money(t.upkeep)}/мес</div></div>
      <div class="kpi"><div class="k">Стройка</div><div class="v">${t.build} мес.</div><div class="d">движение ограничено</div></div></div></div>
      <div class="sec"><h4>Самые тяжёлые перекрёстки</h4><div class="rows">`;
    list.forEach(({ j, load }, i) => {
      html += `<div class="row" data-junction="${this.junctions.indexOf(j)}"><div class="nm">${esc(j.label)}</div><div class="bar"><i style="width:${Math.min(100, load.ci * 70)}%;background:${ciColor(load.ci)}"></i></div><div class="pc">${pct(load.ci)}</div></div>`;
      void i;
    });
    html += `</div></div>`;
    // city entrances: commuters from the agglomeration
    const gl = this.gates.map(g => ({ g, load: this.gateLoad(g) })).filter(x => x.load.cars > 2000).sort((a, b) => b.load.cars - a.load.cars).slice(0, 8);
    html += `<div class="sec"><h4><span>Въезды в город</span><span>машин в сутки</span></h4>
      <div class="p-sub" style="margin-bottom:8px">Утром из области въезжает около 100 тыс. машин. Перехватывающая парковка или электричка снимают часть потока прямо на въезде.</div>`;
    for (const { g, load } of gl) {
      const act = this.game.s.policies.find(p => (p.type === 'pnr' || p.type === 'rail') && p.gate === g.i && p.status !== 'cancelled');
      html += `<div class="tool" style="grid-template-columns:1fr auto"><div class="tn" data-fly-gate="${g.i}" style="cursor:pointer">${esc(g.label)}</div>
        <div class="tc" style="color:${ciColor(load.ci)}">${num(load.cars / 1000)} тыс · ${pct(load.ci)}</div>
        <div class="ta">${act ? this.policyTag(act) : ''}${['pnr', 'rail'].map(k => { const q = this.game.gateQuote(k, g.i); return q.reason ? '' : `<button class="btn ${k === 'rail' ? 'gold' : ''}" data-gate="${g.i}" data-gate-tool="${k}">${GATE_TOOLS[k].short} · ${money(q.cost)}</button>`; }).join('')}</div></div>`;
    }
    html += `</div>`;
    setTimeout(() => {
      const body = $('panelBody');
      body.querySelectorAll('[data-junction]').forEach(e => e.addEventListener('click', () => this.openJunction(this.junctions[+e.dataset.junction], true)));
      body.querySelectorAll('[data-fly-gate]').forEach(e => e.addEventListener('click', () => { const g = this.gates[+e.dataset.flyGate]; this.engine.controls.flyTo({ x: g.x, z: g.z, dist: 3500, pitch: 0.8 }); }));
      body.querySelectorAll('[data-gate-tool]').forEach(e => e.addEventListener('click', () => {
        const g = this.gates[+e.dataset.gate];
        const res = this.game.applyGate(e.dataset.gateTool, g.i, g.name);
        if (res.error) { this.toast(res.error, true); return; }
        this.toast(`${GATE_TOOLS[e.dataset.gateTool].name}: ${g.label} — ${money(res.policy.cost)}`);
        this.flushNews(); this.refresh(); this.renderPanel();
      }));
    }, 0);
    return html;
  }

  junctionLoad(j) {
    const m = this.last?.metrics;
    if (!m) return { ci: 0, delay: 0, vol: 0 };
    let vt = 0, vt0 = 0;
    for (const n of j.nodes) {
      for (let e = this.net.firstIn[n]; e < this.net.firstIn[n + 1]; e++) {
        const l = this.net.inc[e];
        if (l >= this.net.roadLinks) continue;
        vt += m.linkDaily[l] * m.linkVT0[l]; vt0 += m.linkVT0[l];
      }
    }
    return { ci: vt0 ? vt / vt0 - 1 : 0, delay: vt - vt0 };
  }

  openJunction(j, fly) {
    this.panel = { type: 'junction', j };
    this.showJunctions(true);
    this.renderPanel();
    if (fly) this.engine.controls.flyTo({ x: j.x, z: j.z, dist: 1600, pitch: 0.9 });
    // highlight incident streets
    const segs = new Set();
    for (const n of j.nodes) for (const s of this.nodeSegs.get(n) || []) segs.add(s);
    this.engine.select([...segs], 0x7fe3ff);
  }

  junctionPanel(j) {
    const t = NODE_TOOLS.interchange;
    const q = this.game.nodeQuote('interchange', j.nodes[0]);
    const load = this.junctionLoad(j);
    const pol = this.game.s.policies.find(p => p.type === 'interchange' && p.node === j.nodes[0] && p.status !== 'cancelled');
    return `<button class="p-close" data-close>✕</button><div class="p-kicker">Перекрёсток</div><div class="p-title">${esc(j.label)}</div>
      <div class="p-sub">${j.d >= 0 ? esc(this.meta.districts[j.d].name) + ' район' : ''}</div>
      <div class="sec"><div class="kpis"><div class="kpi"><div class="k">Задержка на въездах</div><div class="v" style="color:${ciColor(load.ci)}">${pct(load.ci)}</div><div class="d">за сутки</div></div>
      <div class="kpi"><div class="k">Развязка</div><div class="v">${money(t.cost)}</div><div class="d">${t.build} мес. стройки</div></div></div></div>
      ${pol ? `<div class="sec">${this.policyRow(pol)}</div>` : ''}
      <div class="sec"><div class="note">${esc(t.desc)} Во время стройки въезды на перекрёсток теряют 40% пропускной способности — район будет недоволен.</div></div>
      <div class="sec"><button class="btn gold" data-build-junction ${q.reason ? 'disabled' : ''} style="width:100%;padding:12px">${q.reason ? esc(q.reason) : `Построить развязку · ${money(q.cost)}`}</button></div>`;
  }

  buildJunction(j) {
    const res = this.game.applyNode('interchange', j.nodes[0], { name: j.label, district: j.d, nodes: j.nodes, x: j.x, z: j.z });
    if (res.error) { this.toast(res.error, true); return; }
    this.toast(`Стройка развязки: ${j.label}`);
    this.flushNews();
    this.refresh();
    this.showJunctions(true);
    this.renderPanel();
  }

  // ---- policies
  policyTag(p) {
    const left = p.ready - this.game.s.month;
    return p.status === 'building' ? `<span class="tag build">${esc(GATE_TOOLS[p.type]?.short || '')}: ${Math.max(1, left)} мес.</span>` : `<span class="tag active">${esc(GATE_TOOLS[p.type]?.short || '')} работает</span>`;
  }

  policyRow(p) {
    const tool = STREET_TOOLS[p.type] || NODE_TOOLS[p.type] || AIR_TOOLS[p.type] || GATE_TOOLS[p.type];
    const left = p.ready - this.game.s.month;
    const st = p.status === 'building' ? `<span class="tag build">внедрение · ${Math.max(1, left)} мес.</span>` : '<span class="tag active">работает</span>';
    return `<div class="tool" style="grid-template-columns:38px 1fr auto"><div class="ic">${ICONS[tool.icon] || ''}</div>
      <div class="tn" data-fly-policy="${p.id}" style="cursor:pointer">${esc(tool.short)} · ${esc(p.label || p.name)}</div>
      <div class="tc">${p.upkeep ? `${money(p.upkeep)}/мес` : ''}</div>
      <div class="ta">${st}<button class="btn danger" data-cancel="${p.id}" style="margin-left:auto;padding:5px 10px">Отменить</button></div></div>`;
  }

  policiesPanel() {
    const s = this.game.s;
    const act = s.policies.filter(p => p.status === 'active' || p.status === 'building');
    const sched = [];
    const d = this.meta.districts;
    s.schedule.school.forEach((v, i) => { if (v !== 8) sched.push(`Школы ${d[i].name.replace('ский', '.')}: ${fmtHour(v)}`); });
    if (s.schedule.gov !== 9) sched.push(`Госслужба: ${fmtHour(s.schedule.gov)}`);
    if (s.schedule.uni !== 8.5) sched.push(`Вузы: ${fmtHour(s.schedule.uni)}`);
    for (const [k, v] of Object.entries(s.levels)) if (v) sched.push(`${SCHEDULE_TOOLS[k].short}: ${SCHEDULE_TOOLS[k].labels[v]}`);
    let html = `<div class="p-kicker">Принятые меры</div><div class="p-title">${act.length + sched.length ? `${act.length + sched.length} мер` : 'Пока ничего'}</div>
      <div class="p-sub">Содержание: ${money(this.game.monthlyUpkeep())} в месяц · потрачено ${money(s.spent)}</div>`;
    if (sched.length) html += `<div class="sec"><h4>Расписание</h4>${sched.map(x => `<div class="tag" style="margin:0 6px 6px 0">${esc(x)}</div>`).join('')}</div>`;
    if (act.length) html += `<div class="sec"><h4>Улицы и перекрёстки</h4>${act.map(p => this.policyRow(p)).join('')}</div>`;
    if (!act.length && !sched.length) html += `<div class="sec note">Кликните по улице на карте, чтобы увидеть её загрузку и доступные меры. Расписание школ и офисов — во вкладке «Время».</div>`;
    return html;
  }

  // ---- mission 2: parks
  parksPanel() {
    const g = this.game;
    const st = g.green();
    const locked = g.s.mission < 1;
    const ha = this.parkHa || 4;
    let html = `<div class="p-kicker">Миссия 2${locked ? ' · откроется позже' : ''}</div><div class="p-title">Зелёная Алматы</div>
      <div class="p-sub">${esc(PARK_TOOL.desc)}</div>`;
    if (st) {
      html += `<div class="sec"><div class="kpis">
        <div class="kpi"><div class="k">Парков на жителя</div><div class="v">${st.perCapita.toFixed(1).replace('.', ',')} м²</div><div class="d">цель ≥ 12 м²</div></div>
        <div class="kpi"><div class="k">Площадь парков</div><div class="v">${num(st.areaHa)} га</div><div class="d">новых: ${num(g.s.parks.reduce((a, p) => a + p.ha, 0))} га</div></div></div></div>
        <div class="sec"><h4><span>Парк в 10 минутах от дома</span><span>цель ≥ 70%</span></h4><div class="rows">`;
      st.access.forEach((v, d) => {
        html += `<div class="row" data-go-district="${d}"><div class="nm">${esc(this.meta.districts[d].name)}</div><div class="bar"><i style="width:${Math.round(v * 100)}%;background:${v >= 0.7 ? 'var(--ok)' : 'var(--sky)'}"></i><b style="left:70%"></b></div><div class="pc">${pct(v)}</div></div>`;
      });
      html += `</div></div>`;
    }
    html += `<div class="sec"><h4>Новый парк</h4><div class="seg">${PARK_TOOL.sizes.map(s => `<button class="${s === ha && this.placing ? 'on' : ''}" data-park-size="${s}" ${locked ? 'disabled' : ''}>${s} га</button>`).join('')}</div>
      <div class="note" style="margin-top:8px">${locked ? 'Парки откроются после победы над пробками (миссия 1).' : this.placing ? 'Наведите на карту: зелёный круг — можно строить, красный — нельзя. Клик — заложить парк.' : 'Выберите размер, затем место на карте.'}</div>
      ${this.placing ? '<button class="btn ghost" data-park-stop style="margin-top:8px">Отмена</button>' : ''}</div>`;
    return html;
  }

  startPlacing() {
    this.placing = true;
    this.engine.renderer.domElement.classList.add('pick');
  }

  stopPlacing() {
    if (!this.placing) return;
    this.placing = false;
    this.engine.previewRing(null);
    $('hover').classList.add('hidden');
  }

  hoverPark(e) {
    const ctl = this.engine.controls;
    const p = ctl.groundAt(ctl.ndc(e));
    const hv = $('hover');
    if (!p) { this.engine.previewRing(null); hv.classList.add('hidden'); return; }
    const d = this.districtAt(p.x, p.z);
    const q = this.game.parkQuote(p.x, p.z, this.parkHa || 4, d);
    this.engine.previewRing(p.x, p.z, q.r || 100, !q.reason);
    const sv = q.survey || { houses: 0 };
    hv.innerHTML = q.reason ? `<b style="color:var(--bad)">${esc(q.reason)}</b>` : `<b>${money(q.cost)}</b>${sv.houses ? ` · выкуп ${sv.houses} домов` : ' · пустырь'}`;
    hv.style.left = `${e.clientX}px`; hv.style.top = `${e.clientY}px`;
    hv.classList.remove('hidden');
  }

  placePark(e) {
    const ctl = this.engine.controls;
    const p = ctl.groundAt(ctl.ndc(e));
    if (!p) return;
    const d = this.districtAt(p.x, p.z);
    const res = this.game.addPark(p.x, p.z, this.parkHa || 4, d, 'Новый парк');
    if (res.error) { this.toast(res.error, true); return; }
    this.engine.addPark(res.park);
    this.toast(`Парк ${res.park.ha} га — ${money(res.park.cost)}`);
    this.flushNews(); this.refresh(); this.renderPanel();
  }

  // ---- mission 3: air
  airPanel() {
    const g = this.game;
    const a = g.air();
    const locked = g.s.mission < 2;
    let html = `<div class="p-kicker">Миссия 3${locked ? ' · откроется позже' : ''}</div><div class="p-title">Чистый воздух</div>
      <div class="p-sub">Зимой горы держат над городом смог: печи частного сектора, угольная ТЭЦ-2 и выхлопы в пробках.</div>`;
    if (a) {
      const P = a.parts, tot = a.winterAqi;
      const col = tot <= 100 ? 'var(--ok)' : tot <= 150 ? 'var(--warn)' : 'var(--bad)';
      html += `<div class="sec"><div class="kpis"><div class="kpi"><div class="k">Зимний AQI (прогноз)</div><div class="v" style="color:${col}">${Math.round(tot)}</div><div class="d">цель ≤ 100</div></div>
        <div class="kpi"><div class="k">Сейчас</div><div class="v">${Math.round(a.nowAqi)}</div><div class="d">${esc(g.dateLabel())}</div></div></div></div>
        <div class="sec"><h4>Откуда смог</h4><div class="rows">${[['Печи частного сектора', P.coal], ['ТЭЦ-2', P.tpp], ['Транспорт', P.traffic], ['Прочее', P.other]].map(([n, v]) =>
          `<div class="row"><div class="nm">${n}</div><div class="bar"><i style="width:${Math.min(100, v / 0.9)}%;background:var(--warn)"></i></div><div class="pc">${Math.round(v)}</div></div>`).join('')}</div></div>`;
    }
    html += `<div class="sec"><h4>Меры</h4>`;
    for (const key of ['tpp', 'ebus', 'lez']) {
      const t = AIR_TOOLS[key], q = g.airQuote(key);
      html += `<div class="tool ${q.reason ? 'disabled' : ''}"><div class="ic">${ICONS[t.icon] || ICONS.gov}</div><div class="tn">${esc(t.name)}</div><div class="tc">${money(q.cost)}</div>
        <div class="td">${esc(t.desc)}</div><div class="ta"><button class="btn" data-air="${key}" ${q.reason ? 'disabled' : ''}>Запустить</button><span class="why">${esc(q.reason || `${t.build} мес.`)}</span></div></div>`;
    }
    html += `</div><div class="sec"><h4><span>Газификация по районам</span><span>доля печей</span></h4>`;
    const hs = g.houseShare();
    for (const d of this.meta.districts) {
      const q = g.airQuote('gas', d.id);
      html += `<div class="srow" style="display:flex;align-items:center;gap:10px;padding:8px 10px;border-radius:12px;background:rgba(255,255,255,.035);border:1px solid var(--line);margin-bottom:6px">
        <div style="flex:1"><div style="font-weight:600;font-size:13.5px">${esc(d.name)}</div><div class="p-sub" style="font-size:12px">${pct(hs[d.id])} печей · ${money(q.cost)}</div></div>
        <button class="btn" data-air="gas" data-d="${d.id}" ${q.reason ? 'disabled' : ''}>${q.reason ? esc(q.reason) : 'Газ'}</button></div>`;
    }
    return html + '</div>';
  }

  // ------------------------------------------------------------------ HUD
  updateTop() {
    const g = this.game, s = g.s;
    $('date').textContent = g.dateLabel();
    $('term').textContent = `месяц ${Math.min(TERM_MONTHS, s.month + 1)} из ${TERM_MONTHS}`;
    $('termFill').style.width = `${(s.month / TERM_MONTHS) * 100}%`;
    const roll = g.rolling();
    const ci = $('ci');
    ci.textContent = pct(roll.ci);
    ci.style.color = ciColor(roll.ci);
    const okD = roll.ciD.filter(v => v <= 0.5).length;
    $('ciSub').textContent = `районов в норме: ${okD}/8`;
    $('budget').textContent = money(s.budget);
    const net = g.monthlyIncome(this.last && this.last.metrics) - g.monthlyUpkeep();
    const up = $('upkeep');
    up.textContent = `${net >= 0 ? '+' : '−'}${money(Math.abs(net))} в месяц`;
    up.style.color = net >= 0 ? 'var(--ok)' : 'var(--bad)';
    const rep = g.reputation();
    $('rep').textContent = Math.round(rep);
    $('rep').style.color = moodColor(rep);
    $('repFill').style.width = `${rep}%`;
    $('repFill').style.background = moodColor(rep);
    $('mKicker').textContent = g.mission.kicker;
    $('mTitle').textContent = g.mission.title;
    for (const b of $('dock').querySelectorAll('[data-panel="parks"],[data-panel="air"]')) {
      const need = b.dataset.panel === 'parks' ? 1 : 2;
      b.classList.toggle('locked', s.mission < need);
    }
  }

  updateLabels() {
    const roll = this.game.rolling();
    this.dLabels.forEach((l, d) => {
      const v = roll.ciD[d];
      l.badge.textContent = pct(v);
      l.badge.style.background = ciColor(v);
      l.badge.style.color = v > 1.6 ? '#fff' : '#0b0f17';
    });
  }

  updateDayline() {
    const m = this.last?.metrics;
    if (!m) return;
    const cv = $('dayChart').querySelector('canvas');
    const d = this.panel.type === 'district' ? this.panel.d : -1;
    const ci = d >= 0 ? Array.from({ length: 48 }, (_, s) => m.dSlotCI[d * 48 + s]) : m.slotCI;
    drawDay(cv, ci, m.slotVol);
    this.updateDaylineCursor();
  }

  updateDaylineCursor() {
    const m = this.last?.metrics;
    const h = this.engine.hour;
    $('dayCursor').style.left = `${(h / 24) * 100}%`;
    $('hourLbl').textContent = fmtHour(h);
    if (m) {
      const s = Math.floor(h * 2) % 48;
      const v = m.slotCI[s];
      const word = v < 0.15 ? 'свободно' : v < 0.5 ? 'плотно' : v < 1 ? 'пробки' : 'город стоит';
      $('hourCI').innerHTML = `${word}: поездка дольше на <b style="color:${ciColor(v)}">${Math.round(v * 100)}%</b>`;
    }
  }

  // ------------------------------------------------------------------ news & toasts
  pushNews(n) {
    const box = $('news');
    const colors = { decision: '#33bde0', done: '#34c97c', complaint: '#f5a83a', alert: '#f2554a', event: '#a88cff', good: '#34c97c', bad: '#f2554a', money: '#f2bd45', victory: '#f2bd45', info: '#8b95a4' };
    const e = el('div', 'nitem', `<div class="nd">${esc(n.date)}</div>${esc(n.text)}`);
    e.style.setProperty('--c', colors[n.kind] || '#33bde0');
    box.prepend(e);
    while (box.children.length > 4) box.lastChild.remove();
    setTimeout(() => { e.classList.add('fade'); setTimeout(() => e.remove(), 900); }, 14000);
  }

  flushNews() {
    // decisions are announced immediately, not at the end of the month
    const s = this.game.s;
    const shown = this._shownNews || 0;
    const fresh = s.news.slice(0, Math.max(0, s.news.length - shown));
    this._shownNews = s.news.length;
    for (const n of fresh.reverse()) if (n.kind === 'decision' || n.kind === 'complaint') this.pushNews(n);
  }

  toast(text, bad = false) {
    const t = el('div', 'toast' + (bad ? ' bad' : ''), esc(text));
    $('toasts').appendChild(t);
    setTimeout(() => t.remove(), 3200);
  }

  // ------------------------------------------------------------------ modals
  modal(html, actions) {
    const m = $('modal');
    $('modalCard').innerHTML = html + `<div class="m-actions">${actions.map((a, i) => `<button class="btn ${a.cls || ''}" data-i="${i}">${esc(a.label)}</button>`).join('')}</div>`;
    m.classList.remove('hidden');
    $('modalCard').querySelectorAll('[data-i]').forEach(b => b.addEventListener('click', () => {
      m.classList.add('hidden');
      actions[+b.dataset.i].fn && actions[+b.dataset.i].fn();
    }));
  }

  showStartMenu(save, { onContinue, onNew }) {
    const when = save ? new Date(save.savedAt).toLocaleString('ru-RU', { day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit' }) : '';
    this.modal(`<div class="m-kicker">Алматы · симулятор акима</div><div class="m-title">ӘКІМ</div>
      <div class="m-text">Реальный город из OpenStreetMap, 2,3 млн жителей и 60 месяцев, чтобы победить пробки, озеленить город и очистить воздух.</div>
      ${save ? `<div class="m-box" style="margin-top:18px"><h5>Сохранённая игра · ${esc(when)}</h5>
        <div class="m-res" style="margin:6px 0 0"><div><b>${esc(save.label)}</b>месяц ${save.month + 1} из ${TERM_MONTHS}</div><div><b>${esc((DIFFICULTY[save.difficulty] || DIFFICULTY.normal).name)}</b>сложность</div><div><b>${save.mission + 1}</b>миссия</div></div></div>` : ''}`,
    save
      ? [{ label: 'Новая игра', cls: 'ghost', fn: onNew }, { label: 'Продолжить', cls: 'gold', fn: onContinue }]
      : [{ label: 'Новая игра', cls: 'gold', fn: onNew }]);
  }

  showDifficulty(onPick) {
    const cards = Object.values(DIFFICULTY).map(d => `<div class="m-box" style="display:flex;flex-direction:column">
        <h5>${d.key === 'normal' ? 'рекомендуем' : '&nbsp;'}</h5>
        <div style="font-family:var(--f-display);font-weight:700;font-size:20px">${esc(d.name)}</div>
        <div style="font-family:var(--f-display);font-weight:700;font-size:26px;color:var(--gold);margin:6px 0 4px">${money(d.budget)}</div>
        <div class="p-sub" style="flex:1;margin-bottom:12px">${esc(d.desc)}</div>
        <button class="btn ${d.key === 'normal' ? 'gold' : 'ghost'}" data-diff="${d.key}">Играть</button></div>`).join('');
    this.modal(`<div class="m-kicker">Новая игра</div><div class="m-title">Уровень сложности</div>
      <div class="m-grid" style="grid-template-columns:repeat(3,1fr)">${cards}</div>
      ${UI.loadSave() ? '<div class="note">Старое сохранение будет перезаписано в конце первого месяца.</div>' : ''}`, []);
    $('modalCard').querySelectorAll('[data-diff]').forEach(b => b.addEventListener('click', () => {
      $('modal').classList.add('hidden');
      onPick(b.dataset.diff);
    }));
  }

  showBusy(title, text) {
    $('modalCard').innerHTML = `<div class="m-kicker">Подождите</div><div class="m-title" style="font-size:30px">${esc(title)}</div>
      <div class="m-text">${esc(text)}</div><div class="ld-bar" style="margin:22px 0 4px;width:100%"><i id="busyFill"></i></div>`;
    $('modal').classList.remove('hidden');
  }

  setBusy(f) { const e = $('busyFill'); if (e) e.style.width = `${Math.round(f * 100)}%`; }

  hideBusy() { $('modal').classList.add('hidden'); }

  showBriefing(onStart) {
    const mi = this.game.mission;
    const s = this.game.s;
    const roll = this.game.rolling();
    const worst = roll.ciD.map((v, d) => [v, d]).sort((a, b) => b[0] - a[0]).slice(0, 3).map(([v, d]) => `${this.meta.districts[d].name} — ${pct(v)}`);
    this.modal(`<div class="m-kicker">${esc(mi.kicker)} · ${esc(this.game.dateLabel())}</div><div class="m-title">${esc(mi.title)}</div>
      <div class="m-text">Вы — новый аким Алматы. ${esc(mi.brief)}</div>
      <div class="m-grid"><div class="m-box"><h5>Цели</h5><ul>${mi.goals.map(g => `<li>${esc(g)}</li>`).join('')}</ul></div>
      <div class="m-box"><h5>Сейчас хуже всего</h5><ul><li>Пробки по городу: <b>${pct(roll.ci)}</b></li>${worst.map(w => `<li>${esc(w)}</li>`).join('')}</ul></div></div>
      <div class="m-res"><div><b>${money(s.budget)}</b>бюджет</div><div><b>${TERM_MONTHS} мес.</b>срок полномочий</div><div><b>${Math.round(this.game.reputation())}</b>репутация из 100</div></div>
      <div class="note">Каждый месяц казна пополняется: трансферт растёт вместе с репутацией, налоги — когда в городе меньше пробок.</div>`,
    [{ label: 'Приступить', cls: 'gold', fn: onStart }]);
  }

  showHelp(back) {
    this.modal(`<div class="m-kicker">Как играть</div><div class="m-title">Управление городом</div>
      <div class="m-grid">
      <div class="m-box"><h5>Камера</h5><ul><li>Левая кнопка — двигать карту</li><li>Правая кнопка — вращать и наклонять</li><li>Колесо — приблизить к курсору</li><li>WASD / стрелки, Q/E, R/F</li></ul></div>
      <div class="m-box"><h5>Время</h5><ul><li>Один месяц = одни сутки на экране (~30 с)</li><li>Пробел — пауза, 1/2/3 — скорость</li><li>Полоса снизу — сутки: тяните, чтобы посмотреть любой час</li></ul></div>
      <div class="m-box"><h5>Меры</h5><ul><li>Клик по улице — её пробки по часам и меры</li><li>«Время» — школы, госслужба, вузы, гибкий график</li><li>«Развязки» — перекрёстки главных улиц</li></ul></div>
      <div class="m-box"><h5>Деньги и репутация</h5><ul><li>Доход растёт с репутацией и когда пробок меньше</li><li>Платный въезд, парковка и камеры приносят деньги, но злят жителей</li><li>Репутация 0 — отставка</li></ul></div>
      </div>
      <div class="note">Индекс пробок как у TomTom: на сколько дольше поездка, чем по пустому городу, в среднем за сутки. Улицы, здания и районы — реальные данные OpenStreetMap.</div>`,
    [{ label: 'Пройти обучение', cls: 'ghost', fn: () => this.onTutorial && this.onTutorial() }, { label: back ? 'Назад' : 'Понятно', cls: 'gold', fn: back }]);
  }

  showSettings() {
    const cur = this.engine.quality;
    const opts = [['low', 'Низкая', 'без теней и деревьев — для слабых ноутбуков'], ['medium', 'Средняя', 'тени, деревья рядом, сглаживание'], ['high', 'Высокая', 'чёткость ×1.5, больше машин и деталей']];
    this.modal(`<div class="m-kicker">Настройки</div><div class="m-title">Качество графики</div>
      <div class="m-grid" style="grid-template-columns:repeat(3,1fr)">${opts.map(([k, n, d]) => `<div class="m-box"><h5>${k === cur ? 'сейчас' : '&nbsp;'}</h5><div style="font-family:var(--f-display);font-weight:700;font-size:18px">${n}</div><div class="p-sub" style="margin:4px 0 12px;min-height:36px">${d}</div><button class="btn ${k === cur ? 'gold' : 'ghost'}" data-q="${k}">Выбрать</button></div>`).join('')}</div>
      <div class="note">Игра перезагрузится, прогресс сохранится — выберите «Продолжить».</div>`,
    [{ label: 'Закрыть', cls: 'ghost' }]);
    $('modalCard').querySelectorAll('[data-q]').forEach(b => b.addEventListener('click', () => {
      try { localStorage.setItem('akim-quality', b.dataset.q); } catch { /* ignore */ }
      this.save();
      location.reload();
    }));
  }

  showMissionComplete({ mission, next }) {
    this.setSpeed(0);
    this.modal(`<div class="m-kicker">${esc(mission.kicker)} выполнена · ${esc(this.game.dateLabel())}</div><div class="m-title">${esc(mission.title)}: победа!</div>
      <div class="m-text">Республиканский бюджет выделяет городу <b>${money(mission.reward)}</b>. ${next ? `Следующая задача — «${esc(next.title)}».` : 'Все задачи выполнены — вы войдёте в историю города.'}</div>
      ${next ? `<div class="m-box" style="margin-top:16px"><h5>${esc(next.kicker)}: ${esc(next.title)}</h5><div class="m-text" style="font-size:14px">${esc(next.brief)}</div><ul style="margin-top:8px">${next.goals.map(g => `<li>${esc(g)}</li>`).join('')}</ul></div>` : ''}`,
    [{ label: 'Продолжить', cls: 'gold', fn: () => { this.refresh(); this.renderPanel(); } }]);
  }

  showGameOver(over) {
    this.setSpeed(0);
    try { localStorage.removeItem(SAVE_KEY); } catch { /* ignore */ }
    const s = this.game.s;
    const title = over.type === 'defeat' ? 'Отставка' : 'Срок полномочий истёк';
    const text = over.type === 'defeat'
      ? 'Репутация упала до нуля: маслихат выразил недоверие, и аким покидает пост.'
      : `Пять лет на посту позади. Выполнено миссий: ${s.completed.length} из 3.`;
    this.modal(`<div class="m-kicker">${esc(this.game.dateLabel())}</div><div class="m-title">${title}</div>
      <div class="m-text">${text}</div>
      <div class="m-res" style="margin-top:16px"><div><b>${s.completed.length}</b>миссий</div><div><b>${pct(this.game.rolling().ci)}</b>пробки</div><div><b>${money(s.spent)}</b>потрачено</div><div><b>${money(s.earned)}</b>заработано</div></div>`,
    [{ label: 'Новая игра', cls: 'gold', fn: () => { location.reload(); } }]);
  }
}

export { MISSIONS, THREE };

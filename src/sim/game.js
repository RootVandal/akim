// Campaign state of the akim: money, time, reputation, missions, events, news.
// Pure logic (no DOM); the traffic numbers come from the worker every month.

import { mulberry32, pick } from './rng.js';
import { DEFAULT_SCHEDULE, fmtHour } from './profiles.js';
import { STREET_TOOLS, NODE_TOOLS, SCHEDULE_TOOLS, PARK_TOOL, AIR_TOOLS, GATE_TOOLS, streetCost, segsKm } from './policies.js';
import { MISSIONS } from './missions.js';
import { distGen, distPrep, streetPrep, streetGen } from './names.js';

export const MONTHS = ['Январь', 'Февраль', 'Март', 'Апрель', 'Май', 'Июнь', 'Июль', 'Август', 'Сентябрь', 'Октябрь', 'Ноябрь', 'Декабрь'];
export const MONTHS_GEN = ['января', 'февраля', 'марта', 'апреля', 'мая', 'июня', 'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря'];
export const TERM_MONTHS = 60;
export const ROLL = 6; // months in the mission averages

// Difficulty: starting money, income, how forgiving the residents are, how fast the city grows.
export const DIFFICULTY = {
  easy: {
    key: 'easy', name: 'Лёгкий', budget: 500e6, income: 1.5, repBias: 8, impatience: 0, growth: 0.7, events: 0.6,
    desc: '500 млн ₸ на старте, доход ×1,5, жители терпеливы, город растёт медленнее.',
  },
  normal: {
    key: 'normal', name: 'Нормальный', budget: 100e6, income: 1, repBias: 0, impatience: 1, growth: 1, events: 1,
    desc: '100 млн ₸, обычный доход. Город растёт на ~2% в год, жители ждут результатов.',
  },
  hard: {
    key: 'hard', name: 'Сложный', budget: 60e6, income: 0.8, repBias: -4, impatience: 1.5, growth: 1.25, events: 1.3,
    desc: '60 млн ₸, доход ниже, жители требовательнее, город растёт быстрее, чаще снегопады и ремонты.',
  },
};
export const SAVE_KEY = 'akim-save-v1';
const START_YEAR = 2026, START_CAL = 9; // October 2026

export function fmtMoney(v, short = false) {
  const s = v < 0 ? '−' : '';
  v = Math.abs(v);
  if (short) {
    if (v >= 1e9) return `${s}${(v / 1e9).toFixed(v >= 1e10 ? 0 : 1).replace('.', ',')} млрд ₸`;
    if (v >= 1e6) return `${s}${(v / 1e6).toFixed(v >= 1e8 ? 0 : 1).replace('.', ',')} млн ₸`;
    if (v >= 1e3) return `${s}${Math.round(v / 1e3)} тыс ₸`;
    return `${s}${Math.round(v)} ₸`;
  }
  return `${s}${Math.round(v).toLocaleString('ru-RU')} ₸`;
}
export const pct = v => `${Math.round(v * 100)}%`;

export class Game {
  constructor(meta, opts = {}) {
    this.meta = meta;
    this.names = meta.roads.names;
    this.seed = opts.seed ?? 20261006;
    this.rng = mulberry32(this.seed);
    const pops = meta.districts.map(d => d.pop);
    const tot = pops.reduce((a, b) => a + b, 0);
    this.popShare = pops.map(p => p / tot);
    this.s = {
      month: 0,
      budget: MISSIONS[0].budget,
      rep: 55,
      mood: Array(8).fill(55),
      income: 0,
      earned: 0,
      shocks: [],
      policies: [],
      nextId: 1,
      schedule: { ...DEFAULT_SCHEDULE(), remote: 0, parking: 0 },
      levels: { flex: 0, remote: 0, freight: 0, parking: 0, toll: 0, cameras: 0 },
      mission: 0,
      missionStart: 0,
      completed: [],
      history: [],
      news: [],
      events: [],
      spent: 0,
      over: null,
      warned: 0,
      lastYearGrown: 0,
      totalBudget: MISSIONS[0].budget,
      difficulty: 'normal',
      parks: [],
      air: { base: null, last: null },
    };
    this.listeners = [];
    this.setDifficulty(opts.difficulty || 'normal');
  }

  /** Only before the first month: sets the starting budget and the rules. */
  setDifficulty(key) {
    const d = DIFFICULTY[key] || DIFFICULTY.normal;
    this.diff = d;
    this.s.difficulty = d.key;
    this.s.budget = d.budget;
    this.s.totalBudget = d.budget;
  }

  // ------------------------------------------------------------------ time
  date(month = this.s.month) {
    const m = START_CAL + month;
    return { year: START_YEAR + Math.floor(m / 12), cal: m % 12 };
  }
  dateLabel(month = this.s.month) {
    const d = this.date(month);
    return `${MONTHS[d.cal]} ${d.year}`;
  }
  get mission() { return MISSIONS[this.s.mission]; }

  // ------------------------------------------------------------------ news
  say(text, kind = 'info', extra = {}) {
    const item = { month: this.s.month, date: this.dateLabel(), text, kind, ...extra };
    this.s.news.unshift(item);
    if (this.s.news.length > 120) this.s.news.length = 120;
    this._report && this._report.news.push(item);
    return item;
  }

  shock(district, amount, half, label) {
    this.s.shocks.push({ d: district, amount, half, t0: this.s.month, label });
  }

  shockAt(sh, month = this.s.month) {
    return sh.amount * Math.pow(0.5, (month - sh.t0) / sh.half);
  }

  /** Reputation shown to the player: weighted district moods + decaying shocks. */
  reputation() {
    // population-weighted mood of the districts (each includes its own and city-wide reactions)
    let r = 0;
    for (let d = 0; d < 8; d++) r += this.popShare[d] * this.districtMood(d);
    return Math.max(0, Math.min(100, r));
  }
  districtMood(d) {
    let sh = 0;
    for (const x of this.s.shocks) if (x.d === d || x.d < 0) sh += this.shockAt(x);
    return Math.max(0, Math.min(100, this.s.mood[d] + sh));
  }

  // ------------------------------------------------------------------ actions
  streetQuote(key, segs, R, net) {
    const tool = STREET_TOOLS[key];
    const km = segsKm(R, segs);
    const reason = tool.check(net, segs);
    const { cost, upkeep } = streetCost(tool, km);
    const busy = this.s.policies.find(p => p.status !== 'cancelled' && p.segs && p.segs.some(s => segs.includes(s)) && conflicts(p.type, key));
    return {
      km, cost, upkeep,
      reason: this.s.over ? 'Игра окончена' : reason || (busy ? `Конфликтует с мерой «${STREET_TOOLS[busy.type]?.short || busy.type}» на этой улице` : null) ||
        (cost > this.s.budget ? 'Не хватает бюджета' : null),
    };
  }

  applyStreet(key, segs, R, net, extra = {}) {
    const q = this.streetQuote(key, segs, R, net);
    if (q.reason) return { error: q.reason };
    const tool = STREET_TOOLS[key];
    const district = extra.district ?? majorityDistrict(net, segs);
    const p = {
      id: this.s.nextId++, type: key, segs: [...segs], name: extra.name || 'улица', district,
      cost: q.cost, upkeep: q.upkeep, km: q.km, start: this.s.month, ready: this.s.month + tool.build,
      status: 'building', ...extra.params,
    };
    this.s.policies.push(p);
    this.s.budget -= q.cost;
    this.s.spent += q.cost;
    this.say(announce(key, p), 'decision', { district });
    return { policy: p };
  }

  nodeQuote(key, node) {
    const tool = NODE_TOOLS[key];
    const busy = this.s.policies.find(p => p.type === key && p.node === node && p.status !== 'cancelled');
    return {
      cost: tool.cost, upkeep: tool.upkeep,
      reason: this.s.over ? 'Игра окончена' : busy ? 'Здесь уже строится развязка' : tool.cost > this.s.budget ? 'Не хватает бюджета' : null,
    };
  }

  applyNode(key, node, extra = {}) {
    const q = this.nodeQuote(key, node);
    if (q.reason) return { error: q.reason };
    const tool = NODE_TOOLS[key];
    const p = {
      id: this.s.nextId++, type: key, node, nodes: extra.nodes || [node], name: extra.name || 'перекрёсток', district: extra.district ?? -1,
      cost: q.cost, upkeep: q.upkeep, start: this.s.month, ready: this.s.month + tool.build, status: 'building',
      x: extra.x, z: extra.z,
    };
    this.s.policies.push(p);
    this.s.budget -= q.cost;
    this.s.spent += q.cost;
    this.say(`Начато строительство развязки: ${p.name}. Срок — ${tool.build} мес., на время работ движение ограничено.`, 'decision', { district: p.district });
    return { policy: p };
  }

  scheduleQuote(key, value, district) {
    const tool = SCHEDULE_TOOLS[key];
    const cur = this.scheduleValue(key, district);
    if (cur === value) return { cost: 0, reason: 'Уже действует' };
    const cost = tool.cost;
    return { cost, reason: this.s.over ? 'Игра окончена' : cost > this.s.budget ? 'Не хватает бюджета' : null };
  }

  scheduleValue(key, district) {
    const s = this.s.schedule;
    if (key === 'school') return s.school[district];
    if (key in this.s.levels) return SCHEDULE_TOOLS[key].options[this.s.levels[key]];
    return s[key];
  }

  setSchedule(key, value, district) {
    const q = this.scheduleQuote(key, value, district);
    if (q.reason) return { error: q.reason };
    const tool = SCHEDULE_TOOLS[key];
    const s = this.s.schedule;
    const dn = district != null ? this.meta.districts[district].name : null;
    this.s.budget -= q.cost;
    this.s.spent += q.cost;
    if (key === 'school') {
      const dh = Math.abs(value - s.school[district]);
      s.school[district] = value;
      this.shock(district, tool.repPerHour * dh, tool.half, 'Школы');
      this.say(`Решение акимата: в школах ${distGen(dn)} района уроки начинаются в ${fmtHour(value)}.`, 'decision', { district });
      if (dh >= 0.5) {
        this.later(1, () => this.say(pick(this.rng, [
          `Родители ${distGen(dn)} района собирают подписи против нового расписания школ.`,
          `«Кто будет отвозить детей?» — чат родителей ${distGen(dn)} района кипит.`,
          `Учителя ${distGen(dn)} района просят оставить вторую смену как есть.`,
        ]), 'complaint', { district }));
      }
    } else if (key === 'gov' || key === 'uni') {
      const dh = Math.abs(value - s[key]);
      s[key] = value;
      this.shock(-1, tool.repPerHour * dh, tool.half, tool.short);
      this.say(key === 'gov'
        ? `Госучреждения города переходят на рабочий день с ${fmtHour(value)}.`
        : `Пары в вузах и колледжах начинаются в ${fmtHour(value)}.`, 'decision');
    } else {
      const idx = tool.options.indexOf(value);
      const prev = this.s.levels[key];
      this.s.levels[key] = idx;
      if (key === 'flex') s.flex = value;
      if (key === 'freight') s.nightFreight = value;
      if (key === 'remote') s.remote = value;
      if (key === 'parking') s.parking = value;
      if (key === 'toll') s.toll = value;
      if (key === 'cameras') s.cameras = value;
      this.shock(-1, (tool.repPerStep || 0) * (idx - prev), tool.half, tool.short);
      const msg = {
        flex: idx ? `Программа гибкого графика: ${tool.labels[idx]} офисных сотрудников начинают в 8:00 или 10:00.` : 'Программа гибкого графика свёрнута.',
        remote: idx ? 'Госслужащие по пятницам работают из дома.' : 'Удалёнка по пятницам отменена.',
        freight: idx ? `Ночной завоз: ${tool.labels[idx]} грузовых рейсов переносятся на ночь.` : 'Ночной завоз отменён.',
        parking: idx ? 'В центре вводится платная парковка: 200 ₸ в час.' : 'Платная парковка в центре отменена.',
        toll: idx ? 'Въезд в центр в часы пик станет платным: 500 ₸ за день.' : 'Платный въезд в центр отменён.',
        cameras: idx ? 'На перекрёстках ставят камеры фиксации нарушений. Штрафы — в городской бюджет.' : 'Камеры фиксации отключены.',
      }[key];
      this.say(msg, 'decision');
    }
    return { ok: true };
  }

  cancel(id) {
    const p = this.s.policies.find(x => x.id === id);
    if (!p || p.status === 'cancelled') return;
    p.status = 'cancelled';
    p.ended = this.s.month;
    this.shock(p.district ?? -1, -2, 4, 'Отмена');
    this.say(`Акимат отменил меру «${(STREET_TOOLS[p.type] || NODE_TOOLS[p.type] || AIR_TOOLS[p.type] || GATE_TOOLS[p.type]).short}»: ${p.name}.`, 'decision', { district: p.district });
  }

  later(months, fn) { this.s.events.push({ at: this.s.month + months, fn }); }

  activePolicies() {
    return this.s.policies.filter(p => p.status === 'active' || p.status === 'building');
  }

  /** Monthly income: republican transfer (grows with reputation) + taxes (grow when traffic flows). */
  monthlyIncome(metrics) {
    const rep = this.reputation();
    const ci = metrics ? metrics.ci : (this.s.history.length ? this.s.history[this.s.history.length - 1].ci : 0.6);
    const transfer = 1.2e6 + 1.8e6 * rep / 100;
    const taxes = Math.max(0, 0.7 - ci) * 4e6;
    return Math.round((transfer + taxes) * this.diff.income / 1e4) * 1e4;
  }

  incomeBreakdown() {
    const rep = this.reputation();
    const h = this.s.history[this.s.history.length - 1];
    const ci = h ? h.ci : 0.6;
    return { transfer: 1.2e6 + 1.8e6 * rep / 100, taxes: Math.max(0, 0.7 - ci) * 4e6 };
  }

  monthlyUpkeep() {
    let u = 0;
    for (const p of this.activePolicies()) u += p.upkeep || 0;
    for (const [k, idx] of Object.entries(this.s.levels)) u += (SCHEDULE_TOOLS[k].upkeepPerStep || 0) * idx;
    return u;
  }

  // ------------------------------------------------------------------ month cycle
  /** What the traffic worker needs for the coming month. */
  beginMonth() {
    const { cal, year } = this.date();
    const events = {};
    const segCap = {};
    let capCity = 1;
    // random events with traffic effects
    for (const ev of this.s.activeFx || []) {
      if (ev.until < this.s.month) continue;
      if (ev.capCity) capCity *= ev.capCity;
      if (ev.segs) for (const s of ev.segs) segCap[s] = ev.segCap;
    }
    events.capCity = capCity;
    events.segCap = Object.keys(segCap).length ? segCap : null;
    const grow = (cal === 0 && this.s.month > 0) ? year - START_YEAR - 1 : null;
    const act = k => this.s.policies.some(p => p.type === k && p.status === 'active');
    this.s.schedule.ebus = act('ebus') ? 1 : 0;
    this.s.schedule.lez = act('lez') ? 1 : 0;
    return {
      calMonth: cal, events, grow, growthMul: this.diff.growth,
      schedule: this.s.schedule,
      policies: this.s.policies.filter(p => p.status === 'active' || p.status === 'building')
        .map(p => ({ id: p.id, type: p.type, segs: p.segs, node: p.node, nodes: p.nodes, gate: p.gate, status: p.status, amFwd: p.amFwd, fwd: p.fwd })),
    };
  }

  /** Apply the month's traffic results; returns a report for the UI. */
  endMonth(metrics, ctx = {}) {
    const s = this.s;
    const report = this._report = { news: [], month: s.month };
    const { cal } = this.date();
    if (ctx.population) this.population = ctx.population;
    s.air.last = { vkm: metrics.vkm, ci: metrics.ci };
    if (!s.air.base) s.air.base = { vkm: metrics.vkm, ci: metrics.ci };
    s.history.push({
      month: s.month, ci: metrics.ci, ciD: [...metrics.ciD], VT: [...metrics.VT], VT0: [...metrics.VT0],
      lost: metrics.lostHours, rep: 0, budget: 0,
    });
    // moods follow congestion
    // people expect results: after a year and a half without the first win, patience runs out
    const impatience = s.completed.length ? 0 : Math.min(18, Math.max(0, s.month - 18) * 0.45) * this.diff.impatience;
    if (impatience > 0 && s.month % 6 === 0) this.say('Опрос: жители считают, что акимат слишком долго обещает победить пробки.', 'complaint');
    for (let d = 0; d < 8; d++) {
      const ci = Math.max(0, metrics.ciD[d]) * 100;
      const target = Math.max(0, Math.min(100, 92 - 0.62 * ci - impatience + this.diff.repBias));
      s.mood[d] += 0.15 * (target - s.mood[d]);
    }
    // policies that finish construction
    for (const p of s.policies) {
      if (p.status === 'building' && s.month >= p.ready) {
        p.status = 'active';
        const tool = STREET_TOOLS[p.type] || NODE_TOOLS[p.type] || AIR_TOOLS[p.type] || GATE_TOOLS[p.type];
        if (tool.rep) this.shock(tool.rep.scope === 'district' ? (p.district ?? -1) : -1, tool.rep.amount, tool.rep.half, tool.short);
        this.say(completed(p), 'done', { district: p.district });
      } else if (p.status === 'building') {
        const tool = STREET_TOOLS[p.type] || NODE_TOOLS[p.type] || AIR_TOOLS[p.type] || GATE_TOOLS[p.type];
        if (tool.repBuild) this.shock(p.district ?? -1, tool.repBuild, 2, 'Стройка');
      }
    }
    // money: transfers grow with reputation, taxes grow when the city moves
    const upkeep = this.monthlyUpkeep();
    const income = this.monthlyIncome(metrics);
    s.income = income;
    s.earned += income;
    s.budget += income - upkeep;
    if (s.budget < 0) {
      // the finance department suspends the most expensive running programme
      const cand = s.policies.filter(p => p.status === 'active' && p.upkeep > 0).sort((a, b) => b.upkeep - a.upkeep)[0];
      const lv = Object.entries(s.levels).filter(([k, v]) => v > 0 && SCHEDULE_TOOLS[k].upkeepPerStep > 0);
      if (cand) { cand.status = 'cancelled'; cand.ended = s.month; this.say(`Нет денег на содержание: мера «${STREET_TOOLS[cand.type]?.short || 'развязка'}» (${cand.name}) приостановлена.`, 'alert'); }
      else if (lv.length) { const [k] = lv[0]; s.levels[k] = 0; this.say(`Нет денег: программа «${SCHEDULE_TOOLS[k].short}» свёрнута.`, 'alert'); }
      this.shock(-1, -3, 4, 'Долги');
    }
    // scripted / random events
    this.runEvents(metrics, ctx);
    for (const e of s.events.filter(e => e.at <= s.month)) e.fn();
    s.events = s.events.filter(e => e.at > s.month);
    s.shocks = s.shocks.filter(x => Math.abs(this.shockAt(x)) > 0.05);
    const rep = this.reputation();
    const prevRep = s.rep;
    s.rep = rep;
    const h = s.history[s.history.length - 1];
    h.rep = rep; h.budget = s.budget;
    // warnings / defeat
    if (rep <= 0.0001) {
      s.over = { type: 'defeat', month: s.month };
      this.say('Маслихат выразил недоверие. Аким уходит в отставку.', 'alert');
    } else if (rep < 15 && s.warned < 2) {
      s.warned = 2;
      this.say('Последнее предупреждение: репутация акима на исторически низком уровне.', 'alert');
    } else if (rep < 25 && s.warned < 1) {
      s.warned = 1;
      this.say('Депутаты маслихата требуют отчёта о пробках. Репутация падает.', 'alert');
    } else if (rep > 32) s.warned = 0;
    // mission progress
    const prog = this.missionProgress();
    report.progress = prog;
    if (!s.over && prog.done && s.month - s.missionStart >= (this.mission.minMonths || 0)) {
      report.missionComplete = this.completeMission();
    }
    if (!s.over && s.month + 1 >= TERM_MONTHS) {
      s.over = { type: 'term', month: s.month };
      this.say('Срок полномочий истёк. Итоги 50 лет работы — в отчёте.', 'alert');
    }
    report.rep = rep; report.repDelta = rep - prevRep; report.upkeep = upkeep; report.income = income;
    report.over = s.over;
    s.month++;
    this._report = null;
    return report;
  }

  /** Pretend the last 12 months looked like the starting state (annual index from day one). */
  seedHistory(m) {
    for (let k = ROLL; k >= 1; k--) {
      this.s.history.push({ month: -k, ci: m.ci, ciD: [...m.ciD], VT: [...m.VT], VT0: [...m.VT0], lost: m.lostHours, rep: this.s.rep, budget: this.s.budget, seed: true });
    }
  }

  /** Vehicle-time weighted congestion over the last `months` (mission period). */
  rolling(months = ROLL) {
    const h = this.s.history.slice(-months);
    let vt = 0, vt0 = 0;
    const dvt = Array(8).fill(0), dvt0 = Array(8).fill(0);
    for (const x of h) {
      for (let d = 0; d < 8; d++) { dvt[d] += x.VT[d]; dvt0[d] += x.VT0[d]; vt += x.VT[d]; vt0 += x.VT0[d]; }
    }
    return {
      ci: vt0 ? vt / vt0 - 1 : 0,
      ciD: dvt.map((v, d) => (dvt0[d] ? v / dvt0[d] - 1 : 0)),
      months: h.length,
    };
  }

  missionProgress() {
    return this.mission.progress(this);
  }

  completeMission() {
    const s = this.s;
    const m = this.mission;
    s.completed.push({ id: m.id, month: s.month, rep: s.rep, budgetLeft: s.budget });
    this.say(`Миссия «${m.title}» выполнена! Республиканский бюджет выделяет ${fmtMoney(m.reward, true)}.`, 'victory');
    s.budget += m.reward;
    s.totalBudget += m.reward;
    this.shock(-1, 6, 8, 'Победа');
    const next = MISSIONS[s.mission + 1];
    if (next) {
      s.mission++;
      s.missionStart = s.month + 1;
      this.say(`Новая миссия: «${next.title}».`, 'victory');
    } else {
      s.over = { type: 'victory', month: s.month };
    }
    return { mission: m, next };
  }

  runEvents(metrics, ctx) {
    const s = this.s, r = this.rng;
    const { cal, year } = this.date();
    const dn = i => this.meta.districts[i].name;
    s.activeFx = (s.activeFx || []).filter(e => e.until > s.month);
    // seasonal flavour
    if (cal === 8) this.say('1 сентября: дети пошли в школу — утренний пик вернулся.', 'info');
    if (cal === 5) this.say('Начались каникулы: по утрам дороги заметно свободнее.', 'info');
    if (cal === 2 && r() < 0.8) this.say('Наурыз мейрамы! Центр перекрыт для праздничных гуляний.', 'info');
    if (cal === 11 && r() < 0.6) this.say('Предновогодний шопинг: у торговых центров тянется пробка.', 'info');
    // snow
    const ev = this.diff.events;
    if ((cal === 11 || cal === 0 || cal === 1) && r() < 0.32 * ev) {
      s.activeFx.push({ until: s.month + 1, capCity: 0.91, kind: 'snow' });
      this.say(pick(r, [
        'Снегопад: за ночь выпало 20 см, город стоит в девятибалльных пробках.',
        'Гололёд на Аль-Фараби: десятки ДТП, скорость движения упала вдвое.',
        'Снег идёт третий день — коммунальщики не успевают чистить дороги.',
      ]), 'event');
      if (metrics.ci > 0.75) this.shock(-1, -1, 2, 'Снегопад');
    }
    // utility works on a busy street
    if (cal >= 3 && cal <= 9 && r() < 0.22 * ev && ctx.busyStreets && ctx.busyStreets.length) {
      const st = pick(r, ctx.busyStreets.slice(0, 12));
      s.activeFx.push({ until: s.month + 2, segs: st.segs, segCap: 0.6, kind: 'repair', name: st.name });
      this.say(`Ремонт теплосетей: на ${streetPrep(st.name)} перекрыта часть полос на два месяца.`, 'event');
    }
    // viral video
    if (metrics.ci > 0.7 && r() < 0.08 * ev && ctx.busyStreets && ctx.busyStreets.length) {
      const st = ctx.busyStreets[0];
      this.say(`Видео пробки на ${streetPrep(st.name)} набрало ${2 + Math.floor(r() * 5)} млн просмотров. Жители требуют решений.`, 'complaint');
      this.shock(st.district ?? -1, -2.5, 3, 'Вирусное видео');
    }
    // grants
    if (r() < 0.018) {
      const v = (3 + Math.floor(r() * 5)) * 1e6;
      s.budget += v;
      this.say(`Республиканский бюджет выделил городу ${fmtMoney(v, true)} на дорожную инфраструктуру.`, 'money');
    }
    // flavour
    const roll = r();
    if (roll < 0.03) this.say('На Шымбулаке фотоловушка сняла снежного барса.', 'info');
    else if (roll < 0.05) this.say('Землетрясение магнитудой 4 по шкале Рихтера — без последствий.', 'info');
    else if (roll < 0.08) this.say(`В ${distPrep(dn(pick(r, [0, 6, 2, 7])))} районе сдали новый ЖК на ${2 + Math.floor(r() * 4)} тысячи квартир.`, 'info');
    else if (roll < 0.1 && cal >= 3 && cal <= 9) this.say('Алматы-марафон: в воскресенье перекрыты Аль-Фараби и Достык.', 'info');
    else if (roll < 0.12 && (cal === 11 || cal === 0)) this.say('Смог над городом: индекс качества воздуха превысил 170.', 'event');
    // monthly digest
    const prev = s.history[s.history.length - 2];
    if (prev) {
      const d = metrics.ci - prev.ci;
      if (Math.abs(d) > 0.04) {
        this.say(d < 0
          ? `Яндекс-пробки: за месяц загруженность снизилась на ${Math.round(-d * 100)} п.п.`
          : `Пробки растут: за месяц загруженность выросла на ${Math.round(d * 100)} п.п.`, d < 0 ? 'good' : 'bad');
      }
    }
    void year;
  }

  // ------------------------------------------------------------------ city entrances
  gateQuote(key, gate) {
    const t = GATE_TOOLS[key];
    const busy = this.s.policies.find(p => (p.type === 'pnr' || p.type === 'rail') && p.gate === gate && p.status !== 'cancelled');
    let reason = null;
    if (this.s.over) reason = 'Игра окончена';
    else if (busy && busy.type === key) reason = busy.status === 'active' ? 'Уже работает' : 'Уже строится';
    else if (busy && key === 'pnr' && busy.type === 'rail') reason = 'Здесь уже электричка';
    else if (t.cost > this.s.budget) reason = 'Не хватает бюджета';
    return { cost: t.cost, upkeep: t.upkeep, reason };
  }

  applyGate(key, gate, name) {
    const q = this.gateQuote(key, gate);
    if (q.reason) return { error: q.reason };
    const t = GATE_TOOLS[key];
    // the suburban train replaces a park & ride at the same entrance
    for (const p of this.s.policies) if (p.type === 'pnr' && p.gate === gate && key === 'rail' && p.status !== 'cancelled') { p.status = 'cancelled'; p.ended = this.s.month; }
    const p = {
      id: this.s.nextId++, type: key, gate, name, district: -1, cost: q.cost, upkeep: q.upkeep,
      start: this.s.month, ready: this.s.month + t.build, status: 'building',
    };
    this.s.policies.push(p);
    this.s.budget -= q.cost;
    this.s.spent += q.cost;
    this.say(key === 'pnr'
      ? `${cap(name)}: строят перехватывающую парковку и пускают автобусы-экспрессы до центра.`
      : `${cap(name)}: запускают пригородную электричку. Срок — ${t.build} мес.`, 'decision');
    return { policy: p };
  }

  // ------------------------------------------------------------------ mission 2: parks
  attach(models) { this.models = models; this._houseShare = null; }

  green() {
    if (!this.models || !this.models.green) return null;
    return this.models.green.stats(this.population || 2.34e6);
  }

  parkQuote(x, z, ha, district) {
    const g = this.models && this.models.green;
    if (!g) return { reason: 'Недоступно' };
    const r = Math.sqrt(ha * 1e4 / Math.PI);
    const sv = g.survey(x, z, r);
    const t = PARK_TOOL;
    const cost = Math.round((ha * t.perHa * (1 - 0.7 * sv.parkShare) + sv.houses * t.house + sv.small * t.small + sv.other * t.other) / 1e4) * 1e4;
    let reason = null;
    if (this.s.over) reason = 'Игра окончена';
    else if (this.s.mission < 1) reason = 'Откроется в миссии 2';
    else if (district < 0) reason = 'За пределами города';
    else if (sv.apartments > 0) reason = `Под парком ${sv.apartments} многоэтаж. — снос невозможен`;
    else if (sv.parkShare > 0.6) reason = 'Здесь уже есть парк';
    else if (cost > this.s.budget) reason = 'Не хватает бюджета';
    return { cost, r, survey: sv, reason };
  }

  addPark(x, z, ha, district, name) {
    const q = this.parkQuote(x, z, ha, district);
    if (q.reason) return { error: q.reason };
    this.s.budget -= q.cost;
    this.s.spent += q.cost;
    const park = { id: this.s.nextId++, x, z, r: q.r, ha, district, cost: q.cost, month: this.s.month, name, ids: q.survey.ids };
    this.s.parks.push(park);
    this.models.green.addPark(x, z, q.r, q.survey.ids);
    this._houseShare = null;
    this.shock(district, 3 + Math.min(5, ha / 6), 14, 'Парк');
    if (q.survey.houses) this.shock(district, -Math.min(6, q.survey.houses * 0.08), 5, 'Выкуп домов');
    const where = distPrep(this.meta.districts[district].name);
    this.say(q.survey.houses
      ? `В ${where} районе разбивают парк на ${ha} га: выкуплено ${q.survey.houses} частных домов, жильцы спорят о компенсации.`
      : `Новый парк на ${ha} га в ${where} районе: высадят ${Math.round(ha * 180)} деревьев.`, 'decision', { district });
    return { park };
  }

  // ------------------------------------------------------------------ mission 3: air
  airPolicy(key, district = -1) {
    return this.s.policies.find(p => p.type === key && p.status !== 'cancelled' && (district < 0 || p.district === district));
  }

  houseShare() {
    if (!this._houseShare && this.models && this.models.green) this._houseShare = this.models.green.houseShare();
    return this._houseShare || Array(8).fill(1 / 8);
  }

  air() {
    const base = this.s.air.base, last = this.s.air.last;
    if (!base || !last) return null;
    const hs = this.houseShare();
    const done = (p) => (p && p.status === 'active' ? 1 : 0);
    let coal = 0;
    for (let d = 0; d < 8; d++) coal += hs[d] * (1 - 0.85 * done(this.airPolicy('gas', d)));
    const tpp = done(this.airPolicy('tpp')) ? 0.1 : 1;
    const traffic = (last.vkm / base.vkm) * ((1 + 0.5 * Math.max(0, last.ci)) / (1 + 0.5 * Math.max(0, base.ci)))
      * (done(this.airPolicy('ebus')) ? 0.82 : 1) * (done(this.airPolicy('lez')) ? 0.88 : 1);
    const parksHa = this.s.parks.reduce((a, p) => a + p.ha, 0);
    const parts = { coal: 72 * coal, tpp: 40 * tpp, traffic: 38 * Math.min(2.5, traffic), other: Math.max(18, 32 - parksHa * 0.015) };
    const winterAqi = parts.coal + parts.tpp + parts.traffic + parts.other;
    const { cal } = this.date();
    const heat = [1, 0.95, 0.6, 0.25, 0.1, 0.05, 0.05, 0.05, 0.1, 0.3, 0.7, 0.95][cal];
    const nowAqi = parts.other * 0.8 + parts.traffic * 0.85 + (parts.coal + parts.tpp) * heat;
    return { winterAqi, nowAqi, parts };
  }

  airQuote(key, district = -1) {
    const t = AIR_TOOLS[key];
    let cost = t.cost;
    if (key === 'gas') cost = Math.round((t.base + t.perShare * this.houseShare()[district]) / 1e4) * 1e4;
    const busy = this.airPolicy(key, key === 'gas' ? district : -1);
    let reason = null;
    if (this.s.over) reason = 'Игра окончена';
    else if (this.s.mission < 2) reason = 'Откроется в миссии 3';
    else if (busy) reason = busy.status === 'active' ? 'Уже сделано' : 'Уже строится';
    else if (cost > this.s.budget) reason = 'Не хватает бюджета';
    return { cost, upkeep: t.upkeep || 0, reason };
  }

  applyAir(key, district = -1) {
    const q = this.airQuote(key, district);
    if (q.reason) return { error: q.reason };
    const t = AIR_TOOLS[key];
    const dname = key === 'gas' ? this.meta.districts[district].name : '';
    const p = {
      id: this.s.nextId++, type: key, district: key === 'gas' ? district : -1, name: key === 'gas' ? `${dname} район` : t.short,
      cost: q.cost, upkeep: q.upkeep, start: this.s.month, ready: this.s.month + t.build, status: 'building',
    };
    this.s.policies.push(p);
    this.s.budget -= q.cost;
    this.s.spent += q.cost;
    const msg = {
      gas: `Газификация: в ${key === 'gas' ? distPrep(dname) : ''} районе тянут газ к частным домам. Срок — ${t.build} мес.`,
      tpp: `Начат перевод ТЭЦ-2 с угля на газ. Срок — ${t.build} мес.`,
      ebus: 'Акимат закупает 600 электробусов.',
      lez: 'В центре вводится зона низких выбросов: старым машинам въезд закрыт.',
    }[key];
    this.say(msg, 'decision', { district: p.district });
    return { policy: p };
  }

  // ------------------------------------------------------------------ save
  /** Traffic-model state needed to rebuild the city after loading a save. */
  trafficState() {
    const ctx = this.beginMonth();
    // grow() calls already applied up to the current month (every January after the start)
    let years = 0;
    for (let k = 1; k <= this.s.month; k++) if (this.date(k).cal === 0) years++;
    return { calMonth: ctx.calMonth, schedule: ctx.schedule, policies: ctx.policies, years, growthMul: this.diff.growth, events: ctx.events };
  }

  /** Replace the whole state with a saved one (same object, so the UI keeps its reference). */
  load(json) {
    const o = typeof json === 'string' ? JSON.parse(json) : json;
    this.s = o.s;
    this.s.events = [];
    this.rng.setState(o.rng);
    this.diff = DIFFICULTY[this.s.difficulty] || DIFFICULTY.normal;
    this._houseShare = null;
    this._report = null;
  }

  serialize() {
    return JSON.stringify({ v: 1, seed: this.seed, rng: this.rng.state(), s: { ...this.s, events: [] } });
  }
  static restore(meta, json) {
    const o = JSON.parse(json);
    const g = new Game(meta, { seed: o.seed });
    g.s = o.s;
    g.rng.setState(o.rng);
    return g;
  }
}

function conflicts(a, b) {
  const group = { reverse: 'dir', oneway: 'dir', buslane: 'bus', removebus: 'bus', widen: 'widen', greenwave: 'gw', noparking: 'np' };
  return group[a] === group[b] || (group[a] === 'dir' && group[b] === 'bus') || (group[a] === 'bus' && group[b] === 'dir');
}

export function majorityDistrict(net, segs) {
  const c = new Float64Array(9);
  for (const s of segs) {
    const l = net.segLinks[2 * s] >= 0 ? net.segLinks[2 * s] : net.segLinks[2 * s + 1];
    const d = l >= 0 ? net.district[l] : 255;
    c[d < 8 ? d : 8] += l >= 0 ? net.len[l] : 0;
  }
  let best = -1, bv = -1;
  for (let d = 0; d < 8; d++) if (c[d] > bv) { bv = c[d]; best = d; }
  return bv > 0 ? best : -1;
}

function announce(key, p) {
  const km = p.km ? ` (${p.km.toFixed(1).replace('.', ',')} км)` : '';
  const at = streetPrep(p.name), of = streetGen(p.name);
  switch (key) {
    case 'reverse': return `На ${at}${km} вводится реверсивное движение. Монтаж табло — ${STREET_TOOLS.reverse.build} мес.`;
    case 'oneway': return `Движение на ${at}${km} станет односторонним. Водителей просят заранее планировать маршрут.`;
    case 'greenwave': return `На ${at}${km} ставят адаптивные светофоры «зелёной волны».`;
    case 'noparking': return `Вдоль ${of}${km} запрещена парковка. Эвакуаторы выходят на линию.`;
    case 'buslane': return `На ${at}${km} размечают выделенную полосу для автобусов.`;
    case 'removebus': return `С ${of} убирают выделенную полосу — её отдают машинам.`;
    case 'widen': return `Начато расширение ${of}${km}: +1 полоса в каждую сторону. Работы — ${STREET_TOOLS.widen.build} мес.`;
    default: return `Решение акимата: ${p.name}.`;
  }
}

function completed(p) {
  const at = streetPrep(p.name), of = streetGen(p.name);
  switch (p.type) {
    case 'reverse': return `Реверс на ${at} заработал: утром центральная полоса — в сторону пика.`;
    case 'oneway': return `Движение на ${at} теперь одностороннее. Первые дни навигаторы сходят с ума.`;
    case 'greenwave': return `«Зелёная волна» на ${at} запущена.`;
    case 'noparking': return `Обочины ${of} свободны: эвакуаторы увезли 140 машин за неделю.`;
    case 'buslane': return `Выделенка на ${at} открыта: автобусы идут по графику.`;
    case 'removebus': return `Выделенки на ${at} больше нет.`;
    case 'widen': return `Расширение ${of} закончено: строители сняли ограждения.`;
    case 'interchange': return `Открыта развязка: ${p.name}. Светофор больше не нужен.`;
    case 'gas': return `Газ пришёл в частный сектор: ${p.name}. Печей с углём всё меньше.`;
    case 'pnr': return `${cap(p.name)}: перехватывающая парковка открыта, экспрессы ходят каждые 7 минут.`;
    case 'rail': return `${cap(p.name)}: пошли пригородные электрички — меньше машин из области.`;
    case 'tpp': return 'ТЭЦ-2 работает на газе. Над городом стало заметно светлее.';
    case 'ebus': return 'Электробусы вышли на маршруты.';
    case 'lez': return 'Зона низких выбросов заработала: камеры следят за въездом в центр.';
    default: return `Мера завершена: ${p.name}.`;
  }
}

const cap = s => s.charAt(0).toUpperCase() + s.slice(1);

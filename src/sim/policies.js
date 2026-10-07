// Catalogue of the akim's measures and their effect on the network.
// Shared by the UI (names, prices, rules) and the traffic worker (link modifiers).

import { R_AM, R_MID, R_PM, CURB_PARKING_FACTOR, SIGNALIZED } from './params.js';

const M = 1e6;

export const STREET_TOOLS = {
  reverse: {
    name: 'Реверсивное движение', short: 'Реверс', icon: 'reverse',
    desc: 'Средняя полоса утром работает в сторону пикового потока, вечером — обратно. +1 полоса туда, где пробка.',
    costPerKm: 1.5 * M, upkeepPerKm: 0.012 * M, build: 2,
    rep: { scope: 'district', amount: -2, half: 2 },
    check(net, segs) {
      for (const s of segs) {
        const f = net.segLinks[2 * s], b = net.segLinks[2 * s + 1];
        if (f < 0 || b < 0) return 'Нужна улица с движением в обе стороны';
        if (net.lanes[f] - net.bus[f] < 2 || net.lanes[b] - net.bus[b] < 2) return 'Нужно минимум 2 полосы в каждую сторону';
      }
      return null;
    },
  },
  oneway: {
    name: 'Одностороннее движение', short: 'Односторонка', icon: 'oneway',
    desc: 'Все полосы — в одну сторону, светофоры проще. Пропускная способность растёт, но объезды удлиняются.',
    costPerKm: 0.6 * M, upkeepPerKm: 0, build: 1,
    rep: { scope: 'district', amount: -4, half: 3 },
    needsDirection: true,
    check(net, segs) {
      for (const s of segs) {
        if (net.segLinks[2 * s] < 0 || net.segLinks[2 * s + 1] < 0) return 'Улица уже односторонняя';
      }
      return null;
    },
  },
  greenwave: {
    name: 'Зелёная волна', short: 'Зелёная волна', icon: 'wave',
    desc: 'Адаптивные светофоры, скоординированные по всей улице: +15% пропускной способности, меньше остановок.',
    costPerKm: 1.2 * M, upkeepPerKm: 0.01 * M, build: 3,
    rep: { scope: 'district', amount: 1.5, half: 6 },
    check(net, segs) {
      if (!segs.some(s => { const l = net.segLinks[2 * s] >= 0 ? net.segLinks[2 * s] : net.segLinks[2 * s + 1]; return SIGNALIZED[net.cls[l]] && !net.isLink[l]; })) {
        return 'На этой дороге нет светофоров';
      }
      return null;
    },
  },
  noparking: {
    name: 'Запрет парковки у обочины', short: 'Без парковки', icon: 'noparking',
    desc: 'Эвакуаторы и камеры освобождают крайнюю полосу. Жителям и магазинам это не нравится.',
    costPerKm: 0.25 * M, upkeepPerKm: 0.015 * M, build: 1,
    rep: { scope: 'district', amount: -3, half: 6 },
    check(net, segs) {
      if (!segs.some(s => { const l = net.segLinks[2 * s] >= 0 ? net.segLinks[2 * s] : net.segLinks[2 * s + 1]; return net.parking[l]; })) {
        return 'Здесь и так нельзя парковаться';
      }
      return null;
    },
  },
  buslane: {
    name: 'Выделенная полоса', short: 'Выделенка', icon: 'bus',
    desc: 'Автобусы перестают стоять в пробке, часть жителей района пересаживается с машин. Но машинам — на полосу меньше.',
    costPerKm: 0.5 * M, upkeepPerKm: 0.008 * M, build: 2,
    rep: { scope: 'district', amount: -3, half: 4 },
    check(net, segs) {
      for (const s of segs) {
        for (const l of [net.segLinks[2 * s], net.segLinks[2 * s + 1]]) {
          if (l < 0) continue;
          if (net.bus[l] > 0) return 'Выделенная полоса уже есть';
          if (net.lanes[l] < 2) return 'Нужно минимум 2 полосы в каждую сторону';
        }
      }
      return null;
    },
  },
  removebus: {
    name: 'Отменить выделенку', short: 'Без выделенки', icon: 'busoff',
    desc: 'Полоса возвращается машинам. Пассажиры автобусов будут недовольны, часть пересядет на авто.',
    costPerKm: 0.15 * M, upkeepPerKm: 0, build: 1,
    rep: { scope: 'district', amount: -5, half: 8 },
    check(net, segs) {
      if (!segs.some(s => [net.segLinks[2 * s], net.segLinks[2 * s + 1]].some(l => l >= 0 && net.bus[l] > 0))) {
        return 'Здесь нет выделенной полосы';
      }
      return null;
    },
  },
  widen: {
    name: 'Расширение дороги', short: 'Расширение', icon: 'widen',
    desc: '+1 полоса в каждую сторону. Стройка 8 месяцев: пока идут работы, дорога сужается.',
    costPerKm: 6.5 * M, upkeepPerKm: 0.004 * M, build: 8,
    rep: { scope: 'district', amount: 3, half: 8 }, repBuild: -0.5,
    check(net, segs) {
      for (const s of segs) {
        for (const l of [net.segLinks[2 * s], net.segLinks[2 * s + 1]]) {
          if (l >= 0 && net.lanes[l] >= 5) return 'Дальше расширять некуда';
        }
      }
      return null;
    },
  },
};

export const NODE_TOOLS = {
  interchange: {
    name: 'Развязка', short: 'Развязка', icon: 'interchange',
    desc: 'Двухуровневая развязка вместо светофора: въезды на перекрёсток пропускают на 55% больше. Стройка 14 месяцев.',
    cost: 24 * M, upkeep: 0.03 * M, build: 14,
    rep: { scope: 'district', amount: 5, half: 10 }, repBuild: -0.7,
  },
};

export const SCHEDULE_TOOLS = {
  school: {
    name: 'Начало уроков в школах', short: 'Школы', icon: 'school', perDistrict: true,
    desc: 'Сдвиг первой смены разводит школьный и рабочий пик. Родители поначалу недовольны.',
    options: [7.5, 8, 8.5, 9, 9.5], def: 8, cost: 0.15 * M,
    repPerHour: -7, half: 5,
  },
  gov: {
    name: 'Рабочий день госучреждений', short: 'Госслужба', icon: 'gov',
    desc: 'Акиматы, ЦОНы и ведомства начинают раньше или позже бизнеса — пик размазывается.',
    options: [8, 8.5, 9, 9.5, 10], def: 9, cost: 0.1 * M,
    repPerHour: -3, half: 3,
  },
  uni: {
    name: 'Пары в вузах и колледжах', short: 'Вузы', icon: 'uni',
    desc: 'Студенты едут после основного часа пик.',
    options: [8, 8.5, 9, 9.5, 10, 11], def: 8.5, cost: 0.05 * M,
    repPerHour: -1.5, half: 3,
  },
  flex: {
    name: 'Гибкий график в бизнесе', short: 'Гибкий график', icon: 'flex',
    desc: 'Субсидии компаниям, которые переводят часть сотрудников на 8:00 и 10:00.',
    options: [0, 0.1, 0.2, 0.3], def: 0, cost: 0.2 * M, upkeepPerStep: 0.07 * M,
    labels: ['нет', '10%', '20%', '30%'], repPerStep: 1, half: 6,
  },
  remote: {
    name: 'Удалёнка по пятницам', short: 'Удалёнка', icon: 'remote',
    desc: 'Госслужащие работают из дома один день в неделю, бизнес получает рекомендации.',
    options: [0, 1], def: 0, cost: 0.3 * M, upkeepPerStep: 0.08 * M,
    labels: ['нет', 'да'], repPerStep: 2, half: 6,
  },
  freight: {
    name: 'Ночной завоз товаров', short: 'Ночной завоз', icon: 'truck',
    desc: 'Грузовикам — окно с 22:00 до 6:00. Магазины ворчат, днём на дорогах свободнее.',
    options: [0, 0.4, 0.7], def: 0, cost: 0.2 * M, upkeepPerStep: 0.04 * M,
    labels: ['нет', '40%', '70%'], repPerStep: -1.5, half: 4,
  },
  cameras: {
    name: 'Камеры фиксации нарушений', short: 'Камеры', icon: 'camera',
    desc: 'Штрафы за выезд на перекрёсток и парковку во втором ряду. Перекрёстки разгружаются, бюджет пополняется.',
    options: [0, 1], def: 0, cost: 2 * M, upkeepPerStep: -0.45 * M,
    labels: ['нет', 'да'], repPerStep: -2, half: 5,
  },
  toll: {
    name: 'Платный въезд в центр', short: 'Платный въезд', icon: 'toll',
    desc: 'Как в Лондоне и Стокгольме: въезд в Алмалинский и Медеуский районы в будни платный. Минус машины, плюс бюджет — и много недовольных.',
    options: [0, 1], def: 0, cost: 4 * M, upkeepPerStep: -0.9 * M,
    labels: ['нет', 'да'], repPerStep: -7, half: 8,
  },
  parking: {
    name: 'Платная парковка в центре', short: 'Платная парковка', icon: 'parking',
    desc: 'Алмалинский и Медеуский районы: часть водителей едет в центр на автобусе. Приносит доход в бюджет.',
    options: [0, 1], def: 0, cost: 0.8 * M, upkeepPerStep: -0.3 * M,
    labels: ['нет', 'да'], repPerStep: -5, half: 6,
  },
};

export const PARK_TOOL = {
  name: 'Разбить парк', short: 'Парк', icon: 'park',
  desc: 'Новый парк или сквер. Дешевле всего на пустырях; частные дома придётся выкупить, многоэтажки сносить нельзя.',
  sizes: [2, 6, 15, 30], perHa: 0.22 * M, house: 0.12 * M, small: 0.02 * M, other: 0.6 * M, build: 6,
};

export const GATE_TOOLS = {
  pnr: {
    name: 'Перехватывающая парковка', short: 'Парковка на въезде', icon: 'parking',
    desc: 'Парковка и автобусы-экспрессы на въезде в город: четверть водителей из области оставляет машину на окраине.',
    cost: 7 * M, upkeep: 0.06 * M, build: 4, effect: 0.75, rep: { scope: 'city', amount: 2, half: 6 },
  },
  rail: {
    name: 'Пригородная электричка', short: 'Электричка', icon: 'train',
    desc: 'Частые электрички из пригородов по этому направлению: машин на въезде становится заметно меньше.',
    cost: 26 * M, upkeep: 0.15 * M, build: 10, effect: 0.6, rep: { scope: 'city', amount: 4, half: 10 },
  },
};

export const AIR_TOOLS = {
  gas: {
    name: 'Газификация частного сектора', short: 'Газ в дома', icon: 'flame', perDistrict: true,
    desc: 'Подвести газ к частным домам, чтобы зимой не топили углём. Эффект — в районах с большим частным сектором.',
    base: 3 * M, perShare: 40 * M, build: 8, rep: { scope: 'district', amount: 5, half: 12 },
  },
  tpp: {
    name: 'Перевод ТЭЦ-2 на газ', short: 'ТЭЦ-2', icon: 'factory',
    desc: 'Главная угольная станция города переходит на газ. Дорого и долго, но это крупнейший источник смога.',
    cost: 45 * M, build: 18, rep: { scope: 'city', amount: 8, half: 14 },
  },
  ebus: {
    name: 'Электробусы', short: 'Электробусы', icon: 'bus',
    desc: '600 электробусов вместо дизельных: меньше выхлопа, часть водителей пересаживается.',
    cost: 12 * M, upkeep: 0.15 * M, build: 6, rep: { scope: 'city', amount: 3, half: 8 },
  },
  lez: {
    name: 'Зона низких выбросов', short: 'Эко-зона', icon: 'leaf',
    desc: 'Старые машины не пускают в центр (Алмалинский и Медеуский). Воздух чище, водители злятся.',
    cost: 3 * M, upkeep: 0.05 * M, build: 2, rep: { scope: 'city', amount: -5, half: 6 },
  },
};

export const CENTRAL_DISTRICTS = [1, 5]; // Алмалинский, Медеуский

/** Kilometres covered by a set of segments. */
export function segsKm(R, segs) {
  let m = 0;
  for (const s of segs) m += R.seg_len[s];
  return m / 1000;
}

export function streetCost(tool, km) {
  return { cost: Math.round(tool.costPerKm * Math.max(0.3, km) / 1e4) * 1e4, upkeep: Math.round(tool.upkeepPerKm * km / 1e3) * 1e3 };
}

/**
 * Translate active policies into per-link modifiers.
 * Returns { lanes: Float32Array(L*3), capMul, t0Mul, closed, originScale(K), destScale(K), modeShiftKm[8] }
 */
export function computeMods(net, policies, sched, K, zoneDistrict) {
  const L = net.links;
  const lanes = new Float32Array(L * 3);
  const capMul = new Float32Array(L).fill(1);
  const t0Mul = new Float32Array(L).fill(1);
  const closed = new Uint8Array(L);
  for (let l = 0; l < L; l++) {
    const base = Math.max(1, net.lanes[l] - net.bus[l]);
    lanes[l * 3] = lanes[l * 3 + 1] = lanes[l * 3 + 2] = net.seg[l] < 0 ? 1 : base;
    if (net.parking[l]) capMul[l] = CURB_PARKING_FACTOR;
  }
  const busKmByDistrict = new Float32Array(8);
  const addAll = (l, v) => { lanes[l * 3] += v; lanes[l * 3 + 1] += v; lanes[l * 3 + 2] += v; };
  for (const p of policies) {
    const active = p.status === 'active';
    const building = p.status === 'building';
    if (!active && !building) continue;
    const segs = p.segs || [];
    switch (p.type) {
      case 'reverse':
        if (!active) break;
        segs.forEach((s, i) => {
          const f = net.segLinks[2 * s], b = net.segLinks[2 * s + 1];
          if (f < 0 || b < 0) return;
          const am = p.amFwd[i] ? f : b, pm = am === f ? b : f;
          lanes[am * 3 + R_AM] += 1; lanes[pm * 3 + R_AM] -= 1;
          lanes[pm * 3 + R_PM] += 1; lanes[am * 3 + R_PM] -= 1;
        });
        break;
      case 'oneway':
        if (!active) break;
        segs.forEach((s, i) => {
          const f = net.segLinks[2 * s], b = net.segLinks[2 * s + 1];
          if (f < 0 || b < 0) return;
          const keep = p.fwd[i] ? f : b, drop = keep === f ? b : f;
          addAll(keep, Math.max(1, net.lanes[drop] - net.bus[drop]));
          capMul[keep] *= 1.1;
          closed[drop] = 1;
        });
        break;
      case 'greenwave':
        if (!active) break;
        for (const s of segs) for (const l of [net.segLinks[2 * s], net.segLinks[2 * s + 1]]) {
          if (l < 0 || !SIGNALIZED[net.cls[l]] || net.isLink[l]) continue;
          capMul[l] *= 1.15; t0Mul[l] *= 0.88;
        }
        break;
      case 'noparking':
        if (!active) break;
        for (const s of segs) for (const l of [net.segLinks[2 * s], net.segLinks[2 * s + 1]]) {
          if (l >= 0 && net.parking[l]) capMul[l] /= CURB_PARKING_FACTOR;
        }
        break;
      case 'buslane':
        if (!active) break;
        for (const s of segs) {
          for (const l of [net.segLinks[2 * s], net.segLinks[2 * s + 1]]) if (l >= 0) addAll(l, -1);
          const l0 = net.segLinks[2 * s] >= 0 ? net.segLinks[2 * s] : net.segLinks[2 * s + 1];
          const d = net.district[l0];
          if (d < 8) busKmByDistrict[d] += net.len[l0] / 1000;
        }
        break;
      case 'removebus':
        if (!active) break;
        for (const s of segs) {
          for (const l of [net.segLinks[2 * s], net.segLinks[2 * s + 1]]) if (l >= 0 && net.bus[l] > 0) addAll(l, net.bus[l]);
          const l0 = net.segLinks[2 * s] >= 0 ? net.segLinks[2 * s] : net.segLinks[2 * s + 1];
          const d = net.district[l0];
          if (d < 8) busKmByDistrict[d] -= net.len[l0] / 1000;
        }
        break;
      case 'widen':
        for (const s of segs) for (const l of [net.segLinks[2 * s], net.segLinks[2 * s + 1]]) {
          if (l < 0) continue;
          if (building) capMul[l] *= 0.65; else addAll(l, 1);
        }
        break;
      case 'interchange': {
        const seen = new Set();
        for (const v of p.nodes || [p.node]) {
          for (let e = net.firstIn[v]; e < net.firstIn[v + 1]; e++) {
            const l = net.inc[e];
            if (net.seg[l] < 0 || seen.has(l)) continue;
            seen.add(l);
            if (building) capMul[l] *= 0.6;
            else { capMul[l] *= 1.55; t0Mul[l] *= 0.8; }
          }
        }
        break;
      }
      default:
    }
  }
  for (let i = 0; i < L * 3; i++) if (lanes[i] < 0.5) lanes[i] = 0.5;
  // demand side: bus-lane mode shift by origin district, paid parking by destination
  const originScale = new Float32Array(K).fill(1);
  const destScale = new Float32Array(K).fill(1);
  // city entrances: park & ride / suburban rail cut car trips to and from that gate
  for (const p of policies) {
    if ((p.type !== 'pnr' && p.type !== 'rail') || p.status !== 'active' || p.gate == null) continue;
    const k = K - net.G + p.gate;
    const f = GATE_TOOLS[p.type].effect;
    originScale[k] *= f;
    destScale[k] *= f;
  }
  for (let k = 0; k < K; k++) {
    const d = zoneDistrict[k];
    if (d >= 8) continue;
    const shift = Math.max(-0.04, Math.min(0.09, busKmByDistrict[d] * 0.009));
    originScale[k] *= 1 - shift;
    if (sched.parking && CENTRAL_DISTRICTS.includes(d)) destScale[k] = 0.88;
    if (sched.lez && CENTRAL_DISTRICTS.includes(d)) destScale[k] *= 0.93;
    if (sched.toll && CENTRAL_DISTRICTS.includes(d)) destScale[k] *= 0.85;
  }
  return { lanes, capMul, t0Mul, closed, originScale, destScale, busKmByDistrict };
}

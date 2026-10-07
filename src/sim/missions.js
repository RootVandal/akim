// Campaign missions. Each one gives a budget, a goal and a reward that funds the next.

const pct = v => `${Math.round(v * 100)}%`;

export const MISSIONS = [
  {
    id: 'traffic',
    title: 'Город без пробок',
    kicker: 'Миссия 1',
    budget: 100e6,
    reward: 60e6,
    minMonths: 6,
    brief: 'Алматы стоит в пробках: утром все едут в центр одновременно — школы, офисы, госучреждения. ' +
      'Город растёт на 2% в год, машин становится больше. Разведите потоки по времени и пространству.',
    goals: [
      'Индекс пробок за 6 месяцев — не выше 30%',
      'В каждом из 8 районов — не выше 50%',
      'Репутация не должна упасть до нуля',
    ],
    tips: [
      'Кликните по улице, чтобы увидеть её загрузку по часам и доступные меры.',
      'Школы, госслужба и вузы, стартующие в одно время, — главный источник утреннего пика.',
      'Изменения работают не сразу: водители перестраивают маршруты несколько месяцев.',
    ],
    progress(game) {
      const r = game.rolling(6);
      const okCity = r.ci <= 0.30;
      const okD = r.ciD.filter(v => v <= 0.50).length;
      const since = game.s.month - game.s.missionStart + 1;
      return {
        done: okCity && okD === 8 && since >= 6,
        items: [
          { label: 'Индекс пробок за 6 мес.', value: pct(r.ci), target: '≤ 30%', ok: okCity, frac: clamp01((0.75 - r.ci) / 0.45) },
          { label: 'Районов в норме (≤ 50%)', value: `${okD} из 8`, target: '8 из 8', ok: okD === 8, frac: okD / 8 },
        ],
        ci: r.ci, ciD: r.ciD,
      };
    },
  },
  {
    id: 'green',
    title: 'Зелёная Алматы',
    kicker: 'Миссия 2',
    budget: 0,
    reward: 60e6,
    minMonths: 4,
    brief: 'Город-сад теряет зелень: на жителя приходится меньше 8 м² парков, а в спальных районах до ближайшего сквера — полчаса пешком. ' +
      'Разбейте новые парки и бульвары, не дав пробкам вернуться.',
    goals: [
      'Не меньше 9 м² парков на жителя',
      'В каждом районе 60% жителей живут в 10 минутах от парка',
      'Индекс пробок не выше 40%',
    ],
    tips: [
      'Новые парки дешевле разбивать на пустырях и промзонах.',
      'Снос частных домов под парк — дорого и бьёт по репутации района.',
    ],
    progress(game) {
      const g = game.green ? game.green() : null;
      const r = game.rolling(6);
      if (!g) return { done: false, items: [] };
      const okA = g.perCapita >= 9;
      const okB = g.access.filter(v => v >= 0.6).length;
      const okC = r.ci <= 0.4;
      return {
        done: okA && okB === 8 && okC,
        items: [
          { label: 'Парков на жителя', value: `${g.perCapita.toFixed(1).replace('.', ',')} м²`, target: '≥ 9 м²', ok: okA, frac: clamp01(g.perCapita / 9) },
          { label: 'Районов с парком рядом', value: `${okB} из 8`, target: '8 из 8', ok: okB === 8, frac: okB / 8 },
          { label: 'Индекс пробок за 6 мес.', value: pct(r.ci), target: '≤ 40%', ok: okC, frac: clamp01((0.8 - r.ci) / 0.4) },
        ],
      };
    },
  },
  {
    id: 'air',
    title: 'Чистый воздух',
    kicker: 'Миссия 3',
    budget: 0,
    reward: 0,
    minMonths: 4,
    brief: 'Зимой над Алматы висит смог: печи частного сектора, угольная ТЭЦ-2 и выхлопы. ' +
      'Горы не дают ему уйти. Сделайте так, чтобы зимний воздух стал чистым.',
    goals: [
      'Прогноз зимнего индекса качества воздуха (AQI) — не выше 110',
      'Индекс пробок не выше 40%',
    ],
    tips: [
      'Газификация частного сектора — самый быстрый эффект.',
      'Перевод ТЭЦ-2 на газ — дорого и долго, но это главный источник.',
    ],
    progress(game) {
      const a = game.air ? game.air() : null;
      const r = game.rolling(6);
      if (!a) return { done: false, items: [] };
      const okA = a.winterAqi <= 110;
      const okC = r.ci <= 0.4;
      return {
        done: okA && okC,
        items: [
          { label: 'Зимний AQI', value: String(Math.round(a.winterAqi)), target: '≤ 110', ok: okA, frac: clamp01((200 - a.winterAqi) / 90) },
          { label: 'Индекс пробок за 6 мес.', value: pct(r.ci), target: '≤ 40%', ok: okC, frac: clamp01((0.8 - r.ci) / 0.4) },
        ],
      };
    },
  },
];

function clamp01(v) { return Math.max(0, Math.min(1, v)); }

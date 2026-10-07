// Russian case forms for district and street names used in the news feed.

export const distGen = n => n.replace(/ий$/, 'ого');   // Алмалинского (района)
export const distPrep = n => n.replace(/ий$/, 'ом');   // в Алмалинском (районе)

const GENERIC = {
  'улица': ['улице', 'улицы'], 'проспект': ['проспекте', 'проспекта'], 'переулок': ['переулке', 'переулка'],
  'бульвар': ['бульваре', 'бульвара'], 'шоссе': ['шоссе', 'шоссе'], 'трасса': ['трассе', 'трассы'],
  'дорога': ['дороге', 'дороги'], 'площадь': ['площади', 'площади'], 'набережная': ['набережной', 'набережной'],
  'тракт': ['тракте', 'тракта'], 'кольцо': ['кольце', 'кольца'], 'микрорайон': ['микрорайоне', 'микрорайона'],
  'путепровод': ['путепроводе', 'путепровода'], 'мост': ['мосту', 'моста'], 'объездная': ['объездной', 'объездной'],
};

function adj(word, c) {
  // c: 0 = prepositional, 1 = genitive
  const rules = [
    [/(ий|ый)$/, ['ом', 'ого']], [/ой$/, ['ом', 'ого']], [/ая$/, ['ой', 'ой']], [/яя$/, ['ей', 'ей']],
    [/ое$/, ['ом', 'ого']], [/ее$/, ['ем', 'его']],
  ];
  for (const [re, f] of rules) if (re.test(word)) return word.replace(re, f[c]);
  return word;
}

function decline(name, c) {
  if (!name) return c ? 'безымянной дороги' : 'безымянной дороге';
  const words = name.split(' ');
  const first = words[0].toLowerCase();
  if (GENERIC[first]) return [GENERIC[first][c], ...words.slice(1)].join(' ');
  const lastIdx = words.length - 1;
  const last = words[lastIdx].toLowerCase();
  if (GENERIC[last]) {
    const out = words.map((w, i) => (i < lastIdx ? adj(w, c) : GENERIC[last][c]));
    return out.join(' ');
  }
  return `«${name}»`;
}

export const streetPrep = name => decline(name, 0);  // на проспекте Абая
export const streetGen = name => decline(name, 1);   // вдоль проспекта Абая

export function streetLabel(name) {
  return name || 'Безымянная дорога';
}

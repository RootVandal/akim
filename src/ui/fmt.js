// Formatting helpers and colour scales shared by the UI.

export const pct = v => `${Math.round(v * 100)}%`;
export const num = v => Math.round(v).toLocaleString('ru-RU');
export const km = v => `${v.toFixed(v < 10 ? 1 : 0).replace('.', ',')} км`;

export function money(v, short = true) {
  const s = v < 0 ? '−' : '';
  v = Math.abs(v);
  if (!short) return `${s}${Math.round(v).toLocaleString('ru-RU')} ₸`;
  if (v >= 1e9) return `${s}${(v / 1e9).toFixed(1).replace('.', ',')} млрд ₸`;
  if (v >= 1e6) return `${s}${(v / 1e6).toFixed(v >= 1e8 ? 0 : 1).replace('.', ',')} млн ₸`;
  if (v >= 1e3) return `${s}${Math.round(v / 1e3)} тыс ₸`;
  return `${s}${Math.round(v)} ₸`;
}

/** Congestion index (0.3 = +30 %) -> CSS colour, same ramp as the map. */
export function ciColor(ci) {
  const r = 1 + Math.max(0, ci);
  const stops = [[1.0, [51, 209, 115]], [1.25, [255, 214, 46]], [1.7, [255, 128, 31]], [2.5, [242, 38, 33]], [4.0, [127, 10, 16]]];
  for (let i = 1; i < stops.length; i++) {
    if (r <= stops[i][0]) {
      const [a, ca] = stops[i - 1], [b, cb] = stops[i];
      const t = (r - a) / (b - a);
      const c = ca.map((v, k) => Math.round(v + (cb[k] - v) * t));
      return `rgb(${c[0]},${c[1]},${c[2]})`;
    }
  }
  return 'rgb(127,10,16)';
}

export function moodColor(m) {
  if (m >= 60) return '#37d483';
  if (m >= 40) return '#c8d64a';
  if (m >= 25) return '#ffb43c';
  return '#ff5a4c';
}

export function el(tag, cls, html) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (html != null) e.innerHTML = html;
  return e;
}

export const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

export const ICONS = {
  reverse: '<svg viewBox="0 0 24 24"><path d="M4 8h14l-3-3M20 16H6l3 3"/></svg>',
  oneway: '<svg viewBox="0 0 24 24"><path d="M4 12h15M14 7l5 5-5 5"/></svg>',
  wave: '<svg viewBox="0 0 24 24"><rect x="8" y="2.5" width="8" height="19" rx="3"/><circle cx="12" cy="7" r="1.6"/><circle cx="12" cy="12" r="1.6"/><circle cx="12" cy="17" r="1.6"/></svg>',
  noparking: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><path d="M9.5 16.5v-9h3.2a2.6 2.6 0 0 1 0 5.2H9.5M5.6 5.6l12.8 12.8"/></svg>',
  bus: '<svg viewBox="0 0 24 24"><rect x="5" y="3" width="14" height="15" rx="3"/><path d="M5 11h14M8 18v2M16 18v2"/><circle cx="8.5" cy="14.5" r=".8"/><circle cx="15.5" cy="14.5" r=".8"/></svg>',
  busoff: '<svg viewBox="0 0 24 24"><rect x="5" y="3" width="14" height="15" rx="3"/><path d="M5 11h14M3 3l18 18"/></svg>',
  widen: '<svg viewBox="0 0 24 24"><path d="M3 4v16M21 4v16M9 6v3M9 15v3M15 6v3M15 15v3M7 12H3m14 0h4"/></svg>',
  interchange: '<svg viewBox="0 0 24 24"><path d="M12 2v20M2 12h20"/><path d="M12 7a5 5 0 1 1-5 5"/></svg>',
  school: '<svg viewBox="0 0 24 24"><path d="M3 9l9-5 9 5-9 5z"/><path d="M7 11.5V16c2.5 2 7.5 2 10 0v-4.5"/></svg>',
  gov: '<svg viewBox="0 0 24 24"><path d="M3 21h18M5 21V10M19 21V10M9 21V10M15 21V10M2 10l10-6 10 6z"/></svg>',
  uni: '<svg viewBox="0 0 24 24"><path d="M4 19V6a2 2 0 0 1 2-2h12v15H6a2 2 0 0 0-2 2zM8 8h6"/></svg>',
  flex: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l-3 3M12 12l3.5-2"/></svg>',
  remote: '<svg viewBox="0 0 24 24"><rect x="3" y="5" width="18" height="11" rx="2"/><path d="M8 20h8M12 16v4"/></svg>',
  truck: '<svg viewBox="0 0 24 24"><path d="M2 6h12v10H2zM14 10h4l3 3v3h-7"/><circle cx="6" cy="17" r="1.8"/><circle cx="17" cy="17" r="1.8"/></svg>',
  parking: '<svg viewBox="0 0 24 24"><rect x="4" y="3" width="16" height="18" rx="3"/><path d="M10 17V7h3a3 3 0 0 1 0 6h-3"/></svg>',
  park: '<svg viewBox="0 0 24 24"><path d="M12 21v-6M7 15h10l-5-11z"/><path d="M5 21h14"/></svg>',
  train: '<svg viewBox="0 0 24 24"><rect x="6" y="3" width="12" height="14" rx="3"/><path d="M6 11h12M9 21l1.5-4M15 21l-1.5-4"/><circle cx="9.5" cy="14" r=".8"/><circle cx="14.5" cy="14" r=".8"/></svg>',
  flame: '<svg viewBox="0 0 24 24"><path d="M12 3c1 4 5 5 5 10a5 5 0 0 1-10 0c0-3 2-4 2-6 2 1 3 2 3 4 1-2 1-5 0-8z"/></svg>',
  factory: '<svg viewBox="0 0 24 24"><path d="M3 21V11l5 3v-3l5 3V5h4v16zM3 21h18"/></svg>',
  leaf: '<svg viewBox="0 0 24 24"><path d="M5 19c0-9 6-14 15-14 0 9-5 15-14 15M5 19l7-7"/></svg>',
};

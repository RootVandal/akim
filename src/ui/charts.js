// Small canvas charts: the 24 h congestion strip and line charts in panels.

import { ciColor } from './fmt.js';

function fit(canvas) {
  const r = canvas.getBoundingClientRect();
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const w = Math.max(10, Math.round(r.width * dpr)), h = Math.max(10, Math.round(r.height * dpr));
  if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; }
  return { w, h, dpr };
}

/** 48 half-hour bars: height = traffic volume, colour = congestion. */
export function drawDay(canvas, slotCI, slotVol, opts = {}) {
  const { w, h, dpr } = fit(canvas);
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, w, h);
  const padB = 16 * dpr;
  const H = h - padB;
  let vmax = 1;
  for (let s = 0; s < 48; s++) vmax = Math.max(vmax, slotVol[s]);
  const bw = w / 48;
  for (let s = 0; s < 48; s++) {
    const bh = Math.max(2 * dpr, (slotVol[s] / vmax) * (H - 4 * dpr));
    ctx.fillStyle = ciColor(slotCI[s]);
    ctx.globalAlpha = 0.92;
    const x = s * bw + bw * 0.12, y = H - bh;
    const rw = bw * 0.76;
    ctx.beginPath();
    ctx.roundRect ? ctx.roundRect(x, y, rw, bh, Math.min(3 * dpr, rw / 2)) : ctx.rect(x, y, rw, bh);
    ctx.fill();
  }
  if (opts.ghost) {
    // previous profile as an outline (e.g. before a schedule change)
    ctx.globalAlpha = 0.6;
    ctx.strokeStyle = 'rgba(255,255,255,0.55)';
    ctx.lineWidth = 1.2 * dpr;
    ctx.beginPath();
    for (let s = 0; s < 48; s++) {
      const y = H - (opts.ghost[s] / vmax) * (H - 4 * dpr);
      if (s === 0) ctx.moveTo((s + 0.5) * bw, y); else ctx.lineTo((s + 0.5) * bw, y);
    }
    ctx.stroke();
  }
  ctx.globalAlpha = 1;
  ctx.fillStyle = 'rgba(160,175,195,0.75)';
  ctx.font = `${10.5 * dpr}px Onest, sans-serif`;
  ctx.textAlign = 'center';
  for (let hr = 0; hr <= 24; hr += 3) ctx.fillText(`${String(hr % 24).padStart(2, '0')}:00`, Math.min(w - 16 * dpr, Math.max(16 * dpr, (hr / 24) * w)), h - 3 * dpr);
}

/** Line chart of several series over 48 slots (ratio values) with an hour marker. */
export function drawLines(canvas, series, hour, opts = {}) {
  const { w, h, dpr } = fit(canvas);
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, w, h);
  const padL = 30 * dpr, padB = 16 * dpr, padT = 6 * dpr;
  const W = w - padL, H = h - padB - padT;
  let ymax = opts.ymax || 1.0;
  for (const s of series) for (const v of s.data) ymax = Math.max(ymax, v);
  ymax = Math.ceil(ymax * 4) / 4;
  ctx.strokeStyle = 'rgba(255,255,255,0.07)';
  ctx.fillStyle = 'rgba(150,165,185,0.8)';
  ctx.font = `${10 * dpr}px Onest, sans-serif`;
  ctx.lineWidth = 1;
  const steps = 4;
  for (let i = 0; i <= steps; i++) {
    const v = (ymax * i) / steps;
    const y = padT + H - (v / ymax) * H;
    ctx.beginPath(); ctx.moveTo(padL, y); ctx.lineTo(w, y); ctx.stroke();
    ctx.textAlign = 'right';
    ctx.fillText(opts.fmtY ? opts.fmtY(v) : v.toFixed(1), padL - 5 * dpr, y + 3 * dpr);
  }
  ctx.textAlign = 'center';
  for (let hr = 0; hr <= 24; hr += 6) ctx.fillText(`${hr}:00`, padL + (hr / 24) * W, h - 3 * dpr);
  // hour marker
  const hx = padL + (hour / 24) * W;
  ctx.strokeStyle = 'rgba(246,196,71,0.9)';
  ctx.lineWidth = 1.5 * dpr;
  ctx.beginPath(); ctx.moveTo(hx, padT); ctx.lineTo(hx, padT + H); ctx.stroke();
  for (const s of series) {
    ctx.strokeStyle = s.color;
    ctx.lineWidth = 2 * dpr;
    ctx.beginPath();
    s.data.forEach((v, i) => {
      const x = padL + ((i + 0.5) / 48) * W, y = padT + H - (v / ymax) * H;
      if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    });
    ctx.stroke();
    if (s.fill) {
      ctx.lineTo(padL + W, padT + H); ctx.lineTo(padL, padT + H); ctx.closePath();
      ctx.fillStyle = s.fill; ctx.fill();
    }
  }
}

/** Monthly history sparkline (values in 0..x) with an optional target line. */
export function drawHistory(canvas, values, target, opts = {}) {
  const { w, h, dpr } = fit(canvas);
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, w, h);
  if (values.length < 2) return;
  const padB = 4 * dpr, padT = 6 * dpr;
  let ymax = Math.max(target * 1.4, ...values) * 1.05;
  const H = h - padB - padT;
  const X = i => (i / (values.length - 1)) * w;
  const Y = v => padT + H - (v / ymax) * H;
  ctx.strokeStyle = 'rgba(246,196,71,0.75)';
  ctx.setLineDash([4 * dpr, 4 * dpr]);
  ctx.beginPath(); ctx.moveTo(0, Y(target)); ctx.lineTo(w, Y(target)); ctx.stroke();
  ctx.setLineDash([]);
  const g = ctx.createLinearGradient(0, 0, 0, h);
  g.addColorStop(0, 'rgba(46,197,230,0.35)'); g.addColorStop(1, 'rgba(46,197,230,0)');
  ctx.beginPath();
  values.forEach((v, i) => (i ? ctx.lineTo(X(i), Y(v)) : ctx.moveTo(X(i), Y(v))));
  ctx.lineTo(w, h); ctx.lineTo(0, h); ctx.closePath();
  ctx.fillStyle = g; ctx.fill();
  ctx.strokeStyle = opts.color || '#2ec5e6';
  ctx.lineWidth = 2 * dpr;
  ctx.beginPath();
  values.forEach((v, i) => (i ? ctx.lineTo(X(i), Y(v)) : ctx.moveTo(X(i), Y(v))));
  ctx.stroke();
}

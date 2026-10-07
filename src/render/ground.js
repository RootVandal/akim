// Paints the city ground (landuse, parks, water, rail) into one large canvas texture.

import * as THREE from 'three';
import { decodeLines } from '../data/loader.js';

// sRGB colours per area class (see AREA_CLASSES in build_data.py)
export const AREA_COLORS = {
  park: '#557f45', forest: '#47693d', grass: '#7f9a5c', water: '#4f86a3', cemetery: '#86926f',
  industrial: '#9b968e', residential: '#aaa292', commercial: '#ae9f92', construction: '#b9a782',
  farmland: '#9f9d66', sport: '#5f8f4f', education: '#b0a690', hospital: '#b1a39b', rock: '#857e74', glacier: '#e6ecf0',
};
const ORDER = ['farmland', 'residential', 'commercial', 'industrial', 'education', 'hospital', 'cemetery',
  'construction', 'grass', 'forest', 'rock', 'glacier', 'park', 'sport', 'water'];

export class GroundPainter {
  constructor(data, quality) {
    const meta = data.meta;
    this.meta = meta;
    const city = meta.city;
    let x0 = Infinity, z0 = Infinity, x1 = -Infinity, z1 = -Infinity;
    for (const [x, z] of city) { x0 = Math.min(x0, x); z0 = Math.min(z0, z); x1 = Math.max(x1, x); z1 = Math.max(z1, z); }
    const M = 2500;
    this.bounds = { x0: x0 - M, z0: z0 - M, w: (x1 - x0) + 2 * M, h: (z1 - z0) + 2 * M };
    const size = quality === 'high' ? 6144 : 4096;
    this.size = size;
    this.scaleX = size / this.bounds.w;
    this.scaleZ = size / this.bounds.h;
    this.canvas = document.createElement('canvas');
    this.canvas.width = size; this.canvas.height = size;
    this.ctx = this.canvas.getContext('2d');
    this.areas = decodeLines(data.areas);
    this.water = decodeLines(data.areas, 'water_');
    this.rail = decodeLines(data.areas, 'rail_');
    this.classes = meta.areas.classes;
    this.extraParks = [];
    this.texture = new THREE.CanvasTexture(this.canvas);
    this.texture.colorSpace = THREE.SRGBColorSpace;
    this.texture.anisotropy = 8;
    this.texture.generateMipmaps = true;
    this.texture.minFilter = THREE.LinearMipmapLinearFilter;
    this.paint();
  }

  px(x, z) { return [(x - this.bounds.x0) * this.scaleX, (z - this.bounds.z0) * this.scaleZ]; }

  pathPoly(xz, a, b) {
    const ctx = this.ctx;
    ctx.beginPath();
    for (let i = a; i < b; i++) {
      const [px, pz] = this.px(xz[2 * i], xz[2 * i + 1]);
      if (i === a) ctx.moveTo(px, pz); else ctx.lineTo(px, pz);
    }
    ctx.closePath();
  }

  paint() {
    const ctx = this.ctx;
    const s = this.size;
    ctx.clearRect(0, 0, s, s);
    // feathered urban base inside the city boundary
    ctx.save();
    ctx.filter = `blur(${Math.round(s / 900)}px)`;
    ctx.fillStyle = 'rgba(160,152,138,0.92)';
    ctx.beginPath();
    this.meta.city.forEach(([x, z], i) => { const [px, pz] = this.px(x, z); if (i) ctx.lineTo(px, pz); else ctx.moveTo(px, pz); });
    ctx.closePath();
    ctx.fill();
    ctx.restore();
    // landuse by class order
    const A = this.areas;
    const byClass = new Map();
    for (let i = 0; i < A.count; i++) {
      const k = this.classes[A.kind[i]];
      if (!byClass.has(k)) byClass.set(k, []);
      byClass.get(k).push(i);
    }
    for (const k of ORDER) {
      const list = byClass.get(k);
      if (!list) continue;
      const col = AREA_COLORS[k];
      ctx.fillStyle = col;
      ctx.globalAlpha = k === 'residential' || k === 'commercial' ? 0.75 : k === 'farmland' ? 0.8 : 0.95;
      for (const i of list) {
        if (A.start[i + 1] - A.start[i] < 3) continue;
        this.pathPoly(A.xz, A.start[i], A.start[i + 1]);
        ctx.fill();
      }
    }
    ctx.globalAlpha = 1;
    for (const p of this.extraParks) this.paintPark(p);
    // rivers and canals
    const W = this.water;
    ctx.strokeStyle = AREA_COLORS.water;
    ctx.lineCap = 'round'; ctx.lineJoin = 'round';
    for (let i = 0; i < W.count; i++) {
      const wm = [16, 8, 4][W.kind[i]] || 4;
      ctx.lineWidth = Math.max(1, wm * this.scaleX);
      ctx.beginPath();
      for (let k = W.start[i]; k < W.start[i + 1]; k++) {
        const [px, pz] = this.px(W.xz[2 * k], W.xz[2 * k + 1]);
        if (k === W.start[i]) ctx.moveTo(px, pz); else ctx.lineTo(px, pz);
      }
      ctx.stroke();
    }
    // railways
    const R = this.rail;
    for (let i = 0; i < R.count; i++) {
      ctx.strokeStyle = R.kind[i] ? 'rgba(90,86,80,0.8)' : 'rgba(78,72,66,0.85)';
      ctx.lineWidth = Math.max(1, (R.kind[i] ? 3 : 5) * this.scaleX);
      ctx.beginPath();
      for (let k = R.start[i]; k < R.start[i + 1]; k++) {
        const [px, pz] = this.px(R.xz[2 * k], R.xz[2 * k + 1]);
        if (k === R.start[i]) ctx.moveTo(px, pz); else ctx.lineTo(px, pz);
      }
      ctx.stroke();
    }
    this.texture.needsUpdate = true;
  }

  /** New park created by the player (circle or polygon in metres). */
  paintPark(p) {
    const ctx = this.ctx;
    ctx.fillStyle = AREA_COLORS.park;
    ctx.beginPath();
    p.poly.forEach(([x, z], i) => { const [px, pz] = this.px(x, z); if (i) ctx.lineTo(px, pz); else ctx.moveTo(px, pz); });
    ctx.closePath();
    ctx.fill();
    // paths
    ctx.strokeStyle = 'rgba(200,190,160,0.6)';
    ctx.lineWidth = Math.max(1, 3 * this.scaleX);
    const [cx, cz] = this.px(p.x, p.z);
    ctx.beginPath();
    ctx.arc(cx, cz, p.r * this.scaleX * 0.55, 0, Math.PI * 2);
    ctx.stroke();
  }

  addPark(p) {
    this.extraParks.push(p);
    this.paintPark(p);
    this.texture.needsUpdate = true;
  }
}

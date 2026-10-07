// HTML labels anchored to world positions (districts, landmarks, junction markers).

import * as THREE from 'three';

export class Labels {
  constructor(root, camera) {
    this.root = root;
    this.camera = camera;
    this.items = [];
    this.v = new THREE.Vector3();
    this.fwd = new THREE.Vector3();
  }

  /** `el` keeps its own CSS centring; a wrapper carries the screen position. */
  add(el, x, y, z, opts = {}) {
    const wrap = document.createElement('div');
    wrap.className = 'lbl3';
    wrap.appendChild(el);
    this.root.appendChild(wrap);
    const item = {
      el: wrap, inner: el, p: new THREE.Vector3(x, y, z),
      minDist: opts.minDist ?? 0, maxDist: opts.maxDist ?? Infinity, group: opts.group || 'default', visible: true,
    };
    this.items.push(item);
    return item;
  }

  remove(item) {
    item.el.remove();
    this.items = this.items.filter(i => i !== item);
  }

  removeGroup(g) {
    for (const i of this.items) if (i.group === g) i.el.remove();
    this.items = this.items.filter(i => i.group !== g);
  }

  setGroupVisible(g, v) { for (const i of this.items) if (i.group === g) i.visible = v; }

  update(w, h) {
    const cam = this.camera;
    const v = this.v;
    cam.getWorldDirection(this.fwd);
    for (const it of this.items) {
      const d = cam.position.distanceTo(it.p);
      let show = it.visible && d >= it.minDist && d <= it.maxDist;
      if (show) {
        v.copy(it.p).sub(cam.position);
        if (v.dot(this.fwd) <= 1) show = false;
      }
      if (show) {
        v.copy(it.p).project(cam);
        if (Math.abs(v.x) > 1.15 || Math.abs(v.y) > 1.15) show = false;
      }
      if (!show) { if (it.shown !== false) { it.el.style.display = 'none'; it.shown = false; } continue; }
      if (it.shown !== true) { it.el.style.display = ''; it.shown = true; }
      const x = (v.x * 0.5 + 0.5) * w, y = (-v.y * 0.5 + 0.5) * h;
      it.el.style.transform = `translate(${x.toFixed(1)}px, ${y.toFixed(1)}px)`;
    }
  }
}

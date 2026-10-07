// City-builder camera: grab-pan, orbit, zoom to cursor, keyboard, smooth fly-to.

import * as THREE from 'three';

export class CityCamera {
  constructor(camera, dom, hf) {
    this.camera = camera;
    this.dom = dom;
    this.hf = hf;
    // current and goal state
    this.cur = { x: 0, z: 0, dist: 9000, yaw: 0.35, pitch: 0.75 };
    this.goal = { ...this.cur };
    this.limits = { minDist: 90, maxDist: 60000, minPitch: 0.2, maxPitch: 1.5 };
    this.keys = new Set();
    this.drag = null;
    this.tween = null;
    this.enabled = true;
    this.onHover = null;
    this.onClick = null;
    this.ray = new THREE.Raycaster();
    this._v = new THREE.Vector3();
    this.bind();
  }

  bind() {
    const d = this.dom;
    d.addEventListener('contextmenu', e => e.preventDefault());
    d.addEventListener('pointerdown', e => this.down(e));
    window.addEventListener('pointermove', e => this.move(e));
    window.addEventListener('pointerup', e => this.up(e));
    d.addEventListener('wheel', e => this.wheel(e), { passive: false });
    window.addEventListener('keydown', e => {
      if (e.target && (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA')) return;
      this.keys.add(e.code);
    });
    window.addEventListener('keyup', e => this.keys.delete(e.code));
    window.addEventListener('blur', () => this.keys.clear());
    // touch: pinch
    this.touches = new Map();
  }

  ndc(e) {
    const r = this.dom.getBoundingClientRect();
    return new THREE.Vector2(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
  }

  /** Ground point under a screen position (height field, or the target plane as fallback). */
  groundAt(ndc, planeY = null) {
    this.ray.setFromCamera(ndc, this.camera);
    const o = this.ray.ray.origin, dir = this.ray.ray.direction;
    if (planeY == null) {
      const hit = this.hf.raycast(o, dir);
      if (hit) return hit;
      planeY = this.hf.height(this.cur.x, this.cur.z);
    }
    if (Math.abs(dir.y) < 1e-4) return null;
    const t = (planeY - o.y) / dir.y;
    if (t < 0) return null;
    return o.clone().addScaledVector(dir, t);
  }

  down(e) {
    if (!this.enabled) return;
    this.dom.setPointerCapture?.(e.pointerId);
    this.touches.set(e.pointerId, { x: e.clientX, y: e.clientY });
    const rotate = e.button === 2 || e.button === 1 || e.ctrlKey || e.altKey || this.touches.size === 2;
    const n = this.ndc(e);
    const planeY = this.hf.height(this.cur.x, this.cur.z);
    this.drag = {
      mode: rotate ? 'rotate' : 'pan', x: e.clientX, y: e.clientY, sx: e.clientX, sy: e.clientY,
      planeY, start: this.groundAt(n, planeY), moved: false, t: performance.now(),
      pinch: this.touches.size === 2 ? this.pinchDist() : 0,
    };
    this.tween = null;
  }

  pinchDist() {
    const a = [...this.touches.values()];
    return a.length < 2 ? 0 : Math.hypot(a[0].x - a[1].x, a[0].y - a[1].y);
  }

  move(e) {
    if (this.touches.has(e.pointerId)) this.touches.set(e.pointerId, { x: e.clientX, y: e.clientY });
    const dr = this.drag;
    if (!dr) {
      if (this.onHover && e.target === this.dom) this.onHover(e);
      return;
    }
    const dx = e.clientX - dr.x, dy = e.clientY - dr.y;
    dr.x = e.clientX; dr.y = e.clientY;
    if (Math.hypot(e.clientX - dr.sx, e.clientY - dr.sy) > 4) dr.moved = true;
    if (dr.pinch && this.touches.size === 2) {
      const pd = this.pinchDist();
      if (pd > 0) { this.goal.dist = this.clampDist(this.goal.dist * dr.pinch / pd); dr.pinch = pd; }
    }
    if (dr.mode === 'rotate') {
      this.goal.yaw -= dx * 0.005;
      this.goal.pitch = THREE.MathUtils.clamp(this.goal.pitch + dy * 0.004, this.limits.minPitch, this.limits.maxPitch);
    } else if (dr.start) {
      // keep the grabbed ground point under the cursor (evaluate with the current camera)
      const p = this.groundAt(this.ndc(e), dr.planeY);
      if (p) {
        this.goal.x += dr.start.x - p.x;
        this.goal.z += dr.start.z - p.z;
        this.cur.x = this.goal.x; this.cur.z = this.goal.z;
        this.apply();
      }
    }
  }

  up(e) {
    this.touches.delete(e.pointerId);
    const dr = this.drag;
    this.drag = null;
    if (dr && !dr.moved && e.button === 0 && this.onClick && performance.now() - dr.t < 600) this.onClick(e);
  }

  wheel(e) {
    if (!this.enabled) return;
    e.preventDefault();
    const k = Math.exp(Math.sign(e.deltaY) * Math.min(Math.abs(e.deltaY), 120) * 0.0016);
    const nd = this.clampDist(this.goal.dist * k);
    const p = this.groundAt(this.ndc(e));
    if (p) {
      const f = 1 - nd / this.goal.dist;
      this.goal.x += (p.x - this.goal.x) * f;
      this.goal.z += (p.z - this.goal.z) * f;
    }
    this.goal.dist = nd;
    this.tween = null;
  }

  clampDist(d) { return THREE.MathUtils.clamp(d, this.limits.minDist, this.limits.maxDist); }

  flyTo(target, ms = 2200) {
    const from = { ...this.cur };
    const to = { ...this.cur, ...target };
    // shortest yaw
    let dy = to.yaw - from.yaw;
    dy = Math.atan2(Math.sin(dy), Math.cos(dy));
    to.yaw = from.yaw + dy;
    this.tween = { from, to, t0: performance.now(), ms };
  }

  update(dt) {
    const g = this.goal;
    // keyboard
    const speed = this.cur.dist * 0.9 * dt;
    const fx = -Math.sin(this.cur.yaw), fz = -Math.cos(this.cur.yaw);
    const rx = Math.cos(this.cur.yaw), rz = -Math.sin(this.cur.yaw);
    const K = this.keys;
    if (this.enabled && K.size) {
      if (K.has('KeyW') || K.has('ArrowUp')) { g.x += fx * speed; g.z += fz * speed; }
      if (K.has('KeyS') || K.has('ArrowDown')) { g.x -= fx * speed; g.z -= fz * speed; }
      if (K.has('KeyD') || K.has('ArrowRight')) { g.x += rx * speed; g.z += rz * speed; }
      if (K.has('KeyA') || K.has('ArrowLeft')) { g.x -= rx * speed; g.z -= rz * speed; }
      if (K.has('KeyQ')) g.yaw += 1.2 * dt;
      if (K.has('KeyE')) g.yaw -= 1.2 * dt;
      if (K.has('KeyR')) g.pitch = Math.min(this.limits.maxPitch, g.pitch + 0.8 * dt);
      if (K.has('KeyF')) g.pitch = Math.max(this.limits.minPitch, g.pitch - 0.8 * dt);
      if (K.has('Equal') || K.has('NumpadAdd')) g.dist = this.clampDist(g.dist * (1 - 1.5 * dt));
      if (K.has('Minus') || K.has('NumpadSubtract')) g.dist = this.clampDist(g.dist * (1 + 1.5 * dt));
      this.tween = null;
    }
    // bounds
    const hf = this.hf;
    g.x = THREE.MathUtils.clamp(g.x, hf.x0 + 2000, hf.x1 - 2000);
    g.z = THREE.MathUtils.clamp(g.z, hf.z0 + 2000, hf.z1 - 2000);
    if (this.tween) {
      const tw = this.tween;
      let t = (performance.now() - tw.t0) / tw.ms;
      if (t >= 1) { t = 1; this.tween = null; }
      const e = t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
      // zoom out a little in the middle of long flights
      const span = Math.hypot(tw.to.x - tw.from.x, tw.to.z - tw.from.z);
      const hop = Math.sin(Math.PI * e) * Math.min(span * 0.6, 12000);
      for (const k of ['x', 'z', 'yaw', 'pitch']) this.cur[k] = tw.from[k] + (tw.to[k] - tw.from[k]) * e;
      this.cur.dist = Math.exp(Math.log(tw.from.dist) + (Math.log(tw.to.dist) - Math.log(tw.from.dist)) * e) + hop;
      Object.assign(g, this.cur);
      g.dist = tw.to.dist;
      if (!this.tween) Object.assign(g, tw.to);
    } else {
      const a = 1 - Math.exp(-dt * 9);
      for (const k of ['x', 'z', 'yaw', 'pitch']) this.cur[k] += (g[k] - this.cur[k]) * a;
      this.cur.dist = Math.exp(Math.log(this.cur.dist) + (Math.log(g.dist) - Math.log(this.cur.dist)) * a);
    }
    this.apply();
  }

  apply() {
    const c = this.cur;
    const ty = this.hf.height(c.x, c.z);
    const cp = Math.cos(c.pitch), sp = Math.sin(c.pitch);
    let px = c.x + c.dist * cp * Math.sin(c.yaw);
    let pz = c.z + c.dist * cp * Math.cos(c.yaw);
    let py = ty + c.dist * sp;
    const ground = this.hf.height(px, pz);
    if (py < ground + 25) py = ground + 25;
    this.camera.position.set(px, py, pz);
    this.camera.lookAt(c.x, ty, c.z);
    const alt = py - ground;
    this.camera.near = THREE.MathUtils.clamp(Math.min(alt, c.dist) * 0.04, 0.5, 300);
    this.camera.far = 220000;
    this.camera.updateProjectionMatrix();
    this.target = this._v.set(c.x, ty, c.z);
  }
}

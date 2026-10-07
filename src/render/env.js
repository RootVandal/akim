// Sky, sun, moon, fog and seasons over Almaty (43.24° N).

import * as THREE from 'three';
import { Sky } from '../../vendor/three/addons/objects/Sky.js';

const LAT = 43.24 * Math.PI / 180;

/** Solar elevation/azimuth for local solar hour and month (0..11). */
export function sunPosition(hour, month) {
  const doy = month * 30.4 + 15;
  const decl = 23.44 * Math.PI / 180 * Math.sin(2 * Math.PI * (284 + doy) / 365);
  // Almaty local time is ~ +0.9 h ahead of solar time (UTC+5, 77° E)
  const solar = hour - 0.85;
  const ha = (solar - 12) * 15 * Math.PI / 180;
  const sinEl = Math.sin(LAT) * Math.sin(decl) + Math.cos(LAT) * Math.cos(decl) * Math.cos(ha);
  const el = Math.asin(sinEl);
  const cosAz = (Math.sin(decl) - Math.sin(el) * Math.sin(LAT)) / (Math.cos(el) * Math.cos(LAT));
  let az = Math.acos(Math.max(-1, Math.min(1, cosAz)));
  if (ha > 0) az = 2 * Math.PI - az; // azimuth from north, clockwise
  return { el, az };
}

/** Direction to the sun in world space (x east, y up, z south). */
export function sunDir(el, az, out = new THREE.Vector3()) {
  return out.set(Math.sin(az) * Math.cos(el), Math.sin(el), -Math.cos(az) * Math.cos(el));
}

export class Environment {
  constructor(scene, renderer, quality) {
    this.scene = scene;
    this.renderer = renderer;
    this.sky = new Sky();
    this.sky.scale.setScalar(400000);
    this.sky.material.depthWrite = false;
    this.sky.material.depthTest = false;
    this.sky.renderOrder = -10;
    this.sky.frustumCulled = false;
    scene.add(this.sky);
    const u = this.sky.material.uniforms;
    u.turbidity.value = 4.5;
    u.rayleigh.value = 1.4;
    u.mieCoefficient.value = 0.004;
    u.mieDirectionalG.value = 0.8;

    this.sun = new THREE.DirectionalLight(0xffffff, 3);
    this.sun.castShadow = quality !== 'low';
    const sm = quality === 'high' ? 3072 : 2048;
    this.sun.shadow.mapSize.set(sm, sm);
    this.sun.shadow.bias = -0.0004;
    this.sun.shadow.normalBias = 1.2;
    this.sun.shadow.camera.near = 10;
    this.sun.shadow.camera.far = 40000;
    scene.add(this.sun);
    scene.add(this.sun.target);
    this.hemi = new THREE.HemisphereLight(0xbfd4ff, 0x6b5a45, 0.9);
    scene.add(this.hemi);
    scene.fog = new THREE.FogExp2(0xbfd0e0, 0.000028);
    this.stars = this.makeStars();
    scene.add(this.stars);
    this.state = { hour: 17, month: 9, night: 0, snow: 0, autumn: 0, smog: 0 };
    this.sunVec = new THREE.Vector3();
    this.tmpColor = new THREE.Color();
  }

  makeStars() {
    const n = 2500;
    const pos = new Float32Array(n * 3);
    const r = 150000;
    for (let i = 0; i < n; i++) {
      const u = Math.random(), v = Math.random() * 0.9 + 0.1;
      const th = 2 * Math.PI * u, ph = Math.acos(1 - v);
      pos[3 * i] = r * Math.sin(ph) * Math.cos(th);
      pos[3 * i + 1] = r * Math.cos(ph);
      pos[3 * i + 2] = r * Math.sin(ph) * Math.sin(th);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    const m = new THREE.PointsMaterial({ color: 0xffffff, size: 1.6, sizeAttenuation: false, transparent: true, opacity: 0, fog: false, depthWrite: false });
    const p = new THREE.Points(g, m);
    p.frustumCulled = false;
    return p;
  }

  /** Seasonal state from the calendar month (0..11). */
  season(month) {
    const snow = [1, 0.9, 0.35, 0, 0, 0, 0, 0, 0, 0, 0.3, 0.85][month];
    const autumn = [0, 0, 0, 0, 0, 0, 0, 0.1, 0.45, 1, 0.8, 0][month];
    const smog = [1, 0.8, 0.3, 0, 0, 0, 0, 0, 0, 0.1, 0.6, 0.9][month];
    return { snow, autumn, smog };
  }

  update(hour, month, camTarget, camDist, smogScale = 1) {
    const s = this.state;
    s.hour = hour; s.month = month;
    const { el, az } = sunPosition(hour, month);
    const sv = sunDir(el, az, this.sunVec);
    const seas = this.season(month);
    s.snow += (seas.snow - s.snow) * 0.05;
    s.autumn += (seas.autumn - s.autumn) * 0.05;
    s.smog += (seas.smog * smogScale - s.smog) * 0.05;
    const elDeg = el * 180 / Math.PI;
    // daylight factor and night factor
    const day = THREE.MathUtils.smoothstep(elDeg, -4, 8);
    const night = 1 - THREE.MathUtils.smoothstep(elDeg, -8, 2);
    s.night = night;
    const u = this.sky.material.uniforms;
    u.sunPosition.value.copy(sv).multiplyScalar(1000);
    u.turbidity.value = 3.5 + s.smog * 6;
    u.rayleigh.value = 1.2 + (1 - day) * 1.5;
    // sun light: warm when low, moonlight at night
    const warm = THREE.MathUtils.smoothstep(elDeg, 0, 25);
    const c = this.tmpColor;
    if (elDeg > -2) {
      c.setRGB(1.0, 0.62 + 0.36 * warm, 0.38 + 0.58 * warm);
      this.sun.color.copy(c);
      this.sun.intensity = 3.2 * day * (0.35 + 0.65 * warm) * (1 - 0.35 * s.smog);
      this.sun.position.copy(sv).multiplyScalar(15000).add(camTarget);
    } else {
      // moon from the opposite side
      this.sun.color.setRGB(0.55, 0.65, 0.95);
      this.sun.intensity = 0.25;
      const mv = sunDir(0.7, (az + Math.PI) % (2 * Math.PI));
      this.sun.position.copy(mv).multiplyScalar(15000).add(camTarget);
    }
    this.sun.target.position.copy(camTarget);
    // fit the shadow camera around the view
    const S = THREE.MathUtils.clamp(camDist * 1.1, 400, 9000);
    const cam = this.sun.shadow.camera;
    if (cam.right !== S) {
      cam.left = -S; cam.right = S; cam.top = S; cam.bottom = -S;
      cam.updateProjectionMatrix();
    }
    // hemisphere
    this.hemi.intensity = 0.35 + 0.75 * day;
    this.hemi.color.setRGB(0.55 + 0.2 * day, 0.62 + 0.2 * day, 0.85);
    this.hemi.groundColor.setRGB(0.42 * (0.4 + 0.6 * day), 0.36 * (0.4 + 0.6 * day), 0.28 * (0.4 + 0.6 * day));
    // fog colour follows the horizon
    const fog = this.scene.fog;
    const F = this.fogColors || (this.fogColors = {
      day: new THREE.Color().setRGB(0.72, 0.80, 0.90), dusk: new THREE.Color().setRGB(0.85, 0.62, 0.48),
      night: new THREE.Color().setRGB(0.05, 0.07, 0.12), smog: new THREE.Color().setRGB(0.62, 0.58, 0.50),
    });
    fog.color.copy(F.night).lerp(F.dusk, day).lerp(F.day, warm);
    fog.color.lerp(F.smog, s.smog * 0.55 * day);
    fog.density = (0.000022 + s.smog * 0.00004) * (1 + 0.6 * night);
    this.stars.material.opacity = night * 0.9;
    this.stars.position.copy(camTarget);
    this.renderer.toneMappingExposure = 0.62 + 0.38 * day;
    return s;
  }
}

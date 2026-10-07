// Hand-made landmarks: the Kok-Tobe TV tower (372 m) with blinking aviation lights.

import * as THREE from 'three';

const KOKTOBE = { x: 2575, z: 590 }; // fallback position of the tower (local metres)

export class Landmarks {
  constructor(meta, hf) {
    this.group = new THREE.Group();
    this.group.name = 'landmarks';
    const tower = meta.landmarks.find(l => l.k === 'tower' && /кок|көк/i.test(l.name)) || KOKTOBE;
    const x = tower.x, z = tower.z;
    const y = hf.height(x, z);
    const steel = new THREE.MeshStandardMaterial({ color: 0xb9bec4, roughness: 0.5, metalness: 0.6 });
    const H = 372;
    // three tapered legs + core
    for (let i = 0; i < 3; i++) {
      const a = (i / 3) * Math.PI * 2;
      const leg = new THREE.CylinderGeometry(0.9, 2.2, H * 0.62, 6);
      const m = new THREE.Mesh(leg, steel);
      const r0 = 16;
      m.position.set(x + Math.cos(a) * r0 * 0.55, y + H * 0.31, z + Math.sin(a) * r0 * 0.55);
      m.rotation.z = Math.cos(a) * 0.035;
      m.rotation.x = -Math.sin(a) * 0.035;
      m.castShadow = true;
      this.group.add(m);
    }
    const core = new THREE.Mesh(new THREE.CylinderGeometry(1.0, 3.4, H, 8), steel);
    core.position.set(x, y + H / 2, z);
    core.castShadow = true;
    this.group.add(core);
    for (const [hh, r] of [[H * 0.42, 9], [H * 0.62, 6.5], [H * 0.8, 4]]) {
      const p = new THREE.Mesh(new THREE.CylinderGeometry(r, r, 3.2, 12), steel);
      p.position.set(x, y + hh, z);
      p.castShadow = true;
      this.group.add(p);
    }
    this.lights = [];
    const lm = new THREE.MeshBasicMaterial({ color: new THREE.Color(4, 0.25, 0.15), toneMapped: false, fog: false });
    for (const hh of [H * 0.42, H * 0.62, H * 0.8, H]) {
      const s = new THREE.Mesh(new THREE.SphereGeometry(2.6, 10, 8), lm);
      s.position.set(x, y + hh + 2, z);
      this.group.add(s);
      this.lights.push(s);
    }
    this.towerTop = new THREE.Vector3(x, y + H, z);
  }

  update(t, night) {
    const on = (Math.sin(t * 3) > 0.2) ? 1 : 0.15;
    for (const s of this.lights) s.scale.setScalar((0.6 + 1.4 * night) * on + 0.01);
  }
}

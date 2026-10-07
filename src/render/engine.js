// Renderer, scene graph, post-processing and the frame loop.

import * as THREE from 'three';
import { EffectComposer } from '../../vendor/three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from '../../vendor/three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from '../../vendor/three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from '../../vendor/three/addons/postprocessing/OutputPass.js';
import { HeightField, terrainMaterial } from './terrain.js';
import { GroundPainter } from './ground.js';
import { Environment } from './env.js';
import { CityCamera } from './camera.js';
import { buildBuildings, buildingMaterial, makeBuildingMeshes, hideBuildings, lodBuildings } from './buildings.js';
import { RoadGeom } from './roadgeom.js';
import { buildRoadMeshes, TrafficOverlay, selectionMesh } from './roads.js';
import { Cars } from './cars.js';
import { Landmarks } from './landmarks.js';
import { Trees } from './trees.js';

// Graphics presets. 'medium' is the default; strong discrete GPUs get 'high'.
export const QUALITY = {
  low: { dpr: 1, msaa: 0, shadows: false, trees: false, cars: 2500, terrainStride: 3, bloom: false, lodNear: 3500 },
  medium: { dpr: 1, msaa: 4, shadows: true, trees: true, cars: 4500, terrainStride: 3, bloom: true, lodNear: 5000 },
  high: { dpr: 1.5, msaa: 4, shadows: true, trees: true, cars: 7000, terrainStride: 2, bloom: true, lodNear: 8000 },
};

export function detectQuality() {
  const q = new URLSearchParams(location.search).get('q');
  if (q && QUALITY[q]) return q;
  try {
    const saved = localStorage.getItem('akim-quality');
    if (saved && QUALITY[saved]) return saved;
  } catch { /* storage blocked */ }
  try {
    const gl = document.createElement('canvas').getContext('webgl2');
    const ext = gl && gl.getExtension('WEBGL_debug_renderer_info');
    const name = ext ? String(gl.getParameter(ext.UNMASKED_RENDERER_WEBGL)) : '';
    if (/RTX\s*(30[6-9]|40[6-9]|50)|RX\s*(6[7-9]|7[7-9])|Apple M[2-4] (Pro|Max)/i.test(name)) return 'high';
    if (/Intel|UHD|Iris|Mali|Adreno|PowerVR|SwiftShader|llvmpipe/i.test(name)) return 'low';
  } catch { /* ignore */ }
  return 'medium';
}

export class Engine {
  constructor(container, data, net, quality) {
    this.data = data;
    this.net = net;
    this.quality = quality;
    const Q = this.Q = QUALITY[quality] || QUALITY.medium;
    this.container = container;
    const renderer = this.renderer = new THREE.WebGLRenderer({
      antialias: !Q.msaa, powerPreference: 'high-performance', reversedDepthBuffer: true,
    });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, Q.dpr));
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1;
    renderer.shadowMap.enabled = Q.shadows;
    renderer.shadowMap.type = THREE.PCFShadowMap;
    renderer.shadowMap.autoUpdate = false; // refreshed every few frames in frame()
    container.appendChild(renderer.domElement);
    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(45, 1, 1, 200000);
    this.hf = new HeightField(data.meta.terrain, data.terrain.h);
    this.env = new Environment(this.scene, renderer, Q.shadows ? quality : 'low');
    this.controls = new CityCamera(this.camera, renderer.domElement, this.hf);
    this.clock = null;
    this._t = performance.now();
    this.time = 0;
    this.hour = 8.5;
    this.month = 9;
    this.frameHooks = [];
    this.layers = { traffic: true, buildings: true, cars: true, labels: true };
    this.smogScale = 1;
    this.selection = null;
    this.setupComposer();
    window.addEventListener('resize', () => this.resize());
    this.resize();
  }

  setupComposer() {
    const r = this.renderer;
    if (!this.Q.msaa) { this.composer = null; return; }
    const size = r.getDrawingBufferSize(new THREE.Vector2());
    const rt = new THREE.WebGLRenderTarget(size.x, size.y, { type: THREE.HalfFloatType, samples: this.Q.msaa });
    this.composer = new EffectComposer(r, rt);
    this.composer.addPass(new RenderPass(this.scene, this.camera));
    this.bloom = new UnrealBloomPass(new THREE.Vector2(size.x, size.y), 0.0, 0.55, 0.92);
    this.composer.addPass(this.bloom);
    this.composer.addPass(new OutputPass());
  }

  resize() {
    const w = this.container.clientWidth || window.innerWidth;
    const h = this.container.clientHeight || window.innerHeight;
    this.renderer.setSize(w, h);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    if (this.composer) this.composer.setSize(w, h);
    const res = this.renderer.getDrawingBufferSize(new THREE.Vector2());
    this.res = res;
    if (this.overlay) this.overlay.uniforms.uRes.value.copy(res);
    if (this.selection) this.selection.material.uniforms.uRes.value.copy(res);
  }

  /** Build all world geometry. progress(stage, fraction) */
  async build(progress) {
    const { data, hf } = this;
    progress('Рельеф Заилийского Алатау', 0);
    this.ground = new GroundPainter(data, this.quality);
    const terrainGeo = hf.geometry(this.Q.terrainStride);
    this.terrainMat = terrainMaterial(hf, this.ground.texture, this.ground.bounds, hf.normalTexture());
    const terrain = new THREE.Mesh(terrainGeo, this.terrainMat);
    terrain.receiveShadow = true;
    terrain.name = 'terrain';
    this.scene.add(terrain);
    progress('Дороги', 0.15);
    await tick();
    this.rg = new RoadGeom(data.meta, data.roads, hf, this.net);
    const roads = buildRoadMeshes(data, this.rg);
    this.roads = roads;
    this.scene.add(roads.major, roads.minor);
    this.overlay = new TrafficOverlay(this.rg, this.net);
    this.overlay.uniforms.uRes.value.copy(this.res);
    this.scene.add(this.overlay.mesh);
    progress('Машины', 0.25);
    await tick();
    this.cars = new Cars(this.rg, this.net, this.Q.cars);
    this.scene.add(this.cars.mesh);
    progress('Деревья: город-сад', 0.27);
    await tick();
    if (this.Q.trees) {
      const dr = data.meta.districtRaster, dd = data.districts.d;
      const districtAt = (x, z) => {
        const i = Math.floor((x - dr.x0) / dr.cs), j = Math.floor((z - dr.z0) / dr.cs);
        return i < 0 || j < 0 || i >= dr.w || j >= dr.h ? -1 : dd[j * dr.w + i] - 1;
      };
      this.trees = new Trees(data, hf, this.rg, districtAt);
      this.scene.add(this.trees.group);
    }
    this.landmarks = new Landmarks(data.meta, hf);
    this.scene.add(this.landmarks.group);
    progress(`Здания: ${data.meta.buildings.count.toLocaleString('ru-RU')}`, 0.3);
    this.bMat = buildingMaterial();
    const chunks = await buildBuildings(data, hf, f => progress(`Здания: ${data.meta.buildings.count.toLocaleString('ru-RU')}`, 0.3 + 0.6 * f));
    this.buildings = makeBuildingMeshes(chunks, this.bMat);
    this.scene.add(this.buildings);
    progress('Готово', 1);
  }

  addPark(p) {
    const poly = [];
    for (let i = 0; i < 48; i++) { const a = (i / 48) * Math.PI * 2; poly.push([p.x + Math.cos(a) * p.r, p.z + Math.sin(a) * p.r]); }
    this.ground.addPark({ poly, x: p.x, z: p.z, r: p.r });
    if (p.ids && p.ids.length) hideBuildings(this.buildings, p.ids);
    if (this.trees) this.trees.addPark(p.x, p.z, p.r);
  }

  /** Placement preview ring for parks (null hides it). */
  previewRing(x, z, r, ok) {
    if (!this.ring) {
      const g = new THREE.RingGeometry(0.92, 1, 96);
      g.rotateX(-Math.PI / 2);
      this.ring = new THREE.Mesh(g, new THREE.MeshBasicMaterial({ color: 0x37d483, transparent: true, opacity: 0.9, depthTest: false, toneMapped: false }));
      const disc = new THREE.Mesh(new THREE.CircleGeometry(1, 96).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial({ color: 0x37d483, transparent: true, opacity: 0.18, depthTest: false }));
      this.ring.add(disc);
      this.ring.renderOrder = 9;
      this.scene.add(this.ring);
    }
    if (x == null) { this.ring.visible = false; return; }
    this.ring.visible = true;
    this.ring.position.set(x, this.hf.height(x, z) + 6, z);
    this.ring.scale.set(r, 1, r);
    const c = ok ? 0x37d483 : 0xff5a4c;
    this.ring.material.color.setHex(c);
    this.ring.children[0].material.color.setHex(c);
  }

  setSnapshot(snap) {
    this.snap = snap;
    this.overlay.update(snap.ratio);
    this.cars.setFlows(snap, this.hour);
  }

  setHour(h) {
    const prevSlot = Math.floor(this.hour * 2);
    this.hour = ((h % 24) + 24) % 24;
    this.overlay.setHour(this.hour);
    if (Math.floor(this.hour * 2) !== prevSlot && this.snap) this.cars.setFlows(this.snap, this.hour);
  }

  select(segs, color) {
    if (this.selection) { this.scene.remove(this.selection); this.selection.geometry.dispose(); this.selection = null; }
    if (segs && segs.length) {
      this.selection = selectionMesh(this.rg, segs, color);
      this.selection.material.uniforms.uRes.value.copy(this.res);
      this.scene.add(this.selection);
    }
  }

  start() {
    const loop = () => {
      this.raf = requestAnimationFrame(loop);
      this.frame();
    };
    loop();
    // background tabs / hidden panes get no rAF: keep the world ticking slowly
    this.lastFrameAt = performance.now();
    setInterval(() => { if (performance.now() - this.lastFrameAt > 300) this.frame(); }, 150);
  }

  frame() {
    this.lastFrameAt = performance.now();
    const now = performance.now();
    const dt = Math.min(0.1, (now - this._t) / 1000);
    this._t = now;
    this.time += dt;
    this.controls.update(dt);
    const cam = this.controls.cur;
    const st = this.env.update(this.hour, this.month, this.controls.target, cam.dist, this.smogScale);
    const u = this.terrainMat.userData.uniforms;
    u.uSnow.value = st.snow; u.uAutumn.value = st.autumn; u.uNight.value = st.night;
    const bu = this.bMat.userData.uniforms;
    bu.uNight.value = st.night; bu.uSnow.value = st.snow;
    bu.uLit.value = litShare(this.hour);
    for (const m of [this.roads.major, this.roads.minor]) {
      m.material.userData.uniforms.uSnow.value = st.snow;
    }
    const ou = this.overlay.uniforms;
    ou.uTime.value = this.time;
    ou.uNight.value = st.night;
    // overlay: thin when close (cars visible), bold when far
    const far = THREE.MathUtils.smoothstep(cam.dist, 600, 4000);
    ou.uOpacity.value = this.layers.traffic ? 0.35 + 0.65 * far : 0;
    ou.uMinPx.value = 1.6 + 1.2 * far;
    ou.uWorldW.value = 2.2 + 3.0 * (1 - far);
    this.overlay.mesh.visible = this.layers.traffic;
    this.cars.material.userData.uniforms.uNight.value = st.night;
    this.cars.update(dt, 4, this.layers.cars && cam.dist < 6000);
    if (this.selection) this.selection.material.uniforms.uTime.value = this.time;
    this.landmarks.update(this.time, st.night);
    if (this.trees) this.trees.update(this.controls.target, cam.dist, st.autumn, st.snow);
    if (this.bloom) {
      // bloom only matters for lights at night
      this.bloom.enabled = this.Q.bloom && st.night > 0.05;
      this.bloom.strength = 0.75 * st.night;
      this.bloom.threshold = 0.85 - 0.25 * st.night;
    }
    if (this.buildings) lodBuildings(this.buildings, this.camera.position, this.Q.lodNear);
    // shadows: refresh every 3rd frame (sun and camera move slowly)
    this.frameNo = (this.frameNo || 0) + 1;
    if (this.renderer.shadowMap.enabled && this.frameNo % 3 === 0) this.renderer.shadowMap.needsUpdate = true;
    for (const h of this.frameHooks) h(dt);
    if (this.composer) this.composer.render();
    else this.renderer.render(this.scene, this.camera);
  }
}

/** Share of lit windows by hour of day. */
function litShare(h) {
  if (h < 5) return 0.08 + (5 - h) * 0.02;
  if (h < 8) return 0.18 + (8 - h) * 0.05;
  if (h < 17) return 0.06;
  if (h < 22) return 0.25 + (h - 17) * 0.06;
  return 0.5 - (h - 22) * 0.12;
}

const tick = () => new Promise(r => setTimeout(r, 0));

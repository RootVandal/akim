// Boot: load the city, start the traffic worker, build the 3D world, run the intro,
// then offer "continue" (autosave) or a new game with a difficulty level.

import { loadAll } from './data/loader.js';
import { buildNetwork } from './sim/network.js';
import { TrafficClient } from './sim/client.js';
import { Game } from './sim/game.js';
import { Engine, detectQuality } from './render/engine.js';
import { UI } from './ui/ui.js';
import { GreenModel } from './sim/green.js';
import { Tutorial } from './ui/tutorial.js';

const $ = id => document.getElementById(id);
const debug = new URLSearchParams(location.search).has('debug');

function stage(text, f) {
  $('ldStage').textContent = text;
  $('ldFill').style.width = `${Math.round(f * 100)}%`;
}

async function boot() {
  stage('Загружаем Алматы из OpenStreetMap…', 0.02);
  const data = await loadAll(p => {
    const mb = Object.values(p).reduce((a, b) => a + b, 0) / 1e6;
    stage(`Загружаем Алматы из OpenStreetMap… ${mb.toFixed(1)} МБ`, 0.02 + Math.min(0.12, mb / 80));
  });
  const net = buildNetwork(data.meta, data.roads);
  // traffic model warms up in its worker while the world is being built
  const traffic = new TrafficClient();
  let trafficF = 0, buildF = 0;
  const report = (txt) => stage(txt, 0.15 + 0.85 * (0.55 * buildF + 0.45 * trafficF));
  traffic.onProgress = (f) => { trafficF = f; };
  const ready = traffic.init({ calMonth: 9 });
  const engine = new Engine($('viewport'), data, net, detectQuality());
  await engine.build((txt, f) => { buildF = f; report(txt); });
  let dots = 0;
  const waitTimer = setInterval(() => { dots = (dots + 1) % 4; report(`Водители выбирают маршруты: утро, день, вечер${'.'.repeat(dots)}`); }, 300);
  const first = await ready;
  clearInterval(waitTimer);
  stage('Добро пожаловать в Алматы', 1);

  const game = new Game(data.meta);
  const green = new GreenModel(data);
  game.attach({ green });
  game.seedHistory(first.metrics);
  const ui = new UI({ data, net, engine, game, traffic });
  ui.applyResult(first);
  engine.month = 9;
  engine.setHour(6);
  // intro: from the mountains above Medeu down to the city
  const ctl = engine.controls;
  ctl.cur = { x: 9000, z: 16000, dist: 26000, yaw: 2.9, pitch: 0.38 };
  Object.assign(ctl.goal, ctl.cur);
  ctl.apply();
  engine.start();
  ui.refresh();
  if (debug) window.AKIM = { data, net, engine, game, ui, traffic, green };
  setTimeout(() => $('loading').classList.add('gone'), 300);
  setTimeout(() => $('loading').remove(), 1700);
  ctl.flyTo({ x: 600, z: -1200, dist: 7800, yaw: 0.42, pitch: 0.72 }, 7000);

  const tutorial = new Tutorial(ui);
  ui.onTutorial = () => { ui.setSpeed(0); tutorial.start(); };
  tutorial.onEnd = (skipped) => { if (skipped && ui.speed === 0) ui.setSpeed(1); };
  window.addEventListener('beforeunload', () => ui.save());
  document.addEventListener('visibilitychange', () => { if (document.hidden) ui.save(); });

  const startNew = (key) => {
    game.setDifficulty(key);
    ui.started = true;
    ui.refresh();
    ui.showBriefing(() => {
      if (Tutorial.seen() && !debug) ui.setSpeed(1);
      else tutorial.start();
    });
  };

  const restore = async (save) => {
    ui.showBusy('Восстанавливаем город', `${save.label}: водители заново выбирают маршруты с вашими мерами и расписанием…`);
    traffic.onProgress = (f) => ui.setBusy(f);
    try {
      game.load(save.game);
      green.extraArea = 0;
      for (const p of game.s.parks) {
        green.addPark(p.x, p.z, p.r, p.ids || []);
        engine.addPark(p);
      }
      const res = await traffic.restore({ ...game.trafficState(), iters: 10 });
      game.population = res.info.population;
      ui.applyResult(res);
      engine.month = game.date().cal;
      engine.setHour(save.hour ?? 6);
      if (save.cam) {
        ctl.tween = null;
        Object.assign(ctl.cur, save.cam);
        Object.assign(ctl.goal, save.cam);
        ctl.apply();
      }
      ui._shownNews = game.s.news.length;
      for (const n of game.s.news.slice(0, 3).reverse()) ui.pushNews(n);
      ui.started = true;
      ui.hideBusy();
      ui.refresh();
      ui.openPanel({ type: 'city' });
      ui.toast(`Игра загружена: ${game.dateLabel()}`);
      ui.setSpeed(1);
    } catch (err) {
      console.error(err);
      ui.hideBusy();
      ui.toast('Сохранение повреждено — начинаем новую игру', true);
      ui.showDifficulty(startNew);
    }
  };

  setTimeout(() => {
    for (const id of ['topbar', 'dock', 'panel', 'dayline', 'news']) $(id).classList.remove('hidden');
    engine.resize();
    ui.openPanel({ type: 'city' });
    ui.updateDayline();
    const save = UI.loadSave();
    ui.showStartMenu(save, {
      onNew: () => ui.showDifficulty(startNew),
      onContinue: () => restore(save),
    });
  }, 5200);
}

boot().catch(err => {
  console.error(err);
  stage(`Ошибка загрузки: ${err.message}`, 0);
});

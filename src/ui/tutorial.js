// Interactive first-run tutorial: spotlight a part of the screen, explain it,
// and wait until the player actually does the thing.

const $ = id => document.getElementById(id);

export class Tutorial {
  constructor(ui) {
    this.ui = ui;
    this.root = $('tutorial');
    this.hole = this.root.querySelector('.hole');
    this.tip = this.root.querySelector('.tip');
    this.i = -1;
    this.timer = null;
    const g = ui.game;
    this.steps = [
      {
        title: 'Добро пожаловать, аким!',
        text: 'Перед вами настоящая Алматы: 2,3 млн жителей, реальные улицы и дома из OpenStreetMap. Утром весь город едет в центр одновременно — отсюда пробки. У вас <b>60 месяцев</b>, чтобы это исправить.',
      },
      {
        target: '#stCI', title: 'Индекс пробок',
        text: 'На сколько дольше поездка, чем по пустому городу. Сейчас около <b>60%</b>. Цель миссии — <b>30%</b> по городу и не больше 50% в каждом районе.',
      },
      {
        target: null, clear: true, title: 'Карта города',
        text: 'Цветные линии — пробки, как в навигаторе: <b>зелёный</b> — свободно, <b>красный</b> — стоим. Покрутите карту: левая кнопка — двигать, колесо — масштаб, правая — поворот.',
        wait: 'Подвигайте карту',
        setup: () => { const c = ui.engine.controls.cur; this.cam0 = { x: c.x, z: c.z, d: c.dist, y: c.yaw }; },
        done: () => {
          const c = ui.engine.controls.cur, a = this.cam0;
          return Math.hypot(c.x - a.x, c.z - a.z) > 250 || Math.abs(Math.log(c.dist / a.d)) > 0.25 || Math.abs(c.yaw - a.y) > 0.3;
        },
      },
      {
        target: '#dayline', title: 'Сутки = месяц',
        text: 'Один месяц игры показывается как одни сутки. Пики — утром и вечером. <b>Потяните полосу на 8:00</b>, чтобы увидеть утренний час пик.',
        wait: 'Перетащите курсор на 7:30–9:30',
        done: () => ui.engine.hour >= 7.5 && ui.engine.hour <= 9.5,
      },
      {
        target: null, clear: true, title: 'Выберите улицу',
        text: '<b>Кликните по красной улице</b> на карте — откроется её карточка: загрузка по часам в обе стороны и меры, которые можно ввести.',
        wait: 'Кликните по улице',
        done: () => ui.panel.type === 'street' && ui.sel,
      },
      {
        target: '#panel', title: 'Меры для улицы',
        text: 'Реверсивные полосы, односторонка, «зелёная волна», выделенка, расширение… У каждой меры цена, содержание и реакция жителей. <b>Попробуйте любую</b> — например, «Зелёную волну»: дешёвая и людям нравится.',
        wait: 'Введите меру (или нажмите «Дальше»)', optional: true,
        setup: () => { this.pol0 = g.s.policies.length; },
        done: () => g.s.policies.length > this.pol0,
      },
      {
        target: '#dock [data-panel="schedule"]', title: 'Главный рычаг — время',
        text: 'Школы, вузы, госслужба и офисы стартуют почти одновременно. <b>Откройте вкладку «Время».</b>',
        wait: 'Нажмите «Время»',
        done: () => ui.panel.type === 'schedule',
      },
      {
        target: '#panel', title: 'Разведите потоки',
        text: 'Сдвиньте кого-нибудь с утреннего пика: например, <b>пары в вузах на 10:00</b> или школы одного района на 9:30. Родители и студенты поворчат, но пик станет ниже.',
        wait: 'Измените любое расписание (или «Дальше»)', optional: true,
        setup: () => { this.sch0 = JSON.stringify([g.s.schedule, g.s.levels]); },
        done: () => JSON.stringify([g.s.schedule, g.s.levels]) !== this.sch0,
      },
      {
        target: '#topbar .stats', title: 'Деньги и репутация',
        text: 'Казна пополняется каждый месяц: чем выше репутация и чем меньше пробок, тем больше доход. Каждое решение кого-то злит — <b>если репутация упадёт до нуля, аким уходит в отставку.</b>',
      },
      {
        target: '#speed', title: 'Запускайте время',
        text: 'Нажмите <b>▶</b>. Месяц длится ~30 секунд, кнопки ▶▶ ускоряют. Водители привыкают к изменениям несколько месяцев — смотрите на тренд, а не на один день. Удачи!',
        wait: 'Нажмите ▶',
        done: () => ui.speed > 0,
      },
    ];
    this.tip.addEventListener('click', e => {
      const b = e.target.closest('[data-t]');
      if (!b) return;
      if (b.dataset.t === 'next') this.next();
      if (b.dataset.t === 'skip') this.end(true);
    });
    window.addEventListener('resize', () => { if (this.i >= 0) this.place(); });
  }

  start() {
    this.root.classList.remove('hidden');
    this.i = -1;
    this.next();
  }

  next() {
    clearInterval(this.timer);
    this.i++;
    if (this.i >= this.steps.length) { this.end(false); return; }
    const st = this.steps[this.i];
    if (st.setup) st.setup();
    this.render();
    if (st.done) {
      this.timer = setInterval(() => {
        if (st.done()) { clearInterval(this.timer); setTimeout(() => this.next(), 450); }
        else this.place();
      }, 250);
    }
  }

  render() {
    const st = this.steps[this.i];
    const n = this.steps.length;
    const canNext = !st.done || st.optional;
    this.tip.innerHTML = `<div class="step">Обучение · ${this.i + 1} из ${n}</div><h3>${st.title}</h3><p>${st.text}</p>
      ${st.wait ? `<div class="wait">${st.wait}</div>` : ''}
      <div class="acts"><button class="skip" data-t="skip">Пропустить обучение</button>
      <div class="dots">${this.steps.map((_, k) => `<i class="${k <= this.i ? 'on' : ''}"></i>`).join('')}</div>
      ${canNext ? `<button class="btn gold" data-t="next">${this.i === n - 1 ? 'Готово' : 'Дальше'}</button>` : '<span></span>'}</div>`;
    this.place();
  }

  place() {
    const st = this.steps[this.i];
    if (!st) return;
    const W = window.innerWidth, H = window.innerHeight;
    const el = st.target ? document.querySelector(st.target) : null;
    const tipW = 344, tipH = this.tip.offsetHeight || 220;
    this.hole.classList.toggle('none', !el && !st.clear);
    this.hole.classList.toggle('clear', !!st.clear);
    let tx, ty;
    if (el) {
      const r = el.getBoundingClientRect();
      const pad = 6;
      Object.assign(this.hole.style, { left: `${r.left - pad}px`, top: `${r.top - pad}px`, width: `${r.width + 2 * pad}px`, height: `${r.height + 2 * pad}px` });
      // put the tip beside the target, where there is room
      if (r.right + 16 + tipW < W) { tx = r.right + 16; ty = r.top; }
      else if (r.left - 16 - tipW > 0) { tx = r.left - 16 - tipW; ty = r.top; }
      else if (r.bottom + 16 + tipH < H) { tx = r.left; ty = r.bottom + 16; }
      else { tx = r.left; ty = r.top - 16 - tipH; }
    } else if (st.clear) {
      Object.assign(this.hole.style, { left: '0px', top: '0px', width: `${W}px`, height: `${H}px` });
      tx = W / 2 - tipW / 2; ty = 110;
    } else {
      tx = W / 2 - tipW / 2; ty = H / 2 - tipH / 2;
    }
    tx = Math.max(12, Math.min(W - tipW - 12, tx));
    ty = Math.max(12, Math.min(H - tipH - 12, ty));
    this.tip.style.left = `${tx}px`;
    this.tip.style.top = `${ty}px`;
  }

  end(skipped) {
    clearInterval(this.timer);
    this.root.classList.add('hidden');
    this.i = -1;
    try { localStorage.setItem('akim-tutorial', skipped ? 'skipped' : 'done'); } catch { /* ignore */ }
    if (this.onEnd) this.onEnd(skipped);
  }

  static seen() {
    try { return !!localStorage.getItem('akim-tutorial'); } catch { return false; }
  }
}

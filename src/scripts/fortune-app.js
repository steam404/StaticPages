import { drawFortune, FORTUNES, GRADE_STYLE } from '../data/fortunes.js';

/* ============================== 工具 ============================== */

const esc = s =>
  String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const KEY = 'yakult.fortune';

const todayStr = () => {
  const d = new Date();
  const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
};

/* ============================== 状态 ============================== */

const loadToday = () => {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY));
    if (!raw || raw.date !== todayStr() || raw.no == null) return null;
    return FORTUNES.find(f => f.no === raw.no) || null;
  } catch {
    return null;
  }
};

const saveToday = fortune =>
  localStorage.setItem(KEY, JSON.stringify({ date: todayStr(), no: fortune.no }));

let current = loadToday();
let busy = false;

const result = () => document.getElementById('fortune-result');
const tube = () => document.getElementById('tube');
const shakeBtn = () => document.getElementById('shake');

/* ============================== 渲染 ============================== */

function resultHTML(f) {
  const g = GRADE_STYLE[f.grade];

  return `
    <article class="fcard ${g.cls}">
      <div class="fcard-head">
        <span class="fno">第 ${f.no} 签</span>
        <span class="fgrade">${g.label}</span>
      </div>

      <h2>${esc(f.title)}</h2>

      <div class="fpoem">
        ${f.poem.map(line => `<p>${esc(line)}</p>`).join('')}
      </div>

      <p class="freading">${esc(f.reading)}</p>

      <div class="fyi">
        <div class="fyi-row">
          <span class="fyi-tag good">宜</span>
          ${f.good.map(x => `<em>${esc(x)}</em>`).join('')}
        </div>
        <div class="fyi-row">
          <span class="fyi-tag bad">忌</span>
          ${f.bad.map(x => `<em>${esc(x)}</em>`).join('')}
        </div>
      </div>

      <p class="fnote">今天这支签已经定了。重摇只是图个乐，别太当真。</p>
      <button class="btn-ghost" data-action="redraw">再摇一次</button>
    </article>`;
}

function render({ animate = false } = {}) {
  const box = result();
  if (!box) return;

  if (!current) {
    box.innerHTML = '';
    if (shakeBtn()) shakeBtn().textContent = '摇一摇';
    return;
  }

  box.innerHTML = resultHTML(current);
  if (shakeBtn()) shakeBtn().textContent = '再摇一次';

  if (animate) {
    box.classList.add('pop');
    setTimeout(() => box.classList.remove('pop'), 700);
  }
}

/* ============================== 摇签 ============================== */

function shake() {
  if (busy) return;
  busy = true;

  const t = tube();
  const btn = shakeBtn();

  t.classList.add('shaking');
  btn.disabled = true;
  btn.textContent = '摇签中…';

  // 减少动效偏好：跳过抖动
  const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const wait = reduce ? 120 : 900;

  setTimeout(() => {
    t.classList.remove('shaking');
    t.classList.add('pop');

    current = drawFortune();
    saveToday(current);
    render({ animate: true });

    setTimeout(() => t.classList.remove('pop'), 600);

    btn.disabled = false;
    busy = false;
  }, wait);
}

/* ============================== 事件 ============================== */

document.addEventListener('click', e => {
  const el = e.target.closest('[data-action]');
  if (!el) return;

  if (el.dataset.action === 'redraw') shake();
});

document.getElementById('shake')?.addEventListener('click', shake);

/* 启动 */
render();

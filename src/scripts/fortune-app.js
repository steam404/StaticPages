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
  const stick = t?.querySelector('.stick.s2');
  const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  btn.disabled = true;
  btn.textContent = '摇签中…';

  // 复位上一轮抽出的签
  stick?.getAnimations?.().forEach(a => a.cancel());
  if (stick) stick.style.transform = '';

  // 用 Web Animations API 驱动，避免受 CSS 媒体查询影响
  const shakeDur = reduce ? 220 : 140;
  const rounds = reduce ? 2 : 6;

  const anim = t?.animate?.(
    [
      { transform: 'rotate(0deg) translateY(0)' },
      { transform: 'rotate(-8deg) translateY(-6px)' },
      { transform: 'rotate(8deg) translateY(3px)' },
      { transform: 'rotate(0deg) translateY(0)' },
    ],
    { duration: shakeDur, iterations: rounds, easing: 'ease-in-out' },
  );

  // 老浏览器没有 animate()：退回 CSS 类
  if (!anim && t) {
    t.classList.add('shaking');
    setTimeout(() => t.classList.remove('shaking'), 800);
  }

  setTimeout(() => {
    anim?.cancel?.();

    // 一支签抽出来
    stick?.animate?.(
      [
        { transform: 'translateY(0) rotate(-2deg)' },
        { transform: 'translateY(-72px) rotate(-2deg)' },
      ],
      { duration: reduce ? 180 : 520, easing: 'cubic-bezier(.2,.9,.2,1)', fill: 'forwards' },
    );

    current = drawFortune();
    saveToday(current);

    setTimeout(
      () => {
        render({ animate: true });
        btn.disabled = false;
        btn.textContent = '再摇一次';
        busy = false;
      },
      reduce ? 120 : 430,
    );
  }, shakeDur * rounds);
}

/* ============================== 事件 ============================== */

document.addEventListener('click', e => {
  const el = e.target.closest('[data-action]');
  if (!el) return;

  if (el.dataset.action === 'redraw') shake();
});

document.getElementById('shake')?.addEventListener('click', shake);

// 直接点签筒也能摇，更好发现
document.getElementById('tube')?.addEventListener('click', shake);
tube()?.style.setProperty('cursor', 'pointer');

/* 启动 */
render();

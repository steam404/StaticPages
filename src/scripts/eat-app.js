import { estimateDish, suggest } from '../data/dishes.js';
import { SEED_RECIPES, SEED_COUNT } from '../data/seed-recipes.js';
import {
  loadConfig,
  saveConfig,
  mergeConfig,
  parseINI,
  toINI,
  DEFAULT_CONFIG,
  isAiReady,
} from './config.js';
import { aiAdvice, aiEstimate, aiGenerateImage, aiPing, aiRecognize, aiSuggest, AiError } from './ai.js';

/* ============================== 存储 ============================== */

const LS = {
  recipes: 'yakult.recipes',
  meals: 'yakult.meals',
  settings: 'yakult.settings',
};

const loadJSON = (key, fallback) => {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : fallback;
  } catch {
    return fallback;
  }
};

const saveJSON = (key, value) => localStorage.setItem(key, JSON.stringify(value));

const normalizeIngredient = x =>
  typeof x === 'string'
    ? { name: x, kind: 'main', need: true }
    : {
        name: String(x.name || ''),
        kind: x.kind === 'aux' ? 'aux' : 'main',
        need: x.need !== false,
      };

const normalizeRecipe = r => ({
  ...r,
  ingredients: (r.ingredients || []).map(normalizeIngredient),
});

let recipes = loadJSON(LS.recipes, []).map(normalizeRecipe);
let meals = loadJSON(LS.meals, []);
let ui = loadJSON(LS.settings, { targetKcal: 1800, shoppingChecked: {} });
// 旧版本存的设置可能没有 shoppingChecked，补上免得采购页崩
ui = { targetKcal: 1800, ...ui, shoppingChecked: { ...(ui.shoppingChecked || {}) } };
let config = loadConfig();

const persist = () => {
  saveJSON(LS.recipes, recipes);
  saveJSON(LS.meals, meals);
  saveJSON(LS.settings, ui);
};

/* ---------- 图片（IndexedDB） ---------- */

const DB_NAME = 'yakult-eat';
let dbPromise = null;

function openDb() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise(resolve => {
    try {
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => req.result.createObjectStore('images');
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
  return dbPromise;
}

async function imgPut(id, dataUrl) {
  try {
    const db = await openDb();
    if (!db) return false;
    return await new Promise(resolve => {
      const tx = db.transaction('images', 'readwrite');
      tx.objectStore('images').put(dataUrl, id);
      tx.oncomplete = () => resolve(true);
      tx.onerror = () => resolve(false);
    });
  } catch {
    return false;
  }
}

async function imgGet(id) {
  if (!id) return null;
  try {
    const db = await openDb();
    if (!db) return null;
    return await new Promise(resolve => {
      const tx = db.transaction('images', 'readonly');
      const r = tx.objectStore('images').get(id);
      r.onsuccess = () => resolve(r.result || null);
      r.onerror = () => resolve(null);
    });
  } catch {
    return null;
  }
}

/* ============================== 工具 ============================== */

const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
const pad = n => String(n).padStart(2, '0');
const dateStr = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const todayStr = () => dateStr(new Date());

const shiftDate = (str, days) => {
  const [y, m, d] = str.split('-').map(Number);
  return dateStr(new Date(y, m - 1, d + days));
};

const WEEK = ['日', '一', '二', '三', '四', '五', '六'];

const humanDate = str => {
  const [y, m, d] = str.split('-').map(Number);
  const dt = new Date(y, m - 1, d);
  return `${m} 月 ${d} 日 · 周${WEEK[dt.getDay()]}${str === todayStr() ? '（今天）' : ''}`;
};

const esc = s =>
  String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const num = (v, fb = 0) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : fb;
};

const SLOTS = [
  { key: 'breakfast', label: '早餐' },
  { key: 'lunch', label: '午餐' },
  { key: 'dinner', label: '晚餐' },
  { key: 'snack', label: '加餐' },
];

const CATS = ['荤', '素', '汤', '主食', '甜点'];

let currentDate = todayStr();
let view = 'today';
let libQuery = '';
let libCat = '';
let shoppingRange = 'week';
let adviceCache = {};
let aiBusy = false;

const mealsOn = date => meals.filter(m => m.date === date);

/* ============================== 评分 ============================== */

function scoreDay(dayMeals) {
  const totals = dayMeals.reduce(
    (acc, m) => {
      acc.kcal += m.kcal;
      acc.p += m.p || 0;
      acc.f += m.f || 0;
      acc.c += m.c || 0;
      return acc;
    },
    { kcal: 0, p: 0, f: 0, c: 0 },
  );

  if (!dayMeals.length) {
    return { ...totals, score: null, comment: '今天还没记东西，点「+ 加菜」。', tags: [] };
  }

  let score = 75;
  const notes = [];
  const veg = dayMeals.filter(m => ['素', '汤'].includes(m.cat)).length;
  const fried = dayMeals.filter(m => (m.tags || []).includes('油炸')).length;
  const heavy = dayMeals.filter(m => (m.tags || []).includes('重油')).length;
  const sweet = dayMeals.filter(m => (m.tags || []).includes('甜')).length;
  const staple = dayMeals.filter(m => m.cat === '主食').length;

  if (veg >= 3) { score += 12; notes.push('蔬菜够量'); }
  else if (veg >= 1) { score += 4; notes.push('有一点蔬菜'); }
  else { score -= 12; notes.push('缺蔬菜'); }

  if (totals.p >= 80) { score += 8; notes.push('蛋白质充足'); }
  else if (totals.p >= 50) score += 2;
  else { score -= 8; notes.push('蛋白质偏低'); }

  if (fried) { score -= 7 * fried; notes.push(`油炸 ${fried} 道`); }
  if (heavy) { score -= 5 * heavy; notes.push(`重油 ${heavy} 道`); }
  if (sweet >= 2) { score -= 6; notes.push('甜食偏多'); }
  if (staple >= 4) { score -= 6; notes.push('主食偏多'); }

  const target = num(ui.targetKcal, 1800);
  const dev = Math.abs(totals.kcal - target) / target;
  if (dev > 0.4) { score -= 18; notes.push('热量偏离目标较多'); }
  else if (dev > 0.2) { score -= 8; notes.push('热量略有偏差'); }
  else { score += 5; notes.push('热量接近目标'); }

  score = Math.max(5, Math.min(100, Math.round(score)));

  let comment;
  if (score >= 85) comment = '很均衡的一天，保持这个节奏。';
  else if (score >= 70) comment = '整体不错，稍微调整结构会更好。';
  else if (score >= 55) comment = '能吃饱，但营养结构可以再优化。';
  else comment = '今天偏重口、蔬菜不足，明天补回来。';

  return { ...totals, score, comment, tags: notes };
}

/* ============================== 今天 ============================== */

async function renderToday() {
  const dayMeals = mealsOn(currentDate);
  const s = scoreDay(dayMeals);
  const advice = adviceCache[currentDate];
  const aiReady = isAiReady(config);

  const slots = await Promise.all(
    SLOTS.map(async slot => {
      const items = dayMeals.filter(m => m.slot === slot.key);
      const cards = await Promise.all(items.map(mealCard));
      const kcal = items.reduce((a, m) => a + num(m.kcal), 0);
      return `
        <section class="slot">
          <header>
            <h3>${slot.label}</h3>
            <span class="slot-kcal">${kcal ? kcal + ' kcal' : '—'}</span>
            <button class="btn-ghost" data-action="add-meal" data-slot="${slot.key}">+ 加菜</button>
          </header>
          <div class="slot-items">${cards.length ? cards.join('') : '<p class="empty">还没有记录</p>'}</div>
        </section>`;
    }),
  );

  return `
    <div class="datebar">
      <button class="btn" data-action="shift-day" data-days="-1">←</button>
      <div class="date-main">
        <strong>${humanDate(currentDate)}</strong>
        <input type="date" value="${currentDate}" data-action="pick-date" aria-label="选择日期" />
      </div>
      <button class="btn" data-action="shift-day" data-days="1">→</button>
      <button class="btn-ghost" data-action="go-today">今天</button>
    </div>

    <div class="summary card">
      <div class="sum-kcal">
        <span class="num">${Math.round(s.kcal)}</span>
        <span class="unit">kcal / 目标 ${num(ui.targetKcal, 1800)}</span>
      </div>
      <div class="sum-macros">
        <span>蛋白 ${Math.round(s.p)}g</span>
        <span>脂肪 ${Math.round(s.f)}g</span>
        <span>碳水 ${Math.round(s.c)}g</span>
      </div>
      <div class="sum-score">
        ${s.score === null ? '' : `<span class="score score-${s.score >= 75 ? 'good' : s.score >= 55 ? 'mid' : 'bad'}">${s.score}</span>`}
        <div class="score-body">
          <p>${esc(advice?.comment || s.comment)}</p>
          ${advice?.tips?.length ? `<ul class="tips">${advice.tips.map(t => `<li>${esc(t)}</li>`).join('')}</ul>` : ''}
          ${s.tags.length ? `<p class="notes">${s.tags.map(t => `<em>${esc(t)}</em>`).join('')}</p>` : ''}
        </div>
      </div>
      <div class="ai-row">
        <button class="btn-ghost" data-action="ai-advice" data-date="${currentDate}" ${aiBusy ? 'disabled' : ''}>
          ${aiBusy ? '思考中…' : advice ? '🔄 重新点评' : '✨ AI 点评今天'}
        </button>
        <button class="btn-ghost" data-action="photo-import" ${aiBusy ? 'disabled' : ''}>📷 拍照记一餐</button>
        ${aiReady ? '' : '<span class="hint">（先在设置里填 API Key）</span>'}
      </div>
    </div>

    ${slots.join('')}
  `;
}

async function mealCard(m) {
  const photo = m.imageId ? await imgGet(m.imageId) : null;
  return `
    <article class="meal">
      ${photo ? `<img class="meal-photo" src="${photo}" alt="${esc(m.name)}" />` : ''}
      <div class="meal-body">
        <div class="meal-title">
          <strong>${esc(m.name)}</strong>
          ${m.servings !== 1 ? `<span class="muted">× ${m.servings}</span>` : ''}
        </div>
        <div class="meal-meta">
          <span>${Math.round(m.kcal)} kcal</span>
          ${m.cat ? `<span class="tag">${esc(m.cat)}</span>` : ''}
          ${(m.tags || []).map(t => `<span class="tag tag-warn">${esc(t)}</span>`).join('')}
          ${m.source === 'ai' ? '<span class="tag tag-ai">AI 估</span>' : ''}
          ${m.match === 'guess' || m.match === 'default' ? '<span class="tag tag-dim">估算</span>' : ''}
        </div>
      </div>
      <div class="meal-actions">
        <button class="icon" data-action="meal-photo" data-id="${m.id}" title="上传照片">📷</button>
        <button class="icon" data-action="meal-edit" data-id="${m.id}" title="修改">✎</button>
        <button class="icon danger" data-action="meal-del" data-id="${m.id}" title="删除">✕</button>
      </div>
    </article>`;
}

/* ============================== 菜谱库 ============================== */

async function renderLibrary() {
  const q = libQuery.trim();
  const list = recipes.filter(r => (!q || r.name.includes(q)) && (!libCat || r.cat === libCat));

  const cards = await Promise.all(
    list.map(async r => {
      const photo = r.imageId ? await imgGet(r.imageId) : null;
      return `
        <article class="recipe-open" data-action="recipe-edit" data-id="${r.id}">
          ${photo ? `<img src="${photo}" alt="${esc(r.name)}" />` : '<div class="ph">🍳</div>'}
          ${
            photo
              ? ''
              : `<button class="recipe-gen" data-action="ai-gen-card" data-id="${r.id}" title="AI 生成配图">🎨</button>`
          }
          <div class="recipe-body">
            <strong>${esc(r.name)}</strong>
            <span class="muted">${r.cat || '未分类'} · ${Math.round(r.kcal)} kcal${r.time ? ` · ${r.time}分钟` : ''}</span>
          </div>
        </article>`;
    }),
  );

  return `
    <div class="lib-head">
      <input class="search" type="search" placeholder="搜索菜谱" value="${esc(libQuery)}" data-action="lib-search" />
      <button class="btn-primary" data-action="recipe-new">+ 新建</button>
    </div>
    <div class="chips">
      <button class="chip ${libCat === '' ? 'active' : ''}" data-action="lib-cat" data-cat="">全部</button>
      ${CATS.map(c => `<button class="chip ${libCat === c ? 'active' : ''}" data-action="lib-cat" data-cat="${c}">${c}</button>`).join('')}
      <button class="chip" data-action="seed-import">📚 内置 ${SEED_COUNT} 道</button>
      <button class="chip chip-ai" data-action="ai-suggest">✨ 按食材推荐</button>
    </div>
    ${cards.length ? `<div class="recipe-grid">${cards.join('')}</div>` : '<p class="empty">没有匹配的菜谱</p>'}
  `;
}

/* ============================== 采购清单 ============================== */

function rangeBounds() {
  const today = todayStr();
  if (shoppingRange === 'today') return { from: today, to: today };
  if (shoppingRange === 'week') {
    const dow = new Date(today).getDay() || 7; // 周一=1
    const monday = shiftDate(today, 1 - dow);
    return { from: monday, to: shiftDate(monday, 6) };
  }
  return { from: today, to: shiftDate(today, 6) };
}

function shoppingList() {
  const { from, to } = rangeBounds();
  const main = new Map();
  const aux = new Map();

  for (const m of meals) {
    if (m.date < from || m.date > to) continue;
    const r = m.recipeId ? recipes.find(x => x.id === m.recipeId) : null;
    for (const ing of r?.ingredients || []) {
      if (ing.need === false || !ing.name) continue;
      const bucket = ing.kind === 'aux' ? aux : main;
      bucket.set(ing.name, (bucket.get(ing.name) || 0) + 1);
    }
  }

  const sortDesc = map => [...map.entries()].sort((a, b) => b[1] - a[1]);
  return { main: sortDesc(main), aux: sortDesc(aux), from, to };
}

function shopRowHTML(name, count) {
  const checked = ui.shoppingChecked[name];
  return `
    <li class="${checked ? 'done' : ''}" data-action="shop-toggle" data-ing="${esc(name)}">
      <span class="shop-box">${checked ? '✓' : ''}</span>
      <span class="shop-name">${esc(name)}</span>
      ${count > 1 ? `<em>×${count}</em>` : ''}
    </li>`;
}

function renderShopping() {
  const { main, aux, from, to } = shoppingList();
  const total = main.length + aux.length;
  const done = [...main, ...aux].filter(([name]) => ui.shoppingChecked[name]).length;

  const group = (title, items) =>
    items.length
      ? `<h3>${title}<span class="muted"> · ${items.length}</span></h3>
         <ul class="shoplist">${items.map(([n, c]) => shopRowHTML(n, c)).join('')}</ul>`
      : '';

  return `
    <div class="card">
      <div class="chips">
        <button class="chip ${shoppingRange === 'today' ? 'active' : ''}" data-action="range" data-range="today">今天</button>
        <button class="chip ${shoppingRange === 'week' ? 'active' : ''}" data-action="range" data-range="week">本周</button>
        <button class="chip ${shoppingRange === 'next7' ? 'active' : ''}" data-action="range" data-range="next7">未来 7 天</button>
      </div>
      <p class="muted">${from} ~ ${to} · ${total} 样，已购 ${done}</p>
      ${
        total
          ? group('主材', main) +
            group('辅料', aux) +
            '<button class="btn-ghost" data-action="shop-clear">清空勾选</button>'
          : '<p class="empty">这个时间段还没有菜单。去「今天」加几道菜，菜谱里勾了「计入采购清单」的食材会汇总到这里。</p>'
      }
    </div>
  `;
}

/* ============================== 统计 ============================== */

function renderStats() {
  const days = Array.from({ length: 7 }, (_, i) => shiftDate(todayStr(), i - 6));
  const rows = days.map(d => {
    const ms = mealsOn(d);
    const kcal = ms.reduce((a, m) => a + num(m.kcal), 0);
    return { d, kcal, count: ms.length };
  });

  const max = Math.max(...rows.map(r => r.kcal), 1);
  const recorded = rows.filter(r => r.count > 0);
  const avg = recorded.length ? Math.round(recorded.reduce((a, r) => a + r.kcal, 0) / recorded.length) : 0;

  const all = meals.reduce(
    (a, m) => ({ p: a.p + num(m.p), f: a.f + num(m.f), c: a.c + num(m.c) }),
    { p: 0, f: 0, c: 0 },
  );
  const pKcal = all.p * 4;
  const fKcal = all.f * 9;
  const cKcal = all.c * 4;
  const totalKcal = pKcal + fKcal + cKcal || 1;

  const counter = new Map();
  meals.forEach(m => counter.set(m.name, (counter.get(m.name) || 0) + 1));
  const top = [...counter.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5);

  return `
    <div class="card">
      <h3>最近 7 天</h3>
      <div class="bars">
        ${rows
          .map(
            r => `
          <div class="bar-row">
            <span class="bar-label">${r.d.slice(5)} 周${WEEK[new Date(r.d).getDay()]}</span>
            <div class="bar-track"><div class="bar-fill" style="width:${(r.kcal / max) * 100}%"></div></div>
            <span class="bar-val">${r.kcal || '—'}</span>
          </div>`,
          )
          .join('')}
      </div>
      <p class="muted">有记录 ${recorded.length} 天，平均 ${avg} kcal/天</p>
    </div>

    <div class="card">
      <h3>营养结构（按热量占比）</h3>
      <div class="macro-bar">
        <span style="width:${(pKcal / totalKcal) * 100}%; background:#4a7dbd"></span>
        <span style="width:${(fKcal / totalKcal) * 100}%; background:#c98a2e"></span>
        <span style="width:${(cKcal / totalKcal) * 100}%; background:#5c9c62"></span>
      </div>
      <p class="muted">蛋白 ${Math.round((pKcal / totalKcal) * 100)}% · 脂肪 ${Math.round((fKcal / totalKcal) * 100)}% · 碳水 ${Math.round((cKcal / totalKcal) * 100)}%</p>
    </div>

    <div class="card">
      <h3>最常吃</h3>
      ${top.length ? `<ol class="toplist">${top.map(([n, c]) => `<li><span>${esc(n)}</span><em>${c} 次</em></li>`).join('')}</ol>` : '<p class="empty">还没有数据</p>'}
    </div>
  `;
}

/* ============================== 主渲染 ============================== */

const app = () => document.getElementById('eat-app');

async function render() {
  const el = app();
  if (!el) return;

  try {
    if (view === 'today') el.innerHTML = await renderToday();
    else if (view === 'library') el.innerHTML = await renderLibrary();
    else if (view === 'shopping') el.innerHTML = renderShopping();
    else el.innerHTML = renderStats();
  } catch (err) {
    console.error('[eat] 渲染失败', err);
    el.innerHTML = `<p class="empty">这一页渲染出错了：${esc(err.message)}。刷新页面试试，或把这条消息发给 AI。</p>`;
  }

  document.querySelectorAll('[data-tab]').forEach(t => t.classList.toggle('active', t.dataset.tab === view));
}

/* ============================== 弹窗 ============================== */

const modal = () => document.getElementById('eat-modal');

function openModal(html) {
  const dlg = modal();
  dlg.innerHTML = `<div class="modal-inner">${html}</div>`;
  delete dlg.dataset.pendingPhoto;
  dlg.showModal();
}

function closeModal() {
  const dlg = modal();
  if (dlg.open) dlg.close();
}

function toast(msg) {
  const t = document.getElementById('eat-toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(t._timer);
  t._timer = setTimeout(() => t.classList.remove('show'), 2600);
}

/* ============================== 加菜 ============================== */

function openAddMeal(slot) {
  const label = SLOTS.find(s => s.key === slot)?.label || '';
  openModal(`
    <h2>给${label}加一道</h2>
    <div class="modal-tabs">
      <button class="active" data-mtab="lib">从菜谱库</button>
      <button data-mtab="free">临时记录</button>
    </div>
    <div data-mpane="lib">
      <input class="search" placeholder="搜菜谱或菜名" data-action="meal-search" autocomplete="off" />
      <div class="pick-list" id="pick-list">${pickListHTML('')}</div>
    </div>
    <div data-mpane="free" hidden>
      <label>菜名<input id="free-name" type="text" placeholder="比如：食堂的红烧茄子" /></label>
      <div class="row">
        <label>份量<input id="free-servings" type="number" min="0.5" step="0.5" value="1" /></label>
        <label>热量 kcal<input id="free-kcal" type="number" min="0" value="300" /></label>
      </div>
      <p class="hint" id="free-hint">输入菜名会自动估算，可手动改。</p>
      <div class="modal-actions">
        <button class="btn-ghost" data-action="ai-estimate-meal" data-slot="${slot}">✨ AI 估</button>
        <button class="btn-primary" data-action="free-save" data-slot="${slot}">加入${label}</button>
      </div>
    </div>
    <button class="btn-ghost modal-close" data-action="modal-close">关闭</button>
  `);

  const dlg = modal();
  dlg.dataset.slot = slot;

  const freeName = dlg.querySelector('#free-name');
  const freeKcal = dlg.querySelector('#free-kcal');
  const hint = dlg.querySelector('#free-hint');

  freeName.addEventListener('input', () => {
    const est = estimateDish(freeName.value);
    if (!est) return;
    freeKcal.value = est.kcal;
    const tag = est.match === 'table' ? `匹配「${est.matched}」` : est.match === 'guess' ? est.matched : '默认估值';
    hint.textContent = `估算 ${est.kcal} kcal · ${tag}`;
    Object.assign(hint.dataset, {
      p: est.p,
      f: est.f,
      c: est.c,
      cat: est.cat,
      tags: (est.tags || []).join(','),
      source: est.match,
    });
  });

  dlg.querySelector('[data-action="meal-search"]')?.addEventListener('input', e => {
    const box = dlg.querySelector('#pick-list');
    if (box) box.innerHTML = pickListHTML(e.target.value);
  });
}

function pickListHTML(query) {
  const q = query.trim();
  const fromRecipes = recipes.filter(r => !q || r.name.includes(q)).slice(0, 20);
  const fromDishes = suggest(q, q ? 6 : 8).filter(d => !recipes.some(r => r.name === d.name));

  const a = fromRecipes.map(
    r => `<button class="pick" data-action="pick-recipe" data-id="${r.id}">
            <span>${esc(r.name)}</span><em>${Math.round(r.kcal)} kcal</em>
          </button>`,
  );
  const b = fromDishes.map(
    d => `<button class="pick" data-action="pick-dish" data-name="${esc(d.name)}">
            <span>${esc(d.name)}</span><em>${d.kcal} kcal<small> · 内置表</small></em>
          </button>`,
  );

  if (!a.length && !b.length) return '<p class="empty">没有匹配，切到「临时记录」手填一个。</p>';
  return a.join('') + b.join('');
}

/* ============================== 菜谱表单 ============================== */

function ingRowHTML(ing) {
  const kind = ing.kind === 'aux' ? 'aux' : 'main';
  return `
    <div class="ing-row" data-kind="${kind}">
      <input type="checkbox" class="ing-need" ${ing.need !== false ? 'checked' : ''} title="计入采购清单" />
      <input type="text" class="ing-name" value="${esc(ing.name)}" />
      <button type="button" class="ing-kind" data-action="ing-kind">${kind === 'aux' ? '辅' : '主'}</button>
      <button type="button" class="ing-del" data-action="ing-del" title="删除">×</button>
    </div>`;
}

function ingredientRowsHTML(list) {
  if (!list.length) return '<p class="empty">还没有食材，AI 估算会自动补上，也可以手动加。</p>';
  return list.map(ingRowHTML).join('');
}

function appendIngredientRow(dlg, name) {
  const list = dlg.querySelector('#r-ing-list');
  list.querySelector('.empty')?.remove();
  list.insertAdjacentHTML('beforeend', ingRowHTML({ name, kind: 'main', need: true }));
}

function readIngredientRows(dlg) {
  return [...dlg.querySelectorAll('.ing-row')]
    .map(row => ({
      name: row.querySelector('.ing-name').value.trim(),
      kind: row.dataset.kind === 'aux' ? 'aux' : 'main',
      need: row.querySelector('.ing-need').checked,
    }))
    .filter(x => x.name);
}

async function openRecipeForm(id) {
  const r = id ? recipes.find(x => x.id === id) : null;
  const photo = r?.imageId ? await imgGet(r.imageId) : null;

  openModal(`
    <h2>${r ? '编辑菜谱' : '新建菜谱'}</h2>
    ${r?.source ? `<a class="src-link" href="${esc(r.source)}" target="_blank" rel="noopener">查看参考做法 ↗</a>` : ''}
    <label>菜名<input id="r-name" type="text" value="${esc(r?.name || '')}" /></label>
    <div class="row">
      <label>分类
        <select id="r-cat">${CATS.map(c => `<option ${r?.cat === c ? 'selected' : ''}>${c}</option>`).join('')}</select>
      </label>
      <label>每份热量 kcal<input id="r-kcal" type="number" min="0" value="${r?.kcal ?? 300}" /></label>
    </div>
    <div class="row">
      <label>用时（分钟）<input id="r-time" type="number" min="0" value="${r?.time ?? ''}" /></label>
      <label>难度
        <select id="r-diff">
          ${['简单', '中等', '有点难'].map(x => `<option ${r?.difficulty === x ? 'selected' : ''}>${x}</option>`).join('')}
        </select>
      </label>
      <label>几人份<input id="r-servings" type="number" min="1" step="1" value="${r?.servings ?? 1}" /></label>
    </div>
    <div class="row">
      <label>蛋白 g<input id="r-p" type="number" min="0" step="0.1" value="${r?.p ?? ''}" /></label>
      <label>脂肪 g<input id="r-f" type="number" min="0" step="0.1" value="${r?.f ?? ''}" /></label>
      <label>碳水 g<input id="r-c" type="number" min="0" step="0.1" value="${r?.c ?? ''}" /></label>
    </div>
    <div class="field">
      <span class="field-label">食材 <em>勾选＝计入采购清单</em></span>
      <div class="ing-list" id="r-ing-list">${ingredientRowsHTML(r?.ingredients || [])}</div>
      <div class="ing-add">
        <input id="r-ing-input" type="text" placeholder="加一样，回车确认" />
        <button class="btn-ghost" data-action="ing-add">添加</button>
      </div>
    </div>
    <label>做法<textarea id="r-steps" rows="3" placeholder="一步一行">${esc(r?.steps || '')}</textarea></label>
    <label>小贴士<input id="r-tips" type="text" value="${esc(r?.tips || '')}" placeholder="比如：番茄先炒出汁" /></label>
    <label>参考链接<input id="r-source" type="text" value="${esc(r?.source || '')}" placeholder="https://..." /></label>
    <label class="upload">
      <input id="r-photo" type="file" accept="image/*" capture="environment" hidden />
      <span class="upload-btn">📷 ${photo ? '更换照片' : '上传照片'}</span>
      <img id="r-photo-preview" src="${photo || ''}" ${photo ? '' : 'hidden'} alt="预览" />
    </label>
    <div class="modal-actions">
      <button class="btn-ghost" data-action="ai-estimate-recipe">✨ AI 估营养</button>
      <button class="btn-ghost" data-action="ai-gen-recipe-image">🎨 生成配图</button>
      ${r ? `<button class="btn-danger" data-action="recipe-del" data-id="${r.id}">删除</button>` : ''}
      <button class="btn-ghost" data-action="modal-close">取消</button>
      <button class="btn-primary" data-action="recipe-save" data-id="${r?.id || ''}">保存</button>
    </div>
  `);

  const dlg = modal();
  if (photo) dlg.dataset.pendingPhoto = photo;

  dlg.querySelector('#r-photo').addEventListener('change', async e => {
    const file = e.target.files?.[0];
    if (!file) return;
    const dataUrl = await compressImage(file);
    const preview = dlg.querySelector('#r-photo-preview');
    preview.src = dataUrl;
    preview.hidden = false;
    dlg.dataset.pendingPhoto = dataUrl;
  });

  dlg.querySelector('#r-name').addEventListener('blur', e => {
    const est = estimateDish(e.target.value);
    if (!est) return;
    dlg.querySelector('#r-kcal').value = est.kcal;
    if (!dlg.querySelector('#r-p').value) dlg.querySelector('#r-p').value = est.p;
    if (!dlg.querySelector('#r-f').value) dlg.querySelector('#r-f').value = est.f;
    if (!dlg.querySelector('#r-c').value) dlg.querySelector('#r-c').value = est.c;
  });

  const ingInput = dlg.querySelector('#r-ing-input');
  ingInput.addEventListener('keydown', e => {
    if (e.key !== 'Enter') return;
    e.preventDefault();
    const v = ingInput.value.trim();
    if (!v) return;
    appendIngredientRow(dlg, v);
    ingInput.value = '';
  });
}

/* ============================== AI 操作 ============================== */

async function runAi(btn, fn) {
  if (!isAiReady(config)) {
    toast('先在「设置」里填 API Key');
    if (!modal().open) openSettings();
    return;
  }
  if (aiBusy) return;
  aiBusy = true;
  const oldText = btn?.textContent;
  if (btn) { btn.disabled = true; btn.textContent = '思考中…'; }
  try {
    await fn();
  } catch (err) {
    toast(err instanceof AiError ? err.message : 'AI 调用失败');
  } finally {
    aiBusy = false;
    if (btn) { btn.disabled = false; btn.textContent = oldText; }
  }
}

async function estimateRecipeWithAi() {
  const dlg = modal();
  const name = dlg.querySelector('#r-name').value.trim();
  if (!name) return toast('先填菜名');

  await runAi(dlg.querySelector('[data-action="ai-estimate-recipe"]'), async () => {
    const r = await aiEstimate(config, name);

    dlg.querySelector('#r-kcal').value = r.kcal;
    dlg.querySelector('#r-p').value = r.p;
    dlg.querySelector('#r-f').value = r.f;
    dlg.querySelector('#r-c').value = r.c;
    dlg.querySelector('#r-cat').value = r.cat;
    dlg.querySelector('#r-diff').value = r.difficulty;
    dlg.querySelector('#r-servings').value = r.servings;
    if (r.time) dlg.querySelector('#r-time').value = r.time;
    dlg.querySelector('#r-steps').value = r.steps || '';
    dlg.querySelector('#r-tips').value = r.tips || '';
    dlg.querySelector('#r-ing-list').innerHTML = ingredientRowsHTML(r.ingredients);

    toast(`AI 已填好：${r.kcal} kcal、${r.ingredients.length} 样食材${r.steps ? '、做法' : ''}`);
  });
}

async function estimateMealWithAi(slot) {
  const dlg = modal();
  const name = dlg.querySelector('#free-name').value.trim();
  if (!name) return toast('先填菜名');

  await runAi(dlg.querySelector('[data-action="ai-estimate-meal"]'), async () => {
    const r = await aiEstimate(config, name);
    dlg.querySelector('#free-kcal').value = r.kcal;
    const hint = dlg.querySelector('#free-hint');
    hint.textContent = `AI 估算 ${r.kcal} kcal${r.comment ? ' · ' + r.comment : ''}`;
    Object.assign(hint.dataset, { p: r.p, f: r.f, c: r.c, cat: '荤', tags: '', source: 'ai' });
    toast('AI 估算完成');
  });
}

async function adviseToday(date, btn) {  const dayMeals = mealsOn(date);
  if (!dayMeals.length) return toast('今天还没记录');
  const s = scoreDay(dayMeals);

  await runAi(btn, async () => {
    const res = await aiAdvice(config, {
      dishes: dayMeals.map(m => `${m.name}（${Math.round(m.kcal)} kcal）`),
      kcal: s.kcal,
      p: s.p,
      f: s.f,
      c: s.c,
      target: num(ui.targetKcal, 1800),
    });
    adviceCache[date] = res;
    render();
  });
}

/* ---------- 拍照识别 ---------- */

/* ---------- 生成配图 ---------- */

async function generateRecipeImage() {
  const dlg = modal();
  const name = dlg.querySelector('#r-name').value.trim();
  if (!name) return toast('先填菜名');

  await runAi(dlg.querySelector('[data-action="ai-gen-recipe-image"]'), async () => {
    const img = await aiGenerateImage(config, name);
    const preview = dlg.querySelector('#r-photo-preview');
    preview.src = img;
    preview.hidden = false;
    dlg.dataset.pendingPhoto = img;
    toast('配图已生成，保存菜谱后写入');
  });
}

async function generateCardImage(id, btn) {
  const r = recipes.find(x => x.id === id);
  if (!r) return;

  await runAi(btn, async () => {
    const img = await aiGenerateImage(config, r.name);
    const imgId = uid();
    await imgPut(imgId, img);
    r.imageId = imgId;
    persist();
    await render();
    toast('配图已生成');
  });
}

function photoImport() {
  if (!isAiReady(config)) {
    toast('先在「设置」里填 API Key');
    openSettings();
    return;
  }

  const input = document.createElement('input');
  input.type = 'file';
  input.accept = 'image/*';
  input.capture = 'environment';

  input.onchange = async () => {
    const file = input.files?.[0];
    if (!file) return;

    toast('AI 正在看照片…');
    aiBusy = true;
    try {
      const dataUrl = await compressImage(file, 900, 0.7);
      const list = await aiRecognize(config, dataUrl);
      if (!list.length) throw new AiError('没认出来，换张清楚点的照片');
      openRecognizeModal(list, dataUrl);
    } catch (err) {
      toast(err instanceof AiError ? err.message : '识别失败');
    } finally {
      aiBusy = false;
      await render();
    }
  };

  input.click();
}

function openRecognizeModal(list, photo) {
  openModal(`
    <h2>识别到 ${list.length} 道</h2>
    <img class="recognized-photo" src="${photo}" alt="这餐的照片" />
    <p class="hint">取消勾选不要的，然后选餐次加入「${humanDate(currentDate)}」。</p>
    <div class="pick-list">
      ${list
        .map(
          (x, i) => `
        <label class="pick">
          <input type="checkbox" class="rec-check" data-idx="${i}" checked />
          <span>${esc(x.name)}</span>
          <em>${x.kcal} kcal</em>
        </label>`,
        )
        .join('')}
    </div>
    <label>加到
      <select id="rec-slot">
        ${SLOTS.map(s => `<option value="${s.key}" ${s.key === 'lunch' ? 'selected' : ''}>${s.label}</option>`).join('')}
      </select>
    </label>
    <div class="modal-actions">
      <button class="btn-ghost" data-action="modal-close">取消</button>
      <button class="btn-primary" data-action="rec-add">加入</button>
    </div>
  `);

  modal().dataset.recognized = JSON.stringify(list);
}

function addRecognized() {
  const dlg = modal();
  const list = JSON.parse(dlg.dataset.recognized || '[]');
  const slot = dlg.querySelector('#rec-slot').value;
  const picked = [...dlg.querySelectorAll('.rec-check')]
    .filter(c => c.checked)
    .map(c => list[Number(c.dataset.idx)])
    .filter(Boolean);

  if (!picked.length) return toast('一道都没选');

  for (const it of picked) {
    meals.push({
      id: uid(),
      date: currentDate,
      slot,
      servings: 1,
      name: it.name,
      kcal: it.kcal,
      p: it.p,
      f: it.f,
      c: it.c,
      cat: it.cat,
      tags: [],
      source: 'ai-photo',
      match: 'ai',
    });
  }

  persist();
  closeModal();
  render();
  toast(`已加入 ${picked.length} 道`);
}

function openAiSuggest() {
  openModal(`
    <h2>按食材推荐</h2>
    <label>冰箱里有什么<textarea id="ai-ing" rows="2" placeholder="番茄、鸡蛋、半个洋葱、一小块五花肉"></textarea></label>
    <p class="hint">AI 会给出 3 道能做的菜，可一键存进菜谱库。</p>
    <div id="ai-results"></div>
    <div class="modal-actions">
      <button class="btn-ghost" data-action="modal-close">关闭</button>
      <button class="btn-primary" data-action="ai-suggest-run">✨ 推荐</button>
    </div>
  `);
}

async function runSuggest(btn) {
  const dlg = modal();
  const input = dlg.querySelector('#ai-ing').value.trim();
  if (!input) return toast('先写点食材');

  await runAi(btn, async () => {
    const list = await aiSuggest(config, input);
    dlg.querySelector('#ai-results').innerHTML = `
      <div class="pick-list" style="margin-top:.6rem">
        ${list
          .map(
            (x, i) => `
          <div class="pick" style="cursor:default">
            <span>${esc(x.name)}<small style="display:block;color:var(--muted)">${esc(x.reason)}</small></span>
            <button class="btn-ghost" data-action="ai-save-suggest" data-idx="${i}">存进菜谱</button>
          </div>`,
          )
          .join('')}
      </div>`;
    modal().dataset.suggestions = JSON.stringify(list);
  });
}

async function saveSuggestion(idx) {
  const list = JSON.parse(modal().dataset.suggestions || '[]');
  const item = list[idx];
  if (!item) return;
  const est = estimateDish(item.name);
  recipes.push({
    id: uid(),
    name: item.name,
    cat: est.cat,
    kcal: item.kcal || est.kcal,
    p: est.p,
    f: est.f,
    c: est.c,
    tags: est.tags || [],
    ingredients: [],
    steps: '',
    tips: item.reason || '',
    createdAt: Date.now(),
  });
  persist();
  toast(`已存入「${item.name}」`);
}

/* ============================== 设置 ============================== */

function openSettings() {
  const c = config;
  openModal(`
    <h2>设置</h2>

    <label>每日热量目标 kcal<input id="s-target" type="number" min="800" step="50" value="${num(ui.targetKcal, 1800)}" /></label>

    <hr />
    <h3 class="sec">AI（OpenAI 兼容接口）</h3>
    <label class="switch">
      <input id="s-ai-on" type="checkbox" ${c.ai.enabled ? 'checked' : ''} />
      <span>启用 AI</span>
    </label>
    <label>接口地址<input id="s-base" type="text" value="${esc(c.ai.base_url)}" placeholder="https://api.deepseek.com/v1" /></label>
    <div class="row">
      <label>模型<input id="s-model" type="text" value="${esc(c.ai.model)}" /></label>
      <label>温度<input id="s-temp" type="number" min="0" max="2" step="0.1" value="${c.ai.temperature}" /></label>
    </div>
    <label>API Key<input id="s-key" type="password" value="${esc(c.ai.api_key)}" placeholder="sk-..." autocomplete="off" /></label>
    <label>识图模型（拍照识别用，留空＝用上面的模型）<input id="s-vmodel" type="text" value="${esc(c.ai.vision_model || '')}" placeholder="比如 deepseek-vl2" /></label>
    <label>绘图模型（生成菜品配图用）<input id="s-imodel" type="text" value="${esc(c.ai.image_model || '')}" placeholder="比如 dall-e-3 / flux" /></label>
    <label>绘图接口地址（留空＝用上面的接口）<input id="s-ibase" type="text" value="${esc(c.ai.image_base_url || '')}" placeholder="https://api.example.com/v1" /></label>
    <label>绘图 Key（留空＝用上面的 Key）<input id="s-ikey" type="password" value="${esc(c.ai.image_api_key || '')}" autocomplete="off" /></label>

    <details>
      <summary>提示词（可改）</summary>
      <label>估算<textarea id="s-p-estimate" rows="3">${esc(c.prompts.estimate)}</textarea></label>
      <label>点评<textarea id="s-p-advice" rows="3">${esc(c.prompts.advice)}</textarea></label>
      <label>推荐<textarea id="s-p-suggest" rows="3">${esc(c.prompts.suggest)}</textarea></label>
      <label>识图<textarea id="s-p-vision" rows="3">${esc(c.prompts.vision)}</textarea></label>
      <label>配图<textarea id="s-p-image" rows="3">${esc(c.prompts.image)}</textarea></label>
    </details>

    <div class="modal-actions">
      <button class="btn-ghost" data-action="ai-test">测试连接</button>
      <button class="btn-ghost" data-action="cfg-import">导入 config.txt</button>
      <button class="btn-ghost" data-action="cfg-export">导出 config.txt</button>
    </div>

    <hr />
    <h3 class="sec">数据</h3>
    <div class="modal-actions" style="justify-content:flex-start">
      <button class="btn-ghost" data-action="export">导出备份</button>
      <button class="btn-ghost" data-action="import">导入备份</button>
    </div>

    <div class="modal-actions">
      <button class="btn-ghost" data-action="modal-close">取消</button>
      <button class="btn-primary" data-action="settings-save">保存</button>
    </div>
  `);
}

function saveSettings() {
  const dlg = modal();
  ui.targetKcal = num(dlg.querySelector('#s-target').value, 1800);

  config = mergeConfig({
    ai: {
      enabled: dlg.querySelector('#s-ai-on').checked ? 'true' : 'false',
      base_url: dlg.querySelector('#s-base').value.trim(),
      model: dlg.querySelector('#s-model').value.trim(),
      vision_model: dlg.querySelector('#s-vmodel').value.trim(),
      image_model: dlg.querySelector('#s-imodel').value.trim(),
      image_base_url: dlg.querySelector('#s-ibase').value.trim(),
      image_api_key: dlg.querySelector('#s-ikey').value.trim(),
      api_key: dlg.querySelector('#s-key').value.trim(),
      temperature: dlg.querySelector('#s-temp').value,
    },
    prompts: {
      estimate: dlg.querySelector('#s-p-estimate').value,
      advice: dlg.querySelector('#s-p-advice').value,
      suggest: dlg.querySelector('#s-p-suggest').value,
      vision: dlg.querySelector('#s-p-vision').value,
      image: dlg.querySelector('#s-p-image').value,
    },
  });

  saveConfig(config);
  persist();
  closeModal();
  render();
  toast('设置已保存');
}

function importConfigFile() {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = '.txt,text/plain';
  input.onchange = async () => {
    const file = input.files?.[0];
    if (!file) return;
    try {
      const text = await file.text();
      config = mergeConfig(parseINI(text));
      saveConfig(config);
      closeModal();
      render();
      toast('配置已导入');
    } catch {
      toast('配置文件解析失败');
    }
  };
  input.click();
}

function exportConfigFile() {
  const blob = new Blob([toINI(config)], { type: 'text/plain' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'config.txt';
  a.click();
  URL.revokeObjectURL(a.href);
  toast('已导出 config.txt，放在自己电脑上，别提交到仓库');
}

async function testAi(btn) {
  await runAi(btn, async () => {
    const { ms, reply } = await aiPing(config);
    toast(`连接成功：${ms}ms，「${reply}」`);
  });
}

/* ============================== 数据备份 ============================== */

async function compressImage(file, maxSize = 1000, quality = 0.82) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    const url = URL.createObjectURL(file);
    img.onload = () => {
      const scale = Math.min(1, maxSize / Math.max(img.width, img.height));
      const canvas = document.createElement('canvas');
      canvas.width = Math.round(img.width * scale);
      canvas.height = Math.round(img.height * scale);
      canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
      URL.revokeObjectURL(url);
      resolve(canvas.toDataURL('image/jpeg', quality));
    };
    img.onerror = reject;
    img.src = url;
  });
}

async function exportData() {
  const images = {};
  for (const r of recipes) if (r.imageId) images[r.imageId] = await imgGet(r.imageId);
  for (const m of meals) if (m.imageId) images[m.imageId] = await imgGet(m.imageId);

  // 备份里不带 API Key，避免随手分享备份时泄露
  const safeConfig = { ...config, ai: { ...config.ai, api_key: '' } };
  const payload = { version: 2, recipes, meals, settings: ui, config: safeConfig, images };
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `养乐多在吃什么-${todayStr()}.json`;
  a.click();
  URL.revokeObjectURL(a.href);
}

function importData() {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = 'application/json,.json';
  input.onchange = async () => {
    const file = input.files?.[0];
    if (!file) return;
    try {
      const data = JSON.parse(await file.text());
      if (!confirm('导入会覆盖当前所有记录，确定？')) return;
      recipes = data.recipes || [];
      meals = data.meals || [];
      ui = { ...ui, ...(data.settings || {}) };
      if (data.config) {
        config = mergeConfig(data.config);
        saveConfig(config);
      }
      for (const [id, url] of Object.entries(data.images || {})) await imgPut(id, url);
      persist();
      closeModal();
      render();
      toast('导入完成');
    } catch {
      toast('文件解析失败');
    }
  };
  input.click();
}

/* ============================== 保存菜谱 ============================== */

async function saveRecipe(id) {
  const dlg = modal();
  const name = dlg.querySelector('#r-name').value.trim();
  if (!name) return toast('菜名不能为空');

  const data = {
    name,
    cat: dlg.querySelector('#r-cat').value,
    kcal: num(dlg.querySelector('#r-kcal').value, 300),
    p: num(dlg.querySelector('#r-p').value, 0),
    f: num(dlg.querySelector('#r-f').value, 0),
    c: num(dlg.querySelector('#r-c').value, 0),
    time: num(dlg.querySelector('#r-time').value, 0) || null,
    difficulty: dlg.querySelector('#r-diff').value,
    servings: num(dlg.querySelector('#r-servings').value, 1),
    ingredients: readIngredientRows(dlg),
    steps: dlg.querySelector('#r-steps').value.trim(),
    tips: dlg.querySelector('#r-tips').value.trim(),
    source: dlg.querySelector('#r-source').value.trim(),
  };

  const pending = dlg.dataset.pendingPhoto;
  if (pending) {
    const imgId = uid();
    await imgPut(imgId, pending);
    data.imageId = imgId;
  }

  if (id) {
    const i = recipes.findIndex(r => r.id === id);
    recipes[i] = { ...recipes[i], ...data };
  } else {
    recipes.push({ id: uid(), createdAt: Date.now(), ...data });
  }
  persist();
  closeModal();
  render();
  toast('菜谱已保存');
}

/* ============================== 菜单操作 ============================== */

function addMealEntry(data) {
  const slot = modal().dataset.slot || 'lunch';
  meals.push({ id: uid(), date: currentDate, slot, servings: data.servings ?? 1, ...data });
  persist();
  closeModal();
  render();
  toast('已加入');
}

function addMealFromRecipe(recipe) {
  addMealEntry({
    name: recipe.name,
    kcal: recipe.kcal,
    p: recipe.p,
    f: recipe.f,
    c: recipe.c,
    cat: recipe.cat,
    tags: recipe.tags || [],
    recipeId: recipe.id,
    imageId: recipe.imageId || null,
    match: 'recipe',
  });
}

function openEditMeal(m) {
  openModal(`
    <h2>修改记录</h2>
    <label>菜名<input id="e-name" type="text" value="${esc(m.name)}" /></label>
    <div class="row">
      <label>份量<input id="e-servings" type="number" min="0.5" step="0.5" value="${m.servings ?? 1}" /></label>
      <label>热量 kcal<input id="e-kcal" type="number" min="0" value="${Math.round(m.kcal)}" /></label>
    </div>
    <div class="modal-actions">
      <button class="btn-ghost" data-action="modal-close">取消</button>
      <button class="btn-primary" data-action="meal-save" data-id="${m.id}">保存</button>
    </div>
  `);
}

/* ============================== 事件 ============================== */

document.addEventListener('click', async e => {
  const el = e.target.closest('[data-action], [data-tab], [data-mtab]');
  if (!el) return;

  if (el.dataset.tab) {
    view = el.dataset.tab;
    await render();
    return;
  }

  if (el.dataset.mtab) {
    const dlg = modal();
    dlg.querySelectorAll('[data-mtab]').forEach(b => b.classList.toggle('active', b === el));
    dlg.querySelectorAll('[data-mpane]').forEach(p => { p.hidden = p.dataset.mpane !== el.dataset.mtab; });
    return;
  }

  const action = el.dataset.action;
  if (!action) return;

  switch (action) {
    case 'shift-day':
      currentDate = shiftDate(currentDate, num(el.dataset.days, 1));
      await render();
      break;
    case 'go-today':
      currentDate = todayStr();
      await render();
      break;
    case 'add-meal':
      openAddMeal(el.dataset.slot);
      break;
    case 'modal-close':
      closeModal();
      break;
    case 'pick-recipe': {
      const r = recipes.find(x => x.id === el.dataset.id);
      if (r) addMealFromRecipe(r);
      break;
    }
    case 'pick-dish': {
      const est = estimateDish(el.dataset.name);
      addMealEntry({
        name: el.dataset.name,
        kcal: est.kcal,
        p: est.p,
        f: est.f,
        c: est.c,
        cat: est.cat,
        tags: est.tags,
        match: est.match,
      });
      break;
    }
    case 'free-save': {
      const dlg = modal();
      const name = dlg.querySelector('#free-name').value.trim();
      if (!name) return toast('先写个菜名');
      const servings = num(dlg.querySelector('#free-servings').value, 1);
      const hint = dlg.querySelector('#free-hint');
      addMealEntry({
        name,
        servings,
        kcal: num(dlg.querySelector('#free-kcal').value, 300) * servings,
        p: num(hint.dataset.p) * servings,
        f: num(hint.dataset.f) * servings,
        c: num(hint.dataset.c) * servings,
        cat: hint.dataset.cat || '荤',
        tags: (hint.dataset.tags || '').split(',').filter(Boolean),
        match: 'manual',
        source: hint.dataset.source || '',
      });
      break;
    }
    case 'ai-estimate-meal':
      await estimateMealWithAi(el.dataset.slot);
      break;
    case 'meal-del':
      meals = meals.filter(m => m.id !== el.dataset.id);
      persist();
      await render();
      break;
    case 'meal-edit': {
      const m = meals.find(x => x.id === el.dataset.id);
      if (m) openEditMeal(m);
      break;
    }
    case 'meal-save': {
      const dlg = modal();
      const m = meals.find(x => x.id === el.dataset.id);
      if (m) {
        m.name = dlg.querySelector('#e-name').value.trim() || m.name;
        m.servings = num(dlg.querySelector('#e-servings').value, 1);
        m.kcal = num(dlg.querySelector('#e-kcal').value, m.kcal);
        persist();
      }
      closeModal();
      await render();
      break;
    }
    case 'meal-photo': {
      const input = document.createElement('input');
      input.type = 'file';
      input.accept = 'image/*';
      input.capture = 'environment';
      input.onchange = async () => {
        const file = input.files?.[0];
        if (!file) return;
        const dataUrl = await compressImage(file);
        const id = uid();
        await imgPut(id, dataUrl);
        const m = meals.find(x => x.id === el.dataset.id);
        if (m) { m.imageId = id; persist(); await render(); toast('照片已保存'); }
      };
      input.click();
      break;
    }
    case 'recipe-new':
      await openRecipeForm(null);
      break;
    case 'recipe-edit':
      await openRecipeForm(el.dataset.id);
      break;
    case 'recipe-save':
      await saveRecipe(el.dataset.id);
      break;
    case 'recipe-del':
      if (confirm('删除这道菜谱？已记录的历史不受影响。')) {
        recipes = recipes.filter(r => r.id !== el.dataset.id);
        persist();
        closeModal();
        await render();
      }
      break;
    case 'ing-add': {
      const dlg = modal();
      const input = dlg.querySelector('#r-ing-input');
      const v = input.value.trim();
      if (!v) return toast('先写个食材名');
      appendIngredientRow(dlg, v);
      input.value = '';
      input.focus();
      break;
    }
    case 'ing-del':
      el.closest('.ing-row')?.remove();
      break;
    case 'ing-kind': {
      const row = el.closest('.ing-row');
      if (!row) break;
      const next = row.dataset.kind === 'aux' ? 'main' : 'aux';
      row.dataset.kind = next;
      el.textContent = next === 'aux' ? '辅' : '主';
      break;
    }
    case 'lib-cat':
      libCat = el.dataset.cat;
      await render();
      break;
    case 'seed-import': {
      const n = importSeed(SEED_RECIPES);
      await render();
      toast(n ? `已导入 ${n} 道菜谱` : '内置菜谱都已在库里');
      break;
    }
    case 'ai-suggest':
      openAiSuggest();
      break;
    case 'ai-suggest-run':
      await runSuggest(el);
      break;
    case 'ai-save-suggest':
      await saveSuggestion(num(el.dataset.idx, 0));
      break;
    case 'ai-advice':
      await adviseToday(el.dataset.date, el);
      break;
    case 'ai-estimate-recipe':
      await estimateRecipeWithAi();
      break;
    case 'photo-import':
      photoImport();
      break;
    case 'ai-gen-recipe-image':
      await generateRecipeImage();
      break;
    case 'ai-gen-card':
      await generateCardImage(el.dataset.id, el);
      break;
    case 'rec-add':
      addRecognized();
      break;
    case 'ai-test':
      await testAi(el);
      break;
    case 'range':
      shoppingRange = el.dataset.range;
      await render();
      break;
    case 'shop-toggle': {
      const ing = el.dataset.ing;
      ui.shoppingChecked[ing] = !ui.shoppingChecked[ing];
      persist();
      await render();
      break;
    }
    case 'shop-clear':
      ui.shoppingChecked = {};
      persist();
      await render();
      break;
    case 'open-settings':
      openSettings();
      break;
    case 'settings-save':
      saveSettings();
      break;
    case 'cfg-import':
      importConfigFile();
      break;
    case 'cfg-export':
      exportConfigFile();
      break;
    case 'export':
      await exportData();
      break;
    case 'import':
      importData();
      break;
  }
});

document.addEventListener('input', e => {
  const el = e.target;
  if (el.dataset.action !== 'lib-search') return;
  libQuery = el.value;
  const pos = el.selectionStart;
  renderLibrary().then(html => {
    if (view !== 'library') return;
    app().innerHTML = html;
    const next = app().querySelector('.search');
    if (next) { next.focus(); next.setSelectionRange(pos, pos); }
  });
});

document.addEventListener('change', e => {
  if (e.target.dataset.action === 'pick-date') {
    currentDate = e.target.value || todayStr();
    render();
  }
});

/* ============================== 内置菜谱 ============================== */

function importSeed(list) {
  const existing = new Set(recipes.map(r => r.name));
  let added = 0;
  for (const item of list) {
    if (existing.has(item.name)) continue;
    recipes.push({
      ...item,
      id: uid(),
      ingredients: item.ingredients.map(i => ({ ...i })),
    });
    added++;
  }
  if (added) persist();
  return added;
}

/* ============================== 启动 ============================== */

if (recipes.length === 0) {
  importSeed(SEED_RECIPES);
}

render();

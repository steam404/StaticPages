import { estimateDish, suggest } from '../data/dishes.js';

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

let recipes = loadJSON(LS.recipes, []);
let meals = loadJSON(LS.meals, []);
let settings = loadJSON(LS.settings, { targetKcal: 1800, aiEndpoint: '', aiToken: '' });

const persist = () => {
  saveJSON(LS.recipes, recipes);
  saveJSON(LS.meals, meals);
  saveJSON(LS.settings, settings);
};

/* ---------- 图片存 IndexedDB（dataURL 字符串，避免 blob 生命周期问题） ---------- */

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

/* ============================== 小工具 ============================== */

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
  const isToday = str === todayStr();
  return `${m} 月 ${d} 日 · 周${WEEK[dt.getDay()]}${isToday ? '（今天）' : ''}`;
};

const esc = s =>
  String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const num = (v, fb = 0) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : fb;
};

/* ============================== 状态 ============================== */

const SLOTS = [
  { key: 'breakfast', label: '早餐' },
  { key: 'lunch', label: '午餐' },
  { key: 'dinner', label: '晚餐' },
  { key: 'snack', label: '加餐' },
];

let currentDate = todayStr();
let view = 'today';
let libraryQuery = '';

const mealsOn = date => meals.filter(m => m.date === date);

/* ============================== 健康评分 ============================== */

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

  if (dayMeals.length === 0) {
    return { ...totals, score: null, comment: '今天还没记东西，点上面的「+」加一道菜。', tags: [] };
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
  else if (totals.p >= 50) { score += 2; }
  else { score -= 8; notes.push('蛋白质偏低'); }

  if (fried) { score -= 7 * fried; notes.push(`油炸 ${fried} 道`); }
  if (heavy) { score -= 5 * heavy; notes.push(`重油 ${heavy} 道`); }
  if (sweet >= 2) { score -= 6; notes.push('甜食偏多'); }
  if (staple >= 4) { score -= 6; notes.push('主食偏多'); }

  const target = num(settings.targetKcal, 1800);
  const dev = Math.abs(totals.kcal - target) / target;
  if (dev > 0.4) { score -= 18; notes.push('热量偏离目标较多'); }
  else if (dev > 0.2) { score -= 8; notes.push('热量略有偏差'); }
  else { score += 5; notes.push('热量接近目标'); }

  score = Math.max(5, Math.min(100, Math.round(score)));

  let comment;
  if (score >= 85) comment = '很均衡的一天，保持这个节奏。';
  else if (score >= 70) comment = '整体不错，稍微调整一下结构会更好。';
  else if (score >= 55) comment = '能吃饱，但营养结构可以再优化。';
  else comment = '今天偏重口/偏少蔬菜，明天补回来。';

  return { ...totals, score, comment, tags: notes };
}

/* ============================== 渲染：今天 ============================== */

async function renderToday() {
  const dayMeals = mealsOn(currentDate);
  const summary = scoreDay(dayMeals);

  const slotBlocks = await Promise.all(
    SLOTS.map(async slot => {
      const items = dayMeals.filter(m => m.slot === slot.key);
      const cards = await Promise.all(items.map(mealCard));
      const slotKcal = items.reduce((s, m) => s + num(m.kcal), 0);
      return `
        <section class="slot">
          <header>
            <h3>${slot.label}</h3>
            <span class="slot-kcal">${slotKcal ? slotKcal + ' kcal' : '—'}</span>
            <button class="btn-ghost" data-action="add-meal" data-slot="${slot.key}">+ 加菜</button>
          </header>
          <div class="slot-items">
            ${cards.length ? cards.join('') : `<p class="empty">还没有记录</p>`}
          </div>
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
        <span class="num">${Math.round(summary.kcal)}</span>
        <span class="unit">kcal / 目标 ${num(settings.targetKcal, 1800)}</span>
      </div>
      <div class="sum-macros">
        <span>蛋白 ${Math.round(summary.p)}g</span>
        <span>脂肪 ${Math.round(summary.f)}g</span>
        <span>碳水 ${Math.round(summary.c)}g</span>
      </div>
      <div class="sum-score">
        ${summary.score === null ? '' : `<span class="score score-${summary.score >= 75 ? 'good' : summary.score >= 55 ? 'mid' : 'bad'}">${summary.score}</span>`}
        <p>${esc(summary.comment)}</p>
        ${summary.tags.length ? `<p class="notes">${summary.tags.map(t => `<em>${esc(t)}</em>`).join('')}</p>` : ''}
      </div>
    </div>

    ${slotBlocks.join('')}
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

/* ============================== 渲染：菜谱库 ============================== */

async function renderLibrary() {
  const q = libraryQuery.trim();
  const list = q ? recipes.filter(r => r.name.includes(q)) : recipes;

  const cards = await Promise.all(
    list.map(async r => {
      const photo = r.imageId ? await imgGet(r.imageId) : null;
      return `
        <article class="recipe-open" data-action="recipe-edit" data-id="${r.id}">
          ${photo ? `<img src="${photo}" alt="${esc(r.name)}" />` : `<div class="ph">🍳</div>`}
          <div class="recipe-body">
            <strong>${esc(r.name)}</strong>
            <span class="muted">${r.cat || '未分类'} · ${Math.round(r.kcal)} kcal</span>
          </div>
        </article>`;
    }),
  );

  return `
    <div class="lib-head">
      <input class="search" type="search" placeholder="搜索菜谱" value="${esc(libraryQuery)}" data-action="lib-search" />
      <button class="btn-primary" data-action="recipe-new">+ 新建菜谱</button>
    </div>
    ${cards.length ? `<div class="recipe-grid">${cards.join('')}</div>` : `<p class="empty">${q ? '没搜到，换个词试试' : '菜谱库还是空的，先建一道常做的菜。'}</p>`}
    <div class="lib-foot">
      <button class="btn-ghost" data-action="open-settings">⚙ 设置</button>
      <button class="btn-ghost" data-action="export">导出备份</button>
      <button class="btn-ghost" data-action="import">导入备份</button>
    </div>
  `;
}

/* ============================== 渲染：统计 ============================== */

function renderStats() {
  const days = Array.from({ length: 7 }, (_, i) => shiftDate(todayStr(), i - 6));
  const rows = days.map(d => {
    const ms = mealsOn(d);
    const kcal = ms.reduce((s, m) => s + num(m.kcal), 0);
    return { d, kcal, count: ms.length, score: scoreDay(ms).score };
  });

  const max = Math.max(...rows.map(r => r.kcal), 1);
  const recorded = rows.filter(r => r.count > 0);
  const avg = recorded.length ? Math.round(recorded.reduce((s, r) => s + r.kcal, 0) / recorded.length) : 0;

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
            <span class="bar-val">${r.kcal ? r.kcal : '—'}</span>
          </div>`,
          )
          .join('')}
      </div>
      <p class="muted">有记录的 ${recorded.length} 天，平均 ${avg} kcal/天</p>
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
  if (view === 'today') el.innerHTML = await renderToday();
  else if (view === 'library') el.innerHTML = await renderLibrary();
  else el.innerHTML = renderStats();

  document.querySelectorAll('[data-tab]').forEach(t => {
    t.classList.toggle('active', t.dataset.tab === view);
  });
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
  t._timer = setTimeout(() => t.classList.remove('show'), 2200);
}

/* ---------- 加菜弹窗 ---------- */

function openAddMeal(slot) {
  const slotLabel = SLOTS.find(s => s.key === slot)?.label || '';
  openModal(`
    <h2>给${slotLabel}加一道</h2>
    <div class="modal-tabs">
      <button class="active" data-mtab="lib">从菜谱库</button>
      <button data-mtab="free">临时记录</button>
    </div>
    <div data-mpane="lib">
      <input class="search" placeholder="搜菜谱或输入菜名" data-action="meal-search" autocomplete="off" />
      <div class="pick-list" id="pick-list">${pickListHTML('')}</div>
    </div>
    <div data-mpane="free" hidden>
      <label>菜名<input id="free-name" type="text" placeholder="比如：食堂的红烧茄子" /></label>
      <div class="row">
        <label>份量<input id="free-servings" type="number" min="0.5" step="0.5" value="1" /></label>
        <label>热量 kcal<input id="free-kcal" type="number" min="0" value="300" /></label>
      </div>
      <p class="hint" id="free-hint">输入菜名会自动估算，可手动改。</p>
      <button class="btn-primary" data-action="free-save" data-slot="${slot}">加入${slotLabel}</button>
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
    hint.dataset.p = est.p;
    hint.dataset.f = est.f;
    hint.dataset.c = est.c;
    hint.dataset.cat = est.cat;
    hint.dataset.tags = (est.tags || []).join(',');
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

  const recipeItems = fromRecipes.map(
    r => `<button class="pick" data-action="pick-recipe" data-id="${r.id}">
            <span>${esc(r.name)}</span><em>${Math.round(r.kcal)} kcal</em>
          </button>`,
  );

  const dishItems = fromDishes.map(
    d => `<button class="pick" data-action="pick-dish" data-name="${esc(d.name)}">
            <span>${esc(d.name)}</span><em>${d.kcal} kcal<small> · 内置表</small></em>
          </button>`,
  );

  if (!recipeItems.length && !dishItems.length) {
    return `<p class="empty">没有匹配，切到「临时记录」手填一个。</p>`;
  }
  return recipeItems.join('') + dishItems.join('');
}

/* ---------- 菜谱编辑 ---------- */

async function openRecipeForm(id) {
  const r = id ? recipes.find(x => x.id === id) : null;
  const photo = r?.imageId ? await imgGet(r.imageId) : null;

  openModal(`
    <h2>${r ? '编辑菜谱' : '新建菜谱'}</h2>
    <label>菜名<input id="r-name" type="text" value="${esc(r?.name || '')}" /></label>
    <div class="row">
      <label>分类
        <select id="r-cat">
          ${['荤', '素', '汤', '主食', '甜点'].map(c => `<option ${r?.cat === c ? 'selected' : ''}>${c}</option>`).join('')}
        </select>
      </label>
      <label>每份热量 kcal<input id="r-kcal" type="number" min="0" value="${r?.kcal ?? 300}" /></label>
    </div>
    <div class="row">
      <label>蛋白 g<input id="r-p" type="number" min="0" step="0.1" value="${r?.p ?? ''}" /></label>
      <label>脂肪 g<input id="r-f" type="number" min="0" step="0.1" value="${r?.f ?? ''}" /></label>
      <label>碳水 g<input id="r-c" type="number" min="0" step="0.1" value="${r?.c ?? ''}" /></label>
    </div>
    <label>食材（逗号分隔）<input id="r-ing" type="text" value="${esc((r?.ingredients || []).join('，'))}" placeholder="番茄，鸡蛋，油，盐" /></label>
    <label>做法<textarea id="r-steps" rows="3" placeholder="随便记，自己看得懂就行">${esc(r?.steps || '')}</textarea></label>
    <label class="upload">
      <input id="r-photo" type="file" accept="image/*" capture="environment" hidden />
      <span class="upload-btn">📷 ${photo ? '更换照片' : '上传照片'}</span>
      <img id="r-photo-preview" src="${photo || ''}" ${photo ? '' : 'hidden'} alt="预览" />
    </label>
    <div class="modal-actions">
      ${r ? `<button class="btn-danger" data-action="recipe-del" data-id="${r.id}">删除</button>` : ''}
      <button class="btn-ghost" data-action="modal-close">取消</button>
      <button class="btn-primary" data-action="recipe-save" data-id="${r?.id || ''}">保存</button>
    </div>
  `);

  const fileInput = modal().querySelector('#r-photo');
  fileInput.addEventListener('change', async e => {
    const file = e.target.files?.[0];
    if (!file) return;
    const dataUrl = await compressImage(file);
    modal().querySelector('#r-photo-preview').src = dataUrl;
    modal().querySelector('#r-photo-preview').hidden = false;
    modal().dataset.pendingPhoto = dataUrl;
  });
  if (photo) modal().dataset.pendingPhoto = photo;

  modal().querySelector('#r-name').addEventListener('blur', e => {
    const est = estimateDish(e.target.value);
    if (!est) return;
    const dlg = modal();
    dlg.querySelector('#r-kcal').value = est.kcal;
    if (!dlg.querySelector('#r-p').value) dlg.querySelector('#r-p').value = est.p;
    if (!dlg.querySelector('#r-f').value) dlg.querySelector('#r-f').value = est.f;
    if (!dlg.querySelector('#r-c').value) dlg.querySelector('#r-c').value = est.c;
  });
}

/* ============================== 图片压缩 ============================== */

function compressImage(file, maxSize = 1000, quality = 0.82) {
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

/* ============================== 事件 ============================== */

document.addEventListener('click', async e => {
  const el = e.target.closest('[data-action], [data-tab], [data-mtab]');
  if (!el) return;

  if (el.dataset.tab) {
    view = el.dataset.tab;
    render();
    return;
  }

  if (el.dataset.mtab) {
    const dlg = modal();
    dlg.querySelectorAll('[data-mtab]').forEach(b => b.classList.toggle('active', b === el));
    dlg.querySelectorAll('[data-mpane]').forEach(p => {
      p.hidden = p.dataset.mpane !== el.dataset.mtab;
    });
    return;
  }

  const action = el.dataset.action;
  if (!action) return;

  switch (action) {
    case 'shift-day':
      currentDate = shiftDate(currentDate, num(el.dataset.days, 1));
      render();
      break;
    case 'go-today':
      currentDate = todayStr();
      render();
      break;
    case 'add-meal':
      openAddMeal(el.dataset.slot);
      break;
    case 'modal-close':
      closeModal();
      break;
    case 'pick-recipe': {
      const r = recipes.find(x => x.id === el.dataset.id);
      if (!r) break;
      await addMealFromRecipe(r, modal().dataset.slot);
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
      const hintEl = dlg.querySelector('#free-hint');
      addMealEntry({
        name,
        servings,
        kcal: num(dlg.querySelector('#free-kcal').value, 300) * servings,
        p: num(hintEl.dataset.p) * servings,
        f: num(hintEl.dataset.f) * servings,
        c: num(hintEl.dataset.c) * servings,
        cat: hintEl.dataset.cat || '荤',
        tags: (hintEl.dataset.tags || '').split(',').filter(Boolean),
        match: 'manual',
      });
      break;
    }
    case 'meal-del':
      meals = meals.filter(m => m.id !== el.dataset.id);
      persist();
      render();
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
      render();
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
        if (m) {
          m.imageId = id;
          persist();
          render();
          toast('照片已保存');
        }
      };
      input.click();
      break;
    }
    case 'recipe-new':
      openRecipeForm(null);
      break;
    case 'recipe-edit':
      openRecipeForm(el.dataset.id);
      break;
    case 'recipe-save':
      await saveRecipe(el.dataset.id);
      break;
    case 'recipe-del':
      if (confirm('删除这道菜谱？已记录的历史不受影响。')) {
        recipes = recipes.filter(r => r.id !== el.dataset.id);
        persist();
        closeModal();
        render();
      }
      break;
    case 'open-settings':
      openSettings();
      break;
    case 'settings-save':
      saveSettings();
      break;
    case 'export':
      exportData();
      break;
    case 'import':
      importData();
      break;
  }
});

document.addEventListener('input', e => {
  const el = e.target;
  if (el.dataset.action === 'lib-search') {
    libraryQuery = el.value;
    const pos = el.selectionStart;
    renderLibrary().then(html => {
      if (view !== 'library') return;
      app().innerHTML = html;
      const next = app().querySelector('.search');
      if (next) {
        next.focus();
        next.setSelectionRange(pos, pos);
      }
    });
  }
});

document.addEventListener('change', e => {
  if (e.target.dataset.action === 'pick-date') {
    currentDate = e.target.value || todayStr();
    render();
  }
});

/* ---------- 增删改 ---------- */

async function addMealFromRecipe(recipe, slot) {
  const photoId = recipe.imageId || null;
  addMealEntry({
    name: recipe.name,
    kcal: recipe.kcal,
    p: recipe.p,
    f: recipe.f,
    c: recipe.c,
    cat: recipe.cat,
    tags: recipe.tags || [],
    match: 'recipe',
    recipeId: recipe.id,
    imageId: photoId,
  });
}

function addMealEntry(data) {
  const slot = modal().dataset.slot || 'lunch';
  meals.push({
    id: uid(),
    date: currentDate,
    slot,
    servings: data.servings ?? 1,
    ...data,
  });
  persist();
  closeModal();
  render();
  toast('已加入');
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

async function saveRecipe(id) {
  const dlg = modal();
  const name = dlg.querySelector('#r-name').value.trim();
  if (!name) return toast('菜名不能为空');

  const ingredientsRaw = dlg.querySelector('#r-ing').value;
  const data = {
    name,
    cat: dlg.querySelector('#r-cat').value,
    kcal: num(dlg.querySelector('#r-kcal').value, 300),
    p: num(dlg.querySelector('#r-p').value, 0),
    f: num(dlg.querySelector('#r-f').value, 0),
    c: num(dlg.querySelector('#r-c').value, 0),
    ingredients: ingredientsRaw.split(/[,，、]/).map(s => s.trim()).filter(Boolean),
    steps: dlg.querySelector('#r-steps').value.trim(),
    tags: [],
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

/* ---------- 设置 / 备份 ---------- */

function openSettings() {
  openModal(`
    <h2>设置</h2>
    <label>每日热量目标 kcal<input id="s-target" type="number" min="800" step="50" value="${num(settings.targetKcal, 1800)}" /></label>
    <hr />
    <p class="hint">
      AI 估算接口（可选）：内置表匹配不到时，把菜名发给这个地址，期望返回
      <code>{ "kcal": 数字, "p": 数字, "f": 数字, "c": 数字, "comment": "一句话" }</code>。
      留空则只用内置表。
    </p>
    <label>接口地址<input id="s-endpoint" type="text" placeholder="https://你的-worker.workers.dev/estimate" value="${esc(settings.aiEndpoint || '')}" /></label>
    <label>Token（可选）<input id="s-token" type="text" value="${esc(settings.aiToken || '')}" /></label>
    <div class="modal-actions">
      <button class="btn-ghost" data-action="modal-close">取消</button>
      <button class="btn-primary" data-action="settings-save">保存</button>
    </div>
  `);
}

function saveSettings() {
  const dlg = modal();
  settings.targetKcal = num(dlg.querySelector('#s-target').value, 1800);
  settings.aiEndpoint = dlg.querySelector('#s-endpoint').value.trim();
  settings.aiToken = dlg.querySelector('#s-token').value.trim();
  persist();
  closeModal();
  render();
  toast('设置已保存');
}

async function exportData() {
  const images = {};
  for (const r of recipes) if (r.imageId) images[r.imageId] = await imgGet(r.imageId);
  for (const m of meals) if (m.imageId) images[m.imageId] = await imgGet(m.imageId);

  const blob = new Blob([JSON.stringify({ version: 1, recipes, meals, settings, images }, null, 2)], {
    type: 'application/json',
  });
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
      settings = { ...settings, ...(data.settings || {}) };
      for (const [id, url] of Object.entries(data.images || {})) await imgPut(id, url);
      persist();
      render();
      toast('导入完成');
    } catch {
      toast('文件解析失败');
    }
  };
  input.click();
}

/* ============================== 启动 ============================== */

render();

// 预置几道常见菜，第一次打开不至于空荡荡
if (recipes.length === 0) {
  const starters = ['番茄炒蛋', '清炒时蔬', '米饭', '西红柿鸡蛋汤'];
  starters.forEach(name => {
    const est = estimateDish(name);
    recipes.push({
      id: uid(),
      name,
      cat: est.cat,
      kcal: est.kcal,
      p: est.p,
      f: est.f,
      c: est.c,
      tags: est.tags,
      ingredients: [],
      steps: '',
      createdAt: Date.now(),
    });
  });
  persist();
  render();
}

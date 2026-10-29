/**
 * 养乐多在看什么：全球新闻 / 书籍
 *
 * - 新闻：调用 AI 生成当日要闻，结果缓存在 localStorage，可手动刷新
 * - 书籍：TXT 上传到 IndexedDB，自动解析章节目录，带阅读进度
 */

/* ============================== 小工具 ============================== */

import { parseChapters } from './chapter-parser.js';
import { loadConfig, saveConfig, isAiReady } from './config.js';
import { aiNews, aiNewsSummaries } from './ai.js';
import { RECOMMENDS } from '../data/recommends.js';

const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);

const esc = s =>
  String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const loadJSON = (k, fb) => {
  try {
    const raw = localStorage.getItem(k);
    return raw ? JSON.parse(raw) : fb;
  } catch {
    return fb;
  }
};

const saveJSON = (k, v) => localStorage.setItem(k, JSON.stringify(v));

/* ============================== IndexedDB ============================== */

const DB_NAME = 'yakult-read';
let dbPromise = null;

function openDb() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise(resolve => {
    try {
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains('books')) db.createObjectStore('books', { keyPath: 'id' });
        if (!db.objectStoreNames.contains('texts')) db.createObjectStore('texts');
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
  return dbPromise;
}

function tx(store, mode) {
  return openDb().then(db => (db ? db.transaction(store, mode).objectStore(store) : null));
}

async function dbPut(store, value, key) {
  const s = await tx(store, 'readwrite');
  if (!s) throw new Error('浏览器不支持本地存储（IndexedDB 不可用）');
  return new Promise((resolve, reject) => {
    const r = key === undefined ? s.put(value) : s.put(value, key);
    r.onsuccess = () => resolve(true);
    r.onerror = () => reject(r.error);
  });
}

async function dbGet(store, key) {
  const s = await tx(store, 'readonly');
  if (!s) return null;
  return new Promise(resolve => {
    const r = s.get(key);
    r.onsuccess = () => resolve(r.result ?? null);
    r.onerror = () => resolve(null);
  });
}

async function dbGetAll(store) {
  const s = await tx(store, 'readonly');
  if (!s) return [];
  return new Promise(resolve => {
    const r = s.getAll();
    r.onsuccess = () => resolve(r.result || []);
    r.onerror = () => resolve([]);
  });
}

async function dbDel(store, key) {
  const s = await tx(store, 'readwrite');
  if (!s) return;
  s.delete(key);
}

/* ============================== 状态 ============================== */

const LS = {
  news: 'yakult.read.news',
  font: 'yakult.read.font',
};

let newsCache = loadJSON(LS.news, { at: 0, items: [], summaries: [] });
const NEWS_LIMIT = 5;
let newsBusy = false;
let books = [];
let tab = 'books'; // news | books
let reader = null; // { meta, text, index }
let fontSize = Number(localStorage.getItem(LS.font)) || 17;
let bookView = 'shelf'; // shelf | recs
let bookQuery = '';

const app = () => document.getElementById('read-app');

/* ============================== TXT 解析 ============================== */

/** 优先按 UTF-8 解码，失败再试 GBK（中文小说常见） */
async function readTextFile(file) {
  const buf = await file.arrayBuffer();
  try {
    return { text: new TextDecoder('utf-8', { fatal: true }).decode(buf), encoding: 'UTF-8' };
  } catch {
    try {
      return { text: new TextDecoder('gbk').decode(buf), encoding: 'GBK' };
    } catch {
      return { text: new TextDecoder('utf-8').decode(buf), encoding: 'UTF-8(容错)' };
    }
  }
}

const sizeText = bytes =>
  bytes > 1024 * 1024 ? (bytes / 1024 / 1024).toFixed(1) + ' MB' : Math.max(1, Math.round(bytes / 1024)) + ' KB';

/* ============================== 渲染：书架 / 书单 ============================== */

const normText = s => String(s || '').toLowerCase().replace(/\s+/g, '');

function fuzzyHit(text, q) {
  if (!q) return true;
  let i = 0;
  for (const ch of text) {
    if (ch === q[i]) i++;
    if (i === q.length) return true;
  }
  return false;
}

function matchShelf(b, q) {
  if (!q) return true;
  const t = normText(b.title);
  return t.includes(q) || fuzzyHit(t, q);
}

function matchRec(r, q) {
  if (!q) return true;
  return [r.title, r.author, r.cat, r.intro, r.reason].map(normText).some(f => f.includes(q) || fuzzyHit(f, q));
}

function bookCard(b) {
  const total = b.chapters.length;
  const done = b.progress?.chapter ?? 0;
  const pct = total ? Math.round(((done + 1) / total) * 100) : 0;
  return `
    <article class="book" data-action="open-book" data-id="${b.id}">
      <div class="book-cover">📖</div>
      <div class="book-info">
        <strong>${esc(b.title)}</strong>
        <span class="muted">${total} 章 · ${sizeText(b.size)}</span>
        <div class="book-progress"><span style="width:${Math.min(100, pct)}%"></span></div>
        <span class="muted small">${b.progress ? `读到「${esc(b.chapters[done]?.title || '开始')}」` : '还没开始读'}</span>
      </div>
      <button class="icon danger" data-action="del-book" data-id="${b.id}" title="删除">✕</button>
    </article>`;
}

function recCard(r) {
  return `
    <details class="rec">
      <summary>
        <span class="rec-head">
          <strong>${esc(r.title)}</strong>
          <span class="muted small">${esc(r.author)} · ${esc(r.cat)}</span>
        </span>
        <span class="rec-intro">${esc(r.intro)}</span>
      </summary>
      <p class="rec-reason">${esc(r.reason)}</p>
    </details>`;
}

async function bookListHTML() {
  const q = normText(bookQuery);

  if (bookView === 'recs') {
    const list = RECOMMENDS.filter(r => matchRec(r, q));
    if (!list.length) return `<p class="empty">推荐里没找到「${esc(bookQuery)}」</p>`;
    return `<div class="rec-list">${list.map(recCard).join('')}</div>`;
  }

  const list = books.filter(b => matchShelf(b, q));
  if (list.length) return `<div class="book-list">${list.map(bookCard).join('')}</div>`;

  if (books.length) return `<p class="empty">书架里没找到「${esc(bookQuery)}」</p>`;

  return `
    <div class="read-empty card">
      <p class="big">📚</p>
      <p>书架还是空的。上传一个 <code>.txt</code> 就能开始读。</p>
      <p class="muted">文件只存在你这台设备的浏览器里，不会上传到任何服务器。</p>
      <button class="btn-primary" data-action="upload">上传 TXT</button>
    </div>`;
}

async function renderBooks() {
  books = (await dbGetAll('books')).sort((a, b) => b.createdAt - a.createdAt);

  return `
    <div class="read-head">
      <span class="muted">书架 ${books.length} 本</span>
      <button class="btn-primary" data-action="upload">＋ 上传 TXT</button>
    </div>

    <input class="search" type="search" placeholder="搜书名 / 作者" value="${esc(bookQuery)}" data-action="book-search" autocomplete="off" />

    <div class="chips">
      <button class="chip ${bookView === 'shelf' ? 'active' : ''}" data-action="book-view" data-view="shelf">📚 我的书架</button>
      <button class="chip ${bookView === 'recs' ? 'active' : ''}" data-action="book-view" data-view="recs">🍶 养乐多的推荐</button>
    </div>

    <div id="book-list">${await bookListHTML()}</div>

    ${
      bookView === 'recs'
        ? '<p class="news-note">点书名可以展开推荐理由。都是读完有印象的，不是必读书单。</p>'
        : ''
    }
  `;
}

async function updateBookList() {
  if (tab !== 'books' || reader) return;
  const box = app()?.querySelector('#book-list');
  if (!box) return;
  box.innerHTML = await bookListHTML();
}

/* ============================== 渲染：阅读器 ============================== */

function renderReader() {
  const { meta, text, index } = reader;
  const ch = meta.chapters[index];
  const body = text.slice(ch.start, ch.end).trim();

  return `
    <div class="reader">
      <header class="reader-head">
        <button class="btn-ghost" data-action="close-book">← 书架</button>
        <div class="reader-title">
          <strong>${esc(meta.title)}</strong>
          <span class="muted">${esc(ch.title)}</span>
        </div>
        <button class="btn-ghost" data-action="toc">目录</button>
      </header>

      <div class="reader-body" id="reader-body" style="font-size:${fontSize}px">${esc(body)}</div>

      <footer class="reader-foot">
        <button class="btn-ghost" data-action="prev-ch" ${index === 0 ? 'disabled' : ''}>上一章</button>
        <span class="reader-pos">${index + 1} / ${meta.chapters.length}</span>
        <button class="btn-ghost" data-action="next-ch" ${index === meta.chapters.length - 1 ? 'disabled' : ''}>下一章</button>
        <span class="reader-font">
          <button class="icon" data-action="font-minus" title="缩小">A－</button>
          <button class="icon" data-action="font-plus" title="放大">A＋</button>
        </span>
      </footer>
    </div>
  `;
}

/* ============================== 渲染：全球新闻 ============================== */

const pad2 = n => String(n).padStart(2, '0');

const fmtTime = ts => {
  const d = new Date(ts);
  return `${d.getMonth() + 1} 月 ${d.getDate()} 日 ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
};

function timeAgo(ts) {
  if (!ts) return '';
  const mins = Math.round((Date.now() - ts) / 60000);
  if (mins < 1) return '刚刚';
  if (mins < 60) return `${mins} 分钟前`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours} 小时前`;
  return `${Math.round(hours / 24)} 天前`;
}

function newsCard(n, i) {
  const title = n.link
    ? `<a href="${esc(n.link)}" target="_blank" rel="noopener noreferrer">${esc(n.title)}</a>`
    : esc(n.title);

  const aiSummary = (newsCache.summaries || [])[i] || '';
  const summary = aiSummary || n.summary || '';

  return `
    <article class="news-item">
      <div class="news-head">
        <strong>${title}</strong>
        ${n.source ? `<span class="news-source">${esc(n.source)}</span>` : ''}
      </div>
      ${
        summary
          ? `<p class="news-summary">${aiSummary ? '<span class="sum-tag">AI 总结</span>' : ''}${esc(summary)}</p>`
          : ''
      }
      <div class="news-foot">
        ${n.at ? `<span class="muted small">${timeAgo(n.at)}</span>` : ''}
        ${
          n.link
            ? ''
            : `<a class="news-search" href="https://www.bing.com/search?q=${encodeURIComponent(n.title)}" target="_blank" rel="noopener noreferrer">搜索这条 ↗</a>`
        }
      </div>
    </article>`;
}

function renderNews() {
  const items = (newsCache.items || []).slice(0, NEWS_LIMIT);
  const fromRss = newsCache.source === 'rss';
  const ready = isAiReady(loadConfig());

  return `
    <div class="read-head">
      <span class="muted">${
        newsCache.at
          ? `更新于 ${fmtTime(newsCache.at)}${newsCache.source ? (fromRss ? ' · RSS' : ' · AI') : ''}`
          : '还没拉取'
      }</span>
      <button class="btn-primary" data-action="refresh-news" ${newsBusy ? 'disabled' : ''}>
        ${newsBusy ? '拉取中…' : '🔄 刷新'}
      </button>
    </div>

    ${
      items.length
        ? `<div class="news-list">${items.map(newsCard).join('')}</div>`
        : `<div class="read-empty card">
             <p class="big">🌍</p>
             <p>点「刷新」，拉一次今天的全球要闻。</p>
             ${ready ? '' : '<p class="muted small">如果 RSS 接口没部署，会回退到 AI，需要先在右上角 ⚙ 填 Key。</p>'}
           </div>`
    }

    <p class="news-note">${
      fromRss
        ? '来自 BBC、纽约时报中文网、卫报等媒体的 RSS，点标题看原文。'
        : '内容由 AI 整理，时效性取决于所用模型是否能联网。'
    }</p>
  `;
}

async function refreshNews() {
  if (newsBusy) return;

  newsBusy = true;
  await render();

  try {
    let items = [];
    let source = '';

    // 优先走同域 RSS 接口（Worker 抓取，最可靠）
    try {
      const res = await fetch('/api/news', { cache: 'no-store' });
      if (!res.ok) throw new Error(`接口返回 ${res.status}`);
      const data = await res.json();
      if (!data.items?.length) throw new Error(data.error || '接口没有内容');
      items = data.items;
      source = 'rss';
    } catch (rssErr) {
      // 没有 Worker / 抓取失败时，退回 AI
      const config = loadConfig();
      if (!isAiReady(config)) throw rssErr;
      items = await aiNews(config);
      source = 'ai';
    }

    if (!items.length) throw new Error('没有拉到内容');

    // 给前 5 条生成总结：一次请求，失败不影响列表
    let summaries = [];
    const config = loadConfig();
    if (isAiReady(config)) {
      try {
        summaries = await aiNewsSummaries(config, items.slice(0, NEWS_LIMIT));
      } catch {
        summaries = [];
      }
    }

    newsCache = { at: Date.now(), items, source, summaries };
    saveJSON(LS.news, newsCache);
    toast(`已更新 ${Math.min(items.length, NEWS_LIMIT)} 条`);
  } catch (err) {
    toast(err.message || '刷新失败');
  } finally {
    newsBusy = false;
    await render();
  }
}

/* ---------- AI 设置（与「吃什么」共用配置） ---------- */

function openAiSettings() {
  const c = loadConfig();
  openModal(`
    <h2>AI 设置</h2>
    <label>接口地址<input id="a-base" type="text" value="${esc(c.ai.base_url)}" /></label>
    <label>模型<input id="a-model" type="text" value="${esc(c.ai.model)}" /></label>
    <label>API Key<input id="a-key" type="password" value="${esc(c.ai.api_key)}" autocomplete="off" /></label>
    <p class="muted small">和「养乐多在吃什么」共用同一份本地配置。</p>
    <div class="modal-actions">
      <button class="btn-ghost" data-action="modal-close">取消</button>
      <button class="btn-primary" data-action="save-ai">保存</button>
    </div>
  `);
}

function saveAiSettings() {
  const dlg = modal();
  const c = loadConfig();
  c.ai.base_url = dlg.querySelector('#a-base').value.trim();
  c.ai.model = dlg.querySelector('#a-model').value.trim();
  c.ai.api_key = dlg.querySelector('#a-key').value.trim();
  saveConfig(c);
  closeModal();
  render();
  toast('已保存');
}

/* ============================== 主渲染 ============================== */

async function render() {
  const el = app();
  if (!el) return;

  try {
    if (reader) el.innerHTML = renderReader();
    else if (tab === 'books') el.innerHTML = await renderBooks();
    else el.innerHTML = renderNews();
  } catch (err) {
    console.error('[read] 渲染失败', err);
    el.innerHTML = `<p class="empty">出错了：${esc(err.message)}</p>`;
  }

  document.querySelectorAll('[data-rtab]').forEach(b => b.classList.toggle('active', b.dataset.rtab === tab));
  if (reader) {
    const body = document.getElementById('reader-body');
    if (body) body.scrollTop = reader.scrollTop || 0;
  }
}

/* ============================== 弹窗 ============================== */

const modal = () => document.getElementById('read-modal');

function openModal(html) {
  const dlg = modal();
  dlg.innerHTML = `<div class="modal-inner">${html}</div>`;
  dlg.showModal();
}

function closeModal() {
  const dlg = modal();
  if (dlg.open) dlg.close();
}

function toast(msg) {
  const t = document.getElementById('read-toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(t._timer);
  t._timer = setTimeout(() => t.classList.remove('show'), 2400);
}

/* ============================== 书籍操作 ============================== */

function pickTxt() {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = '.txt,text/plain';

  input.onchange = async () => {
    const file = input.files?.[0];
    if (!file) return;

    if (file.size > 20 * 1024 * 1024) {
      toast('文件超过 20 MB，先精简一下');
      return;
    }

    toast('正在解析…');
    try {
      const { text, encoding } = await readTextFile(file);
      const chapters = parseChapters(text);
      const id = uid();
      const title = file.name.replace(/\.txt$/i, '');

      await dbPut('texts', text, id);
      await dbPut('books', {
        id,
        title,
        size: file.size,
        encoding,
        chapters,
        createdAt: Date.now(),
        progress: null,
      });

      toast(`已加入书架：${chapters.length} 章（${encoding}）`);
      await render();
    } catch (err) {
      toast('解析失败：' + err.message);
    }
  };

  input.click();
}

async function openBook(id) {
  const meta = await dbGet('books', id);
  const text = await dbGet('texts', id);
  if (!meta || !text) return toast('这本书的数据丢了，重新上传一次吧');

  reader = { meta, text, index: meta.progress?.chapter ?? 0, scrollTop: meta.progress?.scroll ?? 0 };
  await render();
}

async function saveProgress() {
  if (!reader) return;
  const body = document.getElementById('reader-body');
  reader.scrollTop = body ? body.scrollTop : 0;
  reader.meta.progress = { chapter: reader.index, scroll: reader.scrollTop, updatedAt: Date.now() };
  await dbPut('books', reader.meta);
}

async function goChapter(delta) {
  if (!reader) return;
  const next = reader.index + delta;
  if (next < 0 || next >= reader.meta.chapters.length) return;
  reader.index = next;
  reader.scrollTop = 0;
  await render();
  await saveProgress();
}

async function openToc() {
  if (!reader) return;
  const { chapters } = reader.meta;

  openModal(`
    <h2>目录 <span class="muted">${chapters.length} 章</span></h2>
    <div class="toc-list">
      ${chapters
        .map(
          (c, i) => `
        <button class="toc-item ${i === reader.index ? 'active' : ''}" data-action="goto-ch" data-idx="${i}">
          <span>${esc(c.title)}</span>
          <em>${i + 1}</em>
        </button>`,
        )
        .join('')}
    </div>
    <div class="modal-actions">
      <button class="btn-ghost" data-action="modal-close">关闭</button>
    </div>
  `);

  const active = modal().querySelector('.toc-item.active');
  if (active) active.scrollIntoView({ block: 'center' });
}

/* ============================== 事件 ============================== */

document.addEventListener('click', async e => {
  const el = e.target.closest('[data-action], [data-rtab]');
  if (!el) return;

  if (el.dataset.rtab) {
    tab = el.dataset.rtab;
    reader = null;
    await render();

    // 进新闻页时，缓存超过 12 小时就自动拉一次
    if (tab === 'news' && Date.now() - (newsCache.at || 0) > 12 * 3600 * 1000) {
      refreshNews();
    }
    return;
  }

  const action = el.dataset.action;
  if (!action) return;

  switch (action) {
    case 'upload':
      pickTxt();
      break;
    case 'open-book':
      await openBook(el.dataset.id);
      break;
    case 'del-book': {
      e.stopPropagation();
      if (!confirm('从书架删除这本书？')) break;
      await dbDel('books', el.dataset.id);
      await dbDel('texts', el.dataset.id);
      toast('已删除');
      await render();
      break;
    }
    case 'close-book':
      await saveProgress();
      reader = null;
      await render();
      break;
    case 'prev-ch':
      await goChapter(-1);
      break;
    case 'next-ch':
      await goChapter(1);
      break;
    case 'toc':
      await openToc();
      break;
    case 'goto-ch': {
      const idx = Number(el.dataset.idx);
      if (!reader || Number.isNaN(idx)) break;
      reader.index = idx;
      reader.scrollTop = 0;
      closeModal();
      await render();
      await saveProgress();
      break;
    }
    case 'font-plus':
    case 'font-minus': {
      fontSize = Math.min(28, Math.max(13, fontSize + (action === 'font-plus' ? 1 : -1)));
      localStorage.setItem(LS.font, String(fontSize));
      const body = document.getElementById('reader-body');
      if (body) body.style.fontSize = fontSize + 'px';
      break;
    }
    case 'refresh-news':
      await refreshNews();
      break;
    case 'book-view':
      bookView = el.dataset.view;
      await render();
      break;
    case 'open-ai-settings':
      openAiSettings();
      break;
    case 'save-ai':
      saveAiSettings();
      break;
    case 'modal-close':
      closeModal();
      break;
  }
});

/* 记录阅读位置 */
let scrollTimer = null;
document.addEventListener(
  'scroll',
  e => {
    if (e.target?.id !== 'reader-body' || !reader) return;
    clearTimeout(scrollTimer);
    scrollTimer = setTimeout(saveProgress, 600);
  },
  true,
);

/* 书籍搜索：兼容中文输入法 */
let bookComposing = false;

document.addEventListener('compositionstart', e => {
  if (e.target?.dataset?.action === 'book-search') bookComposing = true;
});

document.addEventListener('compositionend', e => {
  if (e.target?.dataset?.action !== 'book-search') return;
  bookComposing = false;
  bookQuery = e.target.value;
  updateBookList();
});

document.addEventListener('input', e => {
  if (e.target?.dataset?.action !== 'book-search') return;
  bookQuery = e.target.value;
  if (bookComposing || e.isComposing) return;
  updateBookList();
});

/* 启动 */
render();

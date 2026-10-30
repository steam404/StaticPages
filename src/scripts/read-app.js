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
import { bookMeta } from '../data/book-meta.js';

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

const saveJSON = (k, v) => {
  localStorage.setItem(k, JSON.stringify(v));
  window.markSyncDirty?.();
};

/* ============================== IndexedDB ============================== */

const DB_NAME = 'yakult-read';
let dbPromise = null;

function openDb() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise(resolve => {
    try {
      const req = indexedDB.open(DB_NAME, 2);
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

/* 书籍正文按 Blob 存，打开时只切当前章，不用整本读进内存 */

const textEncoder = new TextEncoder();

/** 给章节补上 UTF-8 字节偏移（Blob.slice 用的是字节） */
function withByteOffsets(chapters, text) {
  let byte = 0;
  return chapters.map(c => {
    const len = textEncoder.encode(text.slice(c.start, c.end)).length;
    const out = { ...c, byteStart: byte, byteEnd: byte + len };
    byte += len;
    return out;
  });
}

/** 取正文 Blob；老数据是纯字符串时顺手升级成 Blob */
async function ensureBlobText(id) {
  const value = await dbGet('texts', id);
  if (!value) return null;

  if (typeof value === 'string') {
    const blob = new Blob([value], { type: 'text/plain;charset=utf-8' });
    await dbPut('texts', blob, id);
    return { blob, legacyText: value };
  }
  return { blob: value, legacyText: null };
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
let recPage = 1;
const REC_PAGE_SIZE = 5;

const app = () => document.getElementById('read-app');

/* ============================== TXT 解析 ============================== */

/** 优先按 UTF-8 解码，失败再试 GBK（中文小说常见） */
function decodeBytes(buf) {
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

async function readTextFile(file) {
  return decodeBytes(await file.arrayBuffer());
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

/* ---------- 在线书库（GitHub: hankinghu/literature-books） ---------- */

let libIndex = null;
let libLoading = null;

async function loadLibIndex() {
  if (libIndex) return libIndex;
  if (libLoading) return libLoading;

  libLoading = (async () => {
    try {
      const res = await fetch('/book-library.json', { cache: 'force-cache' });
      const data = await res.json();
      libIndex = Array.isArray(data.books) ? data.books : [];
    } catch {
      libIndex = [];
    }
    return libIndex;
  })();

  return libLoading;
}

function matchLib(b, q) {
  const t = normText(b.title);
  return t.includes(q) || fuzzyHit(t, q);
}

function libCard(b) {
  const inShelf = books.some(x => normText(x.title) === normText(b.title));

  return `
    <article class="book lib-book">
      <div class="book-cover">📥</div>
      <div class="book-info">
        <strong>${esc(b.title)}</strong>
        <span class="muted">${sizeText(b.size || 0)} · 在线书库</span>
      </div>
      ${
        inShelf
          ? '<span class="book-rate">已在书架</span>'
          : `<button class="btn-primary" data-action="import-lib" data-path="${esc(b.path)}">下载导入</button>`
      }
    </article>`;
}

async function importLib(btn) {
  const path = btn.dataset.path;
  if (!path) return;

  const original = btn.textContent;
  btn.disabled = true;
  btn.textContent = '下载中…';

  try {
    const res = await fetch('/api/book?path=' + encodeURIComponent(path));
    if (!res.ok) throw new Error(`下载失败（${res.status}）`);

    const buf = await res.arrayBuffer();
    if (buf.byteLength > 25 * 1024 * 1024) throw new Error('文件超过 25 MB');

    btn.textContent = '解析中…';
    const { text, encoding } = decodeBytes(buf);
    const chapters = withByteOffsets(parseChapters(text), text);
    const id = uid();
    const title = path.split('/').pop().replace(/\.txt$/i, '');

    await dbPut('texts', new Blob([text], { type: 'text/plain;charset=utf-8' }), id);
    const meta = {
      id,
      title,
      size: buf.byteLength,
      encoding,
      chapters,
      createdAt: Date.now(),
      progress: null,
    };
    await dbPut('books', meta);
    window.markSyncDirty?.();

    toast(`已导入《${title}》${chapters.length} 章，正在匹配豆瓣…`);
    await enrichDouban(meta);
    await render();
    toast(`《${title}》已加入书架`);
  } catch (err) {
    toast('导入失败：' + err.message);
    btn.disabled = false;
    btn.textContent = original;
  }
}

/** 用豆瓣补封面、评分和书目链接（找不到就跳过） */
async function enrichDouban(meta) {
  try {
    const res = await fetch('/api/douban?q=' + encodeURIComponent(meta.title));
    const data = await res.json();
    const m = data.match;
    if (!m) return;

    meta.douban = {
      title: m.title,
      author: m.author,
      cover: m.cover,
      url: m.douban,
      rating: m.rating,
    };
    await dbPut('books', meta);
    window.markSyncDirty?.();
  } catch {
    /* 匹配失败不影响阅读 */
  }
}

function bookCard(b) {
  const total = b.chapters.length;
  const done = b.progress?.chapter ?? 0;
  const pct = total ? Math.round(((done + 1) / total) * 100) : 0;

  const d = b.douban || null;
  const cover = d?.cover
    ? `<img class="book-thumb" src="/api/cover?u=${encodeURIComponent(d.cover)}" alt="" loading="lazy" onerror="this.remove()" />`
    : `<div class="book-cover">📖</div>`;
  const rating = d?.rating ? `<span class="book-rate">★ ${Number(d.rating).toFixed(1)}</span>` : '';
  const link = d?.url
    ? `<a class="book-src" data-action="open-douban" data-url="${esc(d.url)}" href="${esc(d.url)}" target="_blank" rel="noopener noreferrer">豆瓣 ↗</a>`
    : '';

  return `
    <article class="book" data-action="open-book" data-id="${b.id}">
      ${cover}
      <div class="book-info">
        <strong>${esc(b.title)}${rating}</strong>
        <span class="muted">${total} 章 · ${sizeText(b.size)}${d?.author ? ` · ${esc(d.author)}` : ''}</span>
        <div class="book-progress"><span style="width:${Math.min(100, pct)}%"></span></div>
        <span class="muted small">${b.progress ? `读到「${esc(b.chapters[done]?.title || '开始')}」` : '还没开始读'}</span>
      </div>
      <div class="book-actions">
        ${link}
        <button class="icon danger" data-action="del-book" data-id="${b.id}" title="删除">✕</button>
      </div>
    </article>`;
}

function recCard(r) {
  const meta = bookMeta(r.title);
  const cover = meta.cover
    ? `<img class="rec-cover" src="${esc(meta.cover)}" alt="" loading="lazy" />`
    : `<div class="rec-cover rec-cover-ph">${esc(r.title.slice(0, 1))}</div>`;

  return `
    <details class="rec">
      <summary>
        ${cover}
        <span class="rec-text">
          <span class="rec-head">
            <strong>${esc(r.title)}</strong>
            <span class="muted small">${esc(r.author)} · ${esc(r.cat)}</span>
          </span>
          <span class="rec-intro">${esc(r.intro)}</span>
        </span>
      </summary>
      <div class="rec-body">
        <p class="rec-reason">${esc(r.reason)}</p>
        ${
          meta.douban
            ? `<a class="rec-link" href="${esc(meta.douban)}" target="_blank" rel="noopener noreferrer">豆瓣读书 ↗</a>`
            : ''
        }
      </div>
    </details>`;
}

async function bookListHTML() {
  const q = normText(bookQuery);

  /* 搜索时同时找书架、推荐和在线书库 */
  if (q) {
    const shelf = books.filter(b => matchShelf(b, q));
    const recs = RECOMMENDS.filter(r => matchRec(r, q));
    const lib = (await loadLibIndex()).filter(b => matchLib(b, q)).slice(0, 12);

    if (!shelf.length && !recs.length && !lib.length) {
      return `<p class="empty">没找到「${esc(bookQuery)}」</p>`;
    }

    return `
      ${shelf.length ? `<p class="book-group">我的书架 · ${shelf.length}</p><div class="book-list">${shelf.map(bookCard).join('')}</div>` : ''}
      ${recs.length ? `<p class="book-group">养乐多的推荐 · ${recs.length}</p><div class="rec-list">${recs.map(recCard).join('')}</div>` : ''}
      ${
        lib.length
          ? `<p class="book-group">在线书库 · ${lib.length}</p><div class="book-list">${lib.map(libCard).join('')}</div>`
          : ''
      }
    `;
  }

  if (bookView === 'recs') {
    const total = RECOMMENDS.length;
    const pages = Math.max(1, Math.ceil(total / REC_PAGE_SIZE));
    if (recPage > pages) recPage = pages;
    if (recPage < 1) recPage = 1;

    const start = (recPage - 1) * REC_PAGE_SIZE;
    const items = RECOMMENDS.slice(start, start + REC_PAGE_SIZE);

    const pager =
      pages > 1
        ? `<div class="rec-pager">
             <button class="btn-ghost" data-action="rec-page" data-page="${recPage - 1}" ${recPage === 1 ? 'disabled' : ''}>← 上一页</button>
             <span class="muted small">${recPage} / ${pages}</span>
             <button class="btn-ghost" data-action="rec-page" data-page="${recPage + 1}" ${recPage === pages ? 'disabled' : ''}>下一页 →</button>
           </div>`
        : '';

    return `<div class="rec-list">${items.map(recCard).join('')}</div>${pager}`;
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
        ? '<p class="news-note">都是读完有印象的，不是必读书单。</p>'
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
  const { meta, index } = reader;
  const ch = meta.chapters[index];
  const body = (reader.chapterText || '').trim();
  const last = index >= meta.chapters.length - 1;

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

      <div class="reader-view" id="reader-view">
        <div class="reader-page" id="reader-page" style="font-size:${fontSize}px">${esc(body)}</div>
      </div>

      <footer class="reader-foot">
        <button class="btn-ghost" data-action="prev-ch" ${index === 0 ? 'disabled' : ''}>⏮ 上一章</button>
        <button class="btn-ghost" data-action="prev-page">‹ 上一页</button>
        <span class="reader-pos" id="reader-pos"></span>
        <button class="btn-ghost" data-action="next-page">下一页 ›</button>
        <button class="btn-ghost" data-action="next-ch" ${last ? 'disabled' : ''}>下一章 ⏭</button>
        <span class="reader-font">
          <button class="icon" data-action="font-minus" title="缩小">A－</button>
          <button class="icon" data-action="font-plus" title="放大">A＋</button>
        </span>
      </footer>
    </div>
  `;
}

/* 分页：用 CSS 多栏排好，再横向平移显示第 n 页 */
function layoutReader() {
  const view = document.getElementById('reader-view');
  const page = document.getElementById('reader-page');
  if (!view || !page || !reader) return;

  const cs = getComputedStyle(view);
  const padX = parseFloat(cs.paddingLeft) + parseFloat(cs.paddingRight);
  const padY = parseFloat(cs.paddingTop) + parseFloat(cs.paddingBottom);
  const w = Math.max(200, view.clientWidth - padX);
  const h = Math.max(120, view.clientHeight - padY);

  page.style.height = h + 'px';

  // 栏宽比可视宽度再窄 SAFETY 像素，任何亚像素溢出都落在留白里，不会切字
  const SAFETY = 10;
  const colW = Math.max(180, w - SAFETY);
  page.style.width = colW + 'px';
  page.style.columnWidth = colW + 'px';
  page.style.columnGap = '0px';
  page.style.columnFill = 'auto';

  // 强制回流后再量总宽
  const scrollW = page.scrollWidth;
  const total = Math.max(1, Math.round(scrollW / colW));
  reader.pages = total;
  // 用实测总宽反推每页宽度，避免浏览器取整导致翻页累积偏移
  reader.pageWidth = scrollW > colW ? scrollW / total : colW;

  if (reader.pendingEdge === 'last') {
    reader.page = total - 1;
    reader.pendingEdge = null;
  }
  reader.page = Math.min(Math.max(0, reader.page || 0), total - 1);
  reader.lastWidth = view.clientWidth;

  // 容器尺寸变了（旋转屏幕、拖动窗口）就重排
  if (!reader.roAttached && typeof ResizeObserver !== 'undefined') {
    reader.roAttached = true;
    const ro = new ResizeObserver(() => {
      if (!reader) return;
      const el = document.getElementById('reader-view');
      if (!el || el.clientWidth === reader.lastWidth) return;
      layoutReader();
    });
    ro.observe(view);
  }

  applyPage();
}

function applyPage() {
  const view = document.getElementById('reader-view');
  const page = document.getElementById('reader-page');
  if (!view || !page || !reader) return;

  const cs = getComputedStyle(view);
  const padX = parseFloat(cs.paddingLeft) + parseFloat(cs.paddingRight);
  const w = Math.max(200, view.clientWidth - padX);
  const step = reader.pageWidth || w;

  page.style.transform = `translateX(${-reader.page * step}px)`;
  updateReaderPos();
}

function updateReaderPos() {
  const pos = document.getElementById('reader-pos');
  if (!pos || !reader) return;

  const pages = reader.pages || 1;
  const chapters = reader.meta.chapters.length;
  pos.textContent = `第 ${reader.page + 1} / ${pages} 页 · ${reader.index + 1} / ${chapters} 章`;

  const prevPage = document.querySelector('[data-action="prev-page"]');
  const nextPage = document.querySelector('[data-action="next-page"]');
  if (prevPage) prevPage.disabled = reader.page === 0 && reader.index === 0;
  if (nextPage) nextPage.disabled = reader.page >= pages - 1 && reader.index >= chapters - 1;
}

async function goPage(delta) {
  if (!reader) return;
  const pages = reader.pages || 1;
  const next = reader.page + delta;

  if (next < 0) {
    if (reader.index > 0) await goChapter(-1, 'last');
    return;
  }
  if (next >= pages) {
    if (reader.index < reader.meta.chapters.length - 1) await goChapter(1, 'first');
    return;
  }

  reader.page = next;
  applyPage();
  await saveProgress();
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
             ${ready ? '' : '<p class="muted small">先在右上角 ⚙ 填 Key。</p>'}
           </div>`
    }

    <p class="news-note">${
      fromRss ? '来自 BBC、纽约时报、卫报等。点标题看原文。' : '由 AI 整理，仅供参考。'
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
    // 等布局稳定再分页（字体、宽度都要算进去）
    requestAnimationFrame(() => layoutReader());
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
      const chapters = withByteOffsets(parseChapters(text), text);
      const id = uid();
      const title = file.name.replace(/\.txt$/i, '');

      await dbPut('texts', new Blob([text], { type: 'text/plain;charset=utf-8' }), id);
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
      window.markSyncDirty?.();
      await render();
    } catch (err) {
      toast('解析失败：' + err.message);
    }
  };

  input.click();
}

async function openBook(id) {
  const meta = await dbGet('books', id);
  if (!meta) return toast('这本书的数据丢了，重新上传一次吧');

  const got = await ensureBlobText(id);
  if (!got) return toast('这本书的数据丢了，重新上传一次吧');

  // 老数据没有字节偏移：补一次并存回去（只发生这一次）
  if (!meta.chapters?.[0]?.byteStart) {
    const full = got.legacyText ?? (await got.blob.text());
    meta.chapters = withByteOffsets(meta.chapters, full);
    await dbPut('books', meta);
  }

  const chapter = Math.min(Math.max(0, meta.progress?.chapter ?? 0), meta.chapters.length - 1);
  reader = {
    meta,
    blob: got.blob,
    index: chapter,
    page: meta.progress?.page ?? 0,
    pages: 1,
    pendingEdge: null,
    chapterText: '',
  };

  await loadChapter(chapter);
  await render();
}

/** 只解码当前这一章，不碰整本书 */
async function loadChapter(index) {
  const ch = reader?.meta?.chapters?.[index];
  if (!ch) {
    if (reader) reader.chapterText = '';
    return;
  }
  const start = ch.byteStart ?? 0;
  const end = ch.byteEnd ?? reader.blob.size;
  reader.chapterText = await reader.blob.slice(start, end).text();
}

async function saveProgress() {
  if (!reader) return;
  reader.meta.progress = {
    chapter: reader.index,
    page: reader.page,
    updatedAt: Date.now(),
  };
  await dbPut('books', reader.meta);
  window.markSyncDirty?.();
}

async function goChapter(delta, edge = 'first') {
  if (!reader) return;
  const next = reader.index + delta;
  if (next < 0 || next >= reader.meta.chapters.length) return;

  reader.index = next;
  reader.page = 0;
  reader.pendingEdge = edge === 'last' ? 'last' : null;
  await loadChapter(next);
  await render();
  layoutReader();
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
      <button class="btn-ghost" data-action="reparse">重新识别章节</button>
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
    case 'import-lib':
      await importLib(el);
      break;
    case 'open-douban':
      // 让 <a> 自己打开新标签，别触发外层卡片的「打开书」
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
      await goChapter(-1, 'first');
      break;
    case 'next-ch':
      await goChapter(1, 'first');
      break;
    case 'prev-page':
      await goPage(-1);
      break;
    case 'next-page':
      await goPage(1);
      break;
    case 'toc':
      await openToc();
      break;
    case 'goto-ch': {
      const idx = Number(el.dataset.idx);
      if (!reader || Number.isNaN(idx)) break;
      reader.index = idx;
      reader.page = 0;
      reader.pendingEdge = null;
      closeModal();
      await loadChapter(idx);
      await render();
      layoutReader();
      await saveProgress();
      break;
    }
    case 'font-plus':
    case 'font-minus': {
      const before = reader ? { page: reader.page || 0, pages: reader.pages || 1 } : null;
      fontSize = Math.min(28, Math.max(13, fontSize + (action === 'font-plus' ? 1 : -1)));
      localStorage.setItem(LS.font, String(fontSize));

      if (reader) {
        const ratio = before.pages > 1 ? before.page / (before.pages - 1) : 0;
        await render();
        const pages = reader.pages || 1;
        reader.page = Math.round(ratio * (pages - 1));
        applyPage();
      }
      break;
    }
    case 'refresh-news':
      await refreshNews();
      break;
    case 'book-view':
      bookView = el.dataset.view;
      recPage = 1;
      await render();
      break;
    case 'rec-page':
      recPage = Number(el.dataset.page) || 1;
      await updateBookList();
      break;
    case 'open-ai-settings':
      openAiSettings();
      break;
    case 'save-ai':
      saveAiSettings();
      break;
    case 'reparse': {
      if (!reader) break;
      const before = reader.meta.chapters.length;
      const full = await reader.blob.text(); // 只有这一步会读整本，用户主动触发
      const chapters = withByteOffsets(parseChapters(full), full);

      reader.meta.chapters = chapters;
      reader.index = Math.min(reader.index, chapters.length - 1);
      reader.page = 0;
      reader.pendingEdge = null;
      closeModal();
      await dbPut('books', reader.meta);
      window.markSyncDirty?.();
      await loadChapter(reader.index);
      await render();
      layoutReader();
      toast(`重新识别：${before} → ${chapters.length} 章`);
      break;
    }
    case 'modal-close':
      closeModal();
      break;
  }
});

/* 像素字体加载完成后字宽会变，重新分页一次 */
if (document.fonts?.ready) {
  document.fonts.ready.then(() => {
    if (reader) layoutReader();
  });
}

/* 窗口尺寸变化：重新分页，尽量停在原来的进度 */
let resizeTimer = null;
window.addEventListener('resize', () => {
  if (!reader) return;
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => {
    const pages = reader.pages || 1;
    const ratio = pages > 1 ? (reader.page || 0) / (pages - 1) : 0;
    layoutReader();
    reader.page = Math.round(ratio * ((reader.pages || 1) - 1));
    applyPage();
  }, 150);
});

/* 键盘翻页：← → PageUp PageDown 空格 */
document.addEventListener('keydown', e => {
  if (!reader) return;
  if (e.target instanceof HTMLElement && e.target.matches('input, textarea, select')) return;

  if (e.key === 'ArrowLeft' || e.key === 'PageUp') {
    e.preventDefault();
    goPage(-1);
  } else if (e.key === 'ArrowRight' || e.key === 'PageDown' || e.key === ' ') {
    e.preventDefault();
    goPage(1);
  }
});

/* 书籍搜索：兼容中文输入法 */
let bookComposing = false;

document.addEventListener('compositionstart', e => {
  if (e.target?.dataset?.action === 'book-search') bookComposing = true;
});

document.addEventListener('compositionend', e => {
  if (e.target?.dataset?.action !== 'book-search') return;
  bookComposing = false;
  bookQuery = e.target.value;
  recPage = 1;
  updateBookList();
});

document.addEventListener('input', e => {
  if (e.target?.dataset?.action !== 'book-search') return;
  bookQuery = e.target.value;
  recPage = 1;
  if (bookComposing || e.isComposing) return;
  updateBookList();
});

/* 启动 */
render();

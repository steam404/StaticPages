/**
 * 养乐多在看什么：新闻 / 书籍 / 文章
 *
 * - 新闻、文章：链接收藏，存 localStorage
 * - 书籍：TXT 上传到 IndexedDB，自动解析章节目录，带阅读进度
 */

/* ============================== 小工具 ============================== */

import { parseChapters } from './chapter-parser.js';

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
  links: 'yakult.read.links',
  font: 'yakult.read.font',
};

let links = loadJSON(LS.links, []);
let books = [];
let tab = 'books'; // news | books | articles
let reader = null; // { meta, text, index }
let fontSize = Number(localStorage.getItem(LS.font)) || 17;

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

/* ============================== 渲染：书架 ============================== */

async function renderBooks() {
  books = (await dbGetAll('books')).sort((a, b) => b.createdAt - a.createdAt);

  if (!books.length) {
    return `
      <div class="read-empty card">
        <p class="big">📚</p>
        <p>书架还是空的。上传一个 <code>.txt</code> 就能开始读。</p>
        <p class="muted">文件只存在你这台设备的浏览器里，不会上传到任何服务器。</p>
        <button class="btn-primary" data-action="upload">上传 TXT</button>
      </div>`;
  }

  const cards = books
    .map(b => {
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
    })
    .join('');

  return `
    <div class="read-head">
      <span class="muted">${books.length} 本</span>
      <button class="btn-primary" data-action="upload">＋ 上传 TXT</button>
    </div>
    <div class="book-list">${cards}</div>
  `;
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

/* ============================== 渲染：新闻 / 文章 ============================== */

function renderLinks(kind) {
  const list = links.filter(l => l.kind === kind).sort((a, b) => b.createdAt - a.createdAt);
  const isNews = kind === 'news';

  const items = list
    .map(
      l => `
      <li class="link-item">
        <a href="${esc(l.url)}" target="_blank" rel="noopener noreferrer">
          <strong>${esc(l.title)}</strong>
          ${l.note ? `<span class="muted">${esc(l.note)}</span>` : ''}
          <span class="link-host">${esc(safeHost(l.url))}</span>
        </a>
        <button class="icon danger" data-action="del-link" data-id="${l.id}" title="删除">✕</button>
      </li>`,
    )
    .join('');

  return `
    <div class="read-head">
      <span class="muted">${list.length} 条</span>
      <button class="btn-primary" data-action="add-link" data-kind="${kind}">＋ 添加${isNews ? '新闻' : '文章'}</button>
    </div>
    ${
      list.length
        ? `<ul class="link-list">${items}</ul>`
        : `<div class="read-empty card"><p class="big">${isNews ? '📰' : '📝'}</p><p>还没有收藏。点右上角添加一条链接。</p></div>`
    }
  `;
}

function safeHost(url) {
  try {
    return new URL(url).host.replace(/^www\./, '');
  } catch {
    return '';
  }
}

/* ============================== 主渲染 ============================== */

async function render() {
  const el = app();
  if (!el) return;

  try {
    if (reader) el.innerHTML = renderReader();
    else if (tab === 'books') el.innerHTML = await renderBooks();
    else el.innerHTML = renderLinks(tab);
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

/* ============================== 链接操作 ============================== */

function openAddLink(kind) {
  const label = kind === 'news' ? '新闻' : '文章';

  openModal(`
    <h2>添加${label}</h2>
    <label>标题<input id="l-title" type="text" placeholder="比如：某篇值得一读的报道" /></label>
    <label>链接<input id="l-url" type="url" placeholder="https://" /></label>
    <label>备注（可选）<input id="l-note" type="text" placeholder="为什么想留它" /></label>
    <div class="modal-actions">
      <button class="btn-ghost" data-action="modal-close">取消</button>
      <button class="btn-primary" data-action="save-link" data-kind="${kind}">保存</button>
    </div>
  `);
}

function saveLink(kind) {
  const dlg = modal();
  const title = dlg.querySelector('#l-title').value.trim();
  let url = dlg.querySelector('#l-url').value.trim();
  const note = dlg.querySelector('#l-note').value.trim();

  if (!title) return toast('标题不能为空');
  if (!url) return toast('链接不能为空');
  if (!/^https?:\/\//i.test(url)) url = 'https://' + url;

  links.push({ id: uid(), kind, title, url, note, createdAt: Date.now() });
  saveJSON(LS.links, links);
  closeModal();
  render();
  toast('已保存');
}

/* ============================== 事件 ============================== */

document.addEventListener('click', async e => {
  const el = e.target.closest('[data-action], [data-rtab]');
  if (!el) return;

  if (el.dataset.rtab) {
    tab = el.dataset.rtab;
    reader = null;
    await render();
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
    case 'add-link':
      openAddLink(el.dataset.kind);
      break;
    case 'save-link':
      saveLink(el.dataset.kind);
      break;
    case 'del-link': {
      const id = el.dataset.id;
      if (!confirm('删除这条收藏？')) break;
      links = links.filter(l => l.id !== id);
      saveJSON(LS.links, links);
      await render();
      break;
    }
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

/* 启动 */
render();

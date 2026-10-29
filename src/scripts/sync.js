/**
 * 多端同步（客户端）
 *
 * - 快照 = localStorage 里的几份数据 + AI 配置（去掉 api_key）
 * - 图片与书籍正文走 /api/blob/<sha256>，内容寻址
 * - 推送带 If-Match，版本不符返回 409 → 交给用户选
 *
 * 对外只暴露 window.markSyncDirty()，供各页保存后触发。
 */

/* ============================== 常量 ============================== */

const LS_KEYS = [
  'yakult.recipes',
  'yakult.meals',
  'yakult.settings',
  'yakult.fortune',
  'yakult.read.news',
];
const FONT_KEY = 'yakult.read.font';
const CONFIG_KEY = 'yakult.config';
const REV_KEY = 'yakult.sync.rev';

const DBS = {
  images: { db: 'yakult-eat', store: 'images', keyPath: null },
  books: { db: 'yakult-read', store: 'books', keyPath: 'id' },
  texts: { db: 'yakult-read', store: 'texts', keyPath: null },
};

/* ============================== 小工具 ============================== */

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

const readLS = key => {
  const raw = localStorage.getItem(key);
  if (raw == null) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
};

const toHex = buf => [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');

const sha256 = async bytes => toHex(await crypto.subtle.digest('SHA-256', bytes));

const b64ToBytes = dataUrl => {
  const base64 = String(dataUrl).split(',')[1] || '';
  const bin = atob(base64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
};

const bytesToDataUrl = (bytes, type = 'image/jpeg') => {
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  }
  return `data:${type};base64,${btoa(bin)}`;
};

/* ============================== IndexedDB ============================== */

const dbCache = new Map();

/** 已知数据库列表；浏览器不支持检测时返回 null */
async function knownDbs() {
  if (typeof indexedDB.databases !== 'function') return null;
  try {
    return await indexedDB.databases();
  } catch {
    return null;
  }
}

/** 打开一个已存在的库，不触发升级，避免误建空库 */
function openExisting(name) {
  if (dbCache.has(name)) return dbCache.get(name);
  const p = new Promise(resolve => {
    try {
      const req = indexedDB.open(name);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(null);
      req.onblocked = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
  dbCache.set(name, p);
  return p;
}

/** 库与 store 都存在才继续；不存在的直接跳过 */
async function storeReady(desc) {
  const dbs = await knownDbs();
  if (!dbs) return false;
  if (!dbs.some(d => d.name === desc.db)) return false;
  const db = await openExisting(desc.db);
  return Boolean(db && db.objectStoreNames.contains(desc.store));
}

async function idbAll(desc) {
  if (!(await storeReady(desc))) return [];
  const db = await openExisting(desc.db);
  if (!db) return [];
  return new Promise(resolve => {
    try {
      const tx = db.transaction(desc.store, 'readonly');
      const req = tx.objectStore(desc.store).getAll();
      req.onsuccess = () => resolve(req.result || []);
      req.onerror = () => resolve([]);
      tx.onabort = () => resolve([]);
    } catch {
      resolve([]);
    }
  });
}

async function idbAllKeys(desc) {
  if (!(await storeReady(desc))) return [];
  const db = await openExisting(desc.db);
  if (!db) return [];
  return new Promise(resolve => {
    try {
      const tx = db.transaction(desc.store, 'readonly');
      const req = tx.objectStore(desc.store).getAllKeys();
      req.onsuccess = () => resolve(req.result || []);
      req.onerror = () => resolve([]);
      tx.onabort = () => resolve([]);
    } catch {
      resolve([]);
    }
  });
}

async function idbGet(desc, key) {
  if (!(await storeReady(desc))) return null;
  const db = await openExisting(desc.db);
  if (!db) return null;
  return new Promise(resolve => {
    try {
      const tx = db.transaction(desc.store, 'readonly');
      const req = tx.objectStore(desc.store).get(key);
      req.onsuccess = () => resolve(req.result ?? null);
      req.onerror = () => resolve(null);
      tx.onabort = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
}

async function idbPut(desc, value, key) {
  if (!(await storeReady(desc))) return false;
  const db = await openExisting(desc.db);
  if (!db) return false;
  return new Promise(resolve => {
    try {
      const tx = db.transaction(desc.store, 'readwrite');
      const store = tx.objectStore(desc.store);
      tx.oncomplete = () => resolve(true);
      tx.onabort = () => resolve(false);
      if (desc.keyPath) store.put(value);
      else store.put(value, key);
    } catch {
      resolve(false);
    }
  });
}

/* ============================== 状态 ============================== */

const app = () => document.getElementById('sync-app');

const state = {
  auth: 'unknown', // unknown | out | in
  rev: Number(localStorage.getItem(REV_KEY) || 0),
  serverRev: 0,
  dirty: false,
  busy: false,
  message: '',
};

let pushing = false;
let timer = null;

const setState = patch => {
  Object.assign(state, patch);
  paint();
};

/* ============================== 快照 ============================== */

const shaCacheKey = 'yakult.blobSha';
const shaCache = loadJSON(shaCacheKey, {});

async function collectBlobs() {
  try {
    const images = [];
  const imageKeys = await idbAllKeys(DBS.images);

  for (const id of imageKeys) {
    const dataUrl = await idbGet(DBS.images, id);
    if (!dataUrl) continue;
    const cacheKey = `img:${id}`;
    let sha = shaCache[cacheKey];
    if (!sha) {
      sha = await sha256(b64ToBytes(dataUrl));
      shaCache[cacheKey] = sha;
    }
    images.push({ id, sha });
  }

  const books = [];
  const metas = await idbAll(DBS.books);
  for (const meta of metas) {
    const cacheKey = `book:${meta.id}`;
    let sha = shaCache[cacheKey];
    if (!sha) {
      const text = await idbGet(DBS.texts, meta.id);
      if (!text) continue;
      sha = await sha256(new TextEncoder().encode(text));
      shaCache[cacheKey] = sha;
    }
    books.push({ id: meta.id, sha, title: meta.title, size: meta.size || 0 });
  }

  localStorage.setItem(shaCacheKey, JSON.stringify(shaCache));
  return { images, books };
  } catch {
    // 照片/书籍读不到不该影响记录同步
    return { images: [], books: [] };
  }
}

function collectSnapshot(blobs) {
  const ls = {};
  for (const key of LS_KEYS) {
    const value = readLS(key);
    if (value !== null) ls[key] = value;
  }

  const font = localStorage.getItem(FONT_KEY);
  if (font !== null) ls[FONT_KEY] = font;

  // 配置去掉密钥
  const config = loadJSON(CONFIG_KEY, null);
  const safeConfig = config
    ? { ...config, ai: { ...(config.ai || {}), api_key: '' } }
    : null;

  return {
    v: 1,
    ls,
    config: safeConfig,
    images: blobs.images,
    books: blobs.books,
    updatedAt: Date.now(),
  };
}

async function applySnapshot(payload) {
  for (const key of LS_KEYS) {
    const value = payload.ls?.[key];
    if (value === undefined) continue;
    localStorage.setItem(key, JSON.stringify(value));
  }

  if (typeof payload.ls?.[FONT_KEY] === 'string') {
    localStorage.setItem(FONT_KEY, payload.ls[FONT_KEY]);
  }

  if (payload.config) {
    // 保留本机已有的 api_key
    const local = loadJSON(CONFIG_KEY, null);
    const merged = {
      ...payload.config,
      ai: { ...(payload.config.ai || {}), api_key: local?.ai?.api_key || '' },
    };
    localStorage.setItem(CONFIG_KEY, JSON.stringify(merged));
  }

  await pullBlobs(payload).catch(() => 0);
  localStorage.setItem(REV_KEY, String(payload._rev ?? state.serverRev));
}

/* ============================== 二进制 ============================== */

async function uploadBlobs(blobs) {
  let uploaded = 0;

  for (const img of blobs.images) {
    const head = await fetch(`/api/blob/${img.sha}`, { method: 'HEAD', credentials: 'same-origin' });
    if (head.ok) continue;
    const dataUrl = await idbGet(DBS.images, img.id);
    if (!dataUrl) continue;
    const bytes = b64ToBytes(dataUrl);
    const res = await fetch(`/api/blob/${img.sha}`, {
      method: 'PUT',
      credentials: 'same-origin',
      headers: { 'content-type': 'image/jpeg' },
      body: bytes,
    });
    if (res.ok) uploaded++;
  }

  for (const book of blobs.books) {
    const head = await fetch(`/api/blob/${book.sha}`, { method: 'HEAD', credentials: 'same-origin' });
    if (head.ok) continue;
    const text = await idbGet(DBS.texts, book.id);
    if (!text) continue;
    const bytes = new TextEncoder().encode(text);
    const res = await fetch(`/api/blob/${book.sha}`, {
      method: 'PUT',
      credentials: 'same-origin',
      headers: { 'content-type': 'text/plain; charset=utf-8' },
      body: bytes,
    });
    if (res.ok) uploaded++;
  }

  return uploaded;
}

async function pullBlobs(payload) {
  let downloaded = 0;

  const haveImages = new Set(await idbAllKeys(DBS.images));
  for (const img of payload.images || []) {
    if (haveImages.has(img.id)) continue;
    const res = await fetch(`/api/blob/${img.sha}`, { credentials: 'same-origin' });
    if (!res.ok) continue;
    const bytes = new Uint8Array(await res.arrayBuffer());
    await idbPut(DBS.images, bytesToDataUrl(bytes), img.id);
    downloaded++;
  }

  const haveBooks = new Set((await idbAll(DBS.books)).map(b => b.id));
  for (const book of payload.books || []) {
    if (haveBooks.has(book.id)) continue;
    const res = await fetch(`/api/blob/${book.sha}`, { credentials: 'same-origin' });
    if (!res.ok) continue;
    const text = await res.text();
    await idbPut(DBS.texts, text, book.id);
    downloaded++;
  }

  return downloaded;
}

/* ============================== 同步动作 ============================== */

async function syncNow({ force = false } = {}) {
  if (state.busy || pushing) return;
  setState({ busy: true, message: '' });

  try {
    const stateRes = await fetch('/api/sync/state', { credentials: 'same-origin', cache: 'no-store' });
    const remote = await stateRes.json().catch(() => null);
    if (stateRes.status === 401) {
      setState({ auth: 'out', busy: false });
      return;
    }
    if (!remote || typeof remote.rev !== 'number') {
      setState({ busy: false, message: '同步服务不可用（后端未配置）' });
      return;
    }
    state.serverRev = remote.rev;

    // 云端更新且本地没有未推送改动 → 直接拉取
    if (remote.rev > state.rev && !state.dirty && !force) {
      const snap = await fetch('/api/sync/snapshot', { credentials: 'same-origin', cache: 'no-store' });
      const data = await snap.json();
      if (!data.payload) {
        setState({ busy: false, message: '云端还没有数据' });
        return;
      }
      await applySnapshot({ ...data.payload, _rev: data.rev });
      location.reload();
      return;
    }

    if (!state.dirty && !force) {
      setState({ busy: false, message: '已是最新' });
      return;
    }

    pushing = true;
    const blobs = await collectBlobs();
    const payload = collectSnapshot(blobs);

    const res = await fetch(`/api/sync/snapshot${force ? '?force=1' : ''}`, {
      method: 'PUT',
      credentials: 'same-origin',
      headers: {
        'content-type': 'application/json',
        'if-match': String(state.rev),
      },
      body: JSON.stringify(payload),
    });

    if (res.status === 409) {
      setState({ busy: false, message: '云端有新版本', dirty: true });
      openConflictDialog((await res.json()).rev);
      return;
    }

    if (!res.ok) throw new Error(`推送失败 ${res.status}`);

    const out = await res.json();
    localStorage.setItem(REV_KEY, String(out.rev));
    state.rev = out.rev;
    state.serverRev = out.rev;

    const uploaded = await uploadBlobs(blobs).catch(() => 0);

    setState({
      busy: false,
      dirty: false,
      message: uploaded ? `已同步，上传 ${uploaded} 个文件` : '已同步',
    });
  } catch (err) {
    setState({ busy: false, message: err.message || '同步失败' });
  } finally {
    pushing = false;
  }
}

function markDirty() {
  state.dirty = true;
  paint();
  clearTimeout(timer);
  timer = setTimeout(() => {
    if (state.auth === 'in') syncNow();
  }, 8000);
}

/* ============================== 登录 ============================== */

async function login(passphrase) {
  setState({ busy: true, message: '' });
  try {
    const res = await fetch('/api/auth/login', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ passphrase }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || '登录失败');
    setState({ auth: 'in', busy: false, dirty: true, message: '' });
    await syncNow({ force: true });
  } catch (err) {
    setState({ busy: false, message: err.message });
  }
}

async function logout() {
  await fetch('/api/auth/logout', { method: 'POST', credentials: 'same-origin' }).catch(() => {});
  setState({ auth: 'out', message: '' });
}

/* ============================== 界面 ============================== */

function paint() {
  const btn = document.getElementById('sync-btn');
  if (btn) {
    btn.dataset.state = state.busy ? 'busy' : state.auth === 'out' ? 'out' : state.dirty ? 'dirty' : 'ok';
    btn.title = state.busy ? '同步中…' : state.dirty ? '有改动待同步' : '已同步';
  }
  const body = app();
  if (body) body.innerHTML = dialogHTML();
}

function dialogHTML() {
  if (state.auth === 'out' || state.auth === 'unknown') {
    return `
      <h2>多端同步</h2>
      <p class="sync-hint">输入你设置的口令，登录后本机数据会与云端合并。</p>
      <label>口令<input id="sync-pass" type="password" autocomplete="current-password" /></label>
      <p class="sync-msg">${esc(state.message)}</p>
      <div class="sync-actions">
        <button class="btn-ghost" data-sync="close">取消</button>
        <button class="btn-primary" data-sync="login" ${state.busy ? 'disabled' : ''}>登录并同步</button>
      </div>`;
  }

  return `
    <h2>多端同步</h2>
    <p class="sync-hint">本地版本 ${state.rev} · 云端版本 ${state.serverRev}</p>
    <p class="sync-msg">${esc(state.message || (state.dirty ? '有改动待同步' : '已是最新'))}</p>
    <div class="sync-actions">
      <button class="btn-ghost" data-sync="logout">退出登录</button>
      <button class="btn-ghost" data-sync="force">用本地覆盖云端</button>
      <button class="btn-primary" data-sync="now" ${state.busy ? 'disabled' : ''}>
        ${state.busy ? '同步中…' : '立即同步'}
      </button>
    </div>`;
}

function openDialog() {
  const dlg = document.getElementById('sync-dialog');
  if (!dlg) return;
  paint();
  dlg.showModal();
}

function closeDialog() {
  document.getElementById('sync-dialog')?.close();
}

function openConflictDialog(remoteRev) {
  const dlg = document.getElementById('sync-conflict');
  if (!dlg) return;
  dlg.innerHTML = `
    <div class="modal-inner">
      <h2>云端已有新版本</h2>
      <p class="sync-hint">另一台设备先推送了（云端版本 ${remoteRev}，本地版本 ${state.rev}）。选择保留哪一边：</p>
      <div class="sync-actions">
        <button class="btn-ghost" data-conflict="remote">保留云端</button>
        <button class="btn-primary" data-conflict="local">用本地覆盖</button>
      </div>
    </div>`;
  dlg.showModal();
}

/* ============================== 事件 ============================== */

document.addEventListener('click', async e => {
  const el = e.target.closest('[data-sync], [data-conflict]');
  if (!el) return;

  if (el.dataset.sync === 'close') return closeDialog();
  if (el.dataset.sync === 'login') {
    const pass = document.getElementById('sync-pass')?.value || '';
    if (!pass) return;
    return login(pass);
  }
  if (el.dataset.sync === 'now') return syncNow();
  if (el.dataset.sync === 'force') return syncNow({ force: true });
  if (el.dataset.sync === 'logout') return logout();

  if (el.dataset.conflict === 'remote') {
    document.getElementById('sync-conflict')?.close();
    state.dirty = false;
    return syncNow({ force: false });
  }
  if (el.dataset.conflict === 'local') {
    document.getElementById('sync-conflict')?.close();
    return syncNow({ force: true });
  }
});

document.getElementById('sync-btn')?.addEventListener('click', openDialog);

window.addEventListener('online', () => {
  if (state.dirty && state.auth === 'in') syncNow();
});

/* 其他标签页同步后，刷新状态点 */
try {
  const channel = new BroadcastChannel('yakult-sync');
  channel.onmessage = event => {
    if (event.data?.rev) {
      setState({ serverRev: event.data.rev });
    }
  };
  channel.postMessage({ rev: state.rev });
} catch {
  /* 忽略 */
}

/* ============================== 初始化 ============================== */

async function init() {
  paint();
  try {
    const res = await fetch('/api/auth/me', { credentials: 'same-origin', cache: 'no-store' });
    // 没配后端时这个路径会落到静态资源，返回 200 的 HTML——必须确认是 JSON
    const me = await res.json().catch(() => null);
    const signedIn = res.ok && me?.ok === true;
    setState({ auth: signedIn ? 'in' : 'out' });

    if (signedIn) {
      const stateRes = await fetch('/api/sync/state', { credentials: 'same-origin', cache: 'no-store' });
      const remote = await stateRes.json();
      setState({ serverRev: remote.rev });

      // 首次打开：云端有数据、本地是空的 → 自动拉取
      const localEmpty = !localStorage.getItem('yakult.recipes');
      if (remote.rev > state.rev && localEmpty && !sessionStorage.getItem('sync-pulled')) {
        sessionStorage.setItem('sync-pulled', '1');
        await syncNow();
      }
    }
  } catch {
    setState({ auth: 'out', message: '同步服务不可用' });
  }
}

window.markSyncDirty = markDirty;
init();

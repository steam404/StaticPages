/**
 * 在线书库与豆瓣补全（Worker 侧代理，避免浏览器跨域 / 国内直连不通）。
 *
 * GET /api/book?path=xxx/书名.txt   从 GitHub 仓库取 txt
 * GET /api/douban?q=书名            豆瓣搜索建议 + 评分
 * GET /api/cover?u=<豆瓣图片地址>    豆瓣封面（带 Referer，绕开防盗链）
 */

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36';

const RAW_BASE = 'https://raw.githubusercontent.com/hankinghu/literature-books/master/';

const json = (data, init = {}) =>
  new Response(JSON.stringify(data), {
    ...init,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      ...(init.headers || {}),
    },
  });

const fail = (status, message) => json({ error: message }, { status });

/** 书库路径只允许常见字符，防止穿越到别的仓库路径 */
function safePath(path) {
  if (!path || path.length > 200) return null;
  if (path.includes('..') || path.startsWith('/')) return null;
  if (!/\.txt$/i.test(path)) return null;
  if (!/^[\w\u4e00-\u9fa5 ./()（）[\]{}·、,，'’\-]+$/.test(path)) return null;
  return path;
}

/** 简单的内存缓存（每个 isolate 内有效） */
const memo = new Map();
const memoGet = key => {
  const hit = memo.get(key);
  if (!hit) return null;
  if (hit.expires < Date.now()) {
    memo.delete(key);
    return null;
  }
  return hit.value;
};
const memoSet = (key, value, ttlMs) => {
  if (memo.size > 200) memo.clear();
  memo.set(key, { value, expires: Date.now() + ttlMs });
};

async function handleBook(url) {
  const path = safePath(url.searchParams.get('path'));
  if (!path) return fail(400, '路径不合法');

  const key = `book:${path}`;
  const cached = memoGet(key);
  if (cached) return cached;

  const encoded = path.split('/').map(encodeURIComponent).join('/');
  // 先直连 raw，失败再走公共镜像
  const sources = [RAW_BASE + encoded, 'https://ghproxy.net/' + RAW_BASE + encoded];

  let lastStatus = 0;
  for (const src of sources) {
    try {
      const res = await fetch(src, {
        headers: { 'user-agent': UA },
        cf: { cacheTtl: 86400, cacheEverything: true },
      });
      if (!res.ok) {
        lastStatus = res.status;
        continue;
      }

      const buf = await res.arrayBuffer();
      if (!buf.byteLength) {
        lastStatus = 502;
        continue;
      }

      const out = new Response(buf, {
        headers: {
          'content-type': 'text/plain; charset=utf-8',
          'cache-control': 'public, max-age=86400',
        },
      });
      memoSet(key, out, 3600 * 1000);
      return out;
    } catch {
      lastStatus = 0;
    }
  }

  return fail(lastStatus === 404 ? 404 : 502, '书库下载失败，稍后再试');
}

async function handleDouban(url) {
  const q = (url.searchParams.get('q') || '').trim().slice(0, 40);
  if (!q) return fail(400, '缺少书名');

  const key = `douban:${q}`;
  const cached = memoGet(key);
  if (cached) return cached;

  const suggestUrl = 'https://book.douban.com/j/subject_suggest?q=' + encodeURIComponent(q);
  const res = await fetch(suggestUrl, {
    headers: { 'user-agent': UA, referer: 'https://book.douban.com/' },
    cf: { cacheTtl: 86400, cacheEverything: true },
  });
  if (!res.ok) return fail(502, `豆瓣返回 ${res.status}`);

  const list = await res.json().catch(() => []);
  if (!Array.isArray(list) || !list.length) {
    const empty = json({ match: null });
    memoSet(key, empty, 3600 * 1000);
    return empty;
  }

  const norm = s =>
    String(s || '')
      .replace(/[\s·:：《》()（）\-—,.。!！?？'"“”]/g, '')
      .toLowerCase();
  const target = norm(q);
  const best =
    list.find(i => norm(i.title) === target) ||
    list.find(i => norm(i.title).startsWith(target) || target.startsWith(norm(i.title))) ||
    list.find(i => norm(i.title).includes(target) || target.includes(norm(i.title))) ||
    list[0];

  // 顺手从书目页抓一下评分（失败不影响主流程）
  let rating = null;
  if (best.url) {
    try {
      const page = await fetch(best.url, {
        headers: { 'user-agent': UA, referer: 'https://book.douban.com/' },
        cf: { cacheTtl: 86400, cacheEverything: true },
      });
      if (page.ok) {
        const html = await page.text();
        const m = html.match(/property="v:average">\s*([\d.]+)\s*</);
        if (m) rating = Number(m[1]);
      }
    } catch {
      /* 忽略 */
    }
  }

  const payload = json({
    match: {
      title: best.title || '',
      author: best.author_name || '',
      cover: best.pic || '',
      douban: best.url || '',
      rating,
    },
  });
  memoSet(key, payload, 3600 * 1000);
  return payload;
}

async function handleCover(url) {
  const u = url.searchParams.get('u') || '';
  let parsed;
  try {
    parsed = new URL(u);
  } catch {
    return fail(400, '地址不合法');
  }
  if (!/\.doubanio\.com$/.test(parsed.hostname)) return fail(400, '只代理豆瓣图片');

  const key = `cover:${u}`;
  const cached = memoGet(key);
  if (cached) return cached;

  const res = await fetch(u, {
    headers: { 'user-agent': UA, referer: 'https://book.douban.com/' },
    cf: { cacheTtl: 604800, cacheEverything: true },
  });
  if (!res.ok) return fail(502, `图片返回 ${res.status}`);

  const out = new Response(res.body, {
    headers: {
      'content-type': res.headers.get('content-type') || 'image/jpeg',
      'cache-control': 'public, max-age=604800',
    },
  });
  memoSet(key, out, 6 * 3600 * 1000);
  return out;
}

export async function handleBooks(request, env, url) {
  if (!url.pathname.startsWith('/api/book') &&
      url.pathname !== '/api/douban' &&
      url.pathname !== '/api/cover') {
    return null;
  }

  try {
    if (url.pathname === '/api/book') return await handleBook(url);
    if (url.pathname === '/api/douban') return await handleDouban(url);
    if (url.pathname === '/api/cover') return await handleCover(url);
  } catch (err) {
    return fail(500, String(err).slice(0, 120));
  }

  return null;
}

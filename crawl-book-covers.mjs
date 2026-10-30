/**
 * 为「养乐多的推荐」抓豆瓣封面与书目链接。
 *
 * 产物：
 *   public/books/<序号>.jpg
 *   src/data/book-meta.js   （书名 → { cover, douban, rating } ）
 *
 * 可重复执行，已抓到的会跳过。
 */

import fs from 'node:fs';
import { RECOMMENDS } from 'file:///E:/DSH/StaticPages/src/data/recommends.js';

const ROOT = 'E:/DSH/StaticPages';
const OUT_DIR = `${ROOT}/public/books`;
const MAP_FILE = 'E:/DSH/_tmp/book-map.json';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36';

const sleep = ms => new Promise(r => setTimeout(r, ms));
fs.mkdirSync(OUT_DIR, { recursive: true });

const map = fs.existsSync(MAP_FILE) ? JSON.parse(fs.readFileSync(MAP_FILE, 'utf8')) : {};

/** 从 window.__DATA__ 里按括号配平提取 JSON */
function extractData(html) {
  const at = html.indexOf('window.__DATA__');
  if (at < 0) return null;
  const start = html.indexOf('{', at);
  if (start < 0) return null;

  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < html.length; i++) {
    const c = html[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === '\\') esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') inStr = true;
    else if (c === '{') depth++;
    else if (c === '}') {
      depth--;
      if (depth === 0) {
        try {
          return JSON.parse(html.slice(start, i + 1));
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}

const norm = s =>
  String(s)
    .replace(/[\s·:：《》()（）\-—·,，.。!！?？'"“”]/g, '')
    .toLowerCase();

function pick(items, title, author) {
  const t = norm(title);
  const a = norm(author || '');

  const score = item => {
    const it = norm(item.title);
    let s = 0;
    if (it === t) s += 10;
    else if (it.startsWith(t) || t.startsWith(it)) s += 6;
    else if (it.includes(t) || t.includes(it)) s += 3;
    else return -1;

    if (a && norm(item.author_name || '').includes(a)) s += 4;
    return s;
  };

  return (
    items
      .map(item => [item, score(item)])
      .filter(([, s]) => s >= 0)
      .sort((x, y) => y[1] - x[1])[0]?.[0] || null
  );
}

/** 搜索建议接口：比搜索结果页稳定，不会被限流成空 */
async function search(title) {
  const url = 'https://book.douban.com/j/subject_suggest?q=' + encodeURIComponent(title);
  const res = await fetch(url, {
    headers: { 'user-agent': UA, referer: 'https://book.douban.com/' },
    signal: AbortSignal.timeout(20000),
  });
  if (!res.ok) throw new Error('HTTP ' + res.status);
  const data = await res.json();
  return Array.isArray(data) ? data : [];
}

async function downloadCover(coverUrl) {
  const res = await fetch(coverUrl, {
    headers: { 'user-agent': UA, referer: 'https://book.douban.com/' },
    signal: AbortSignal.timeout(25000),
  });
  if (!res.ok) return null;
  const type = res.headers.get('content-type') || '';
  if (!type.startsWith('image/')) return null;
  const buf = Buffer.from(await res.arrayBuffer());
  return buf.byteLength > 3000 ? buf : null;
}

let hit = 0;
let miss = 0;

for (let i = 0; i < RECOMMENDS.length; i++) {
  const { title, author } = RECOMMENDS[i];
  if (map[title]?.cover) {
    hit++;
    console.log(`· ${title} 已有，跳过`);
    continue;
  }

  const file = `${String(i).padStart(2, '0')}.jpg`;
  try {
    const items = await search(title);
    const best = pick(items, title, author);
    if (!best) {
      miss++;
      console.log(`✗ 《${title}》没有匹配结果（首条是「${items[0]?.title || '空'}」）`);
      await sleep(900);
      continue;
    }

    const buf = await downloadCover(best.pic || '');
    let cover = '';
    if (buf) {
      fs.writeFileSync(`${OUT_DIR}/${file}`, buf);
      cover = `/books/${file}`;
    }

    map[title] = {
      cover,
      douban: best.url || '',
      rating: null,
      votes: null,
      matchedTitle: best.title,
    };
    if (cover) hit++;
    else miss++;
    console.log(`${cover ? '✓' : '△'} 《${title}》→ ${best.title} · ${best.url} ${cover ? '' : '(封面没下到)'}`);
  } catch (e) {
    miss++;
    console.log(`✗ 《${title}》异常: ${e.message}`);
  }

  fs.writeFileSync(MAP_FILE, JSON.stringify(map, null, 2));
  await sleep(700 + Math.random() * 700);
}

/* 生成数据模块 */
const rows = RECOMMENDS.map(({ title }) => {
  const v = map[title] || {};
  return `  ${JSON.stringify(title)}: { cover: ${JSON.stringify(v.cover || '')}, douban: ${JSON.stringify(
    v.douban || '',
  )}, rating: ${v.rating ?? 'null'} },`;
});

const module = `/**
 * 推荐的书的封面与豆瓣链接（自动生成，勿手改）
 *
 * 封面来自豆瓣，仅作展示；链接指向豆瓣读书书目页。
 * 生成脚本：crawl-book-covers.mjs
 */

export const BOOK_META = {
${rows.join('\n')}
};

export const bookMeta = title => BOOK_META[title] || { cover: '', douban: '', rating: null };
`;

fs.writeFileSync(`${ROOT}/src/data/book-meta.js`, module);

console.log(`\n完成：成功 ${hit}，失败 ${miss}，共 ${Object.keys(map).length} 条`);

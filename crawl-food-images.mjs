/**
 * 从下厨房抓菜谱配图，落地到 public/food/，并生成 src/data/food-images.js
 *
 * 用法：
 *   node crawl-food-images.mjs --limit=3      只跑前 3 个，用来抽查
 *   node crawl-food-images.mjs                跑全部（可重复执行，已有的会跳过）
 */

import fs from 'node:fs';
import { SEED_RECIPES } from 'file:///E:/DSH/StaticPages/src/data/seed-recipes.js';

const ROOT = 'E:/DSH/StaticPages';
const OUT_DIR = `${ROOT}/public/food`;
const MAP_FILE = 'E:/DSH/_tmp/food-map.json';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36';

const limitArg = process.argv.find(a => a.startsWith('--limit='));
const LIMIT = limitArg ? Number(limitArg.split('=')[1]) : Infinity;

const sleep = ms => new Promise(r => setTimeout(r, ms));

fs.mkdirSync(OUT_DIR, { recursive: true });

const map = fs.existsSync(MAP_FILE) ? JSON.parse(fs.readFileSync(MAP_FILE, 'utf8')) : {};
const usedUrls = new Set(Object.values(map).map(v => v.sourceUrl));

async function searchImageUrls(name) {
  const url = 'https://www.xiachufang.com/search/?keyword=' + encodeURIComponent(name);
  const res = await fetch(url, {
    headers: { 'user-agent': UA, 'accept-language': 'zh-CN,zh;q=0.9' },
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) throw new Error('HTTP ' + res.status);
  const html = await res.text();
  const urls = [...html.matchAll(/data-src="(https:\/\/i\d?\.chuimg\.com\/[^"]+)"/g)].map(m => m[1]);
  return [...new Set(urls)];
}

const thumb = (u, w = 480, h = 360) => `${u.split('?')[0]}?imageView2/1/w/${w}/h/${h}/interlace/1/q/75`;

async function download(url) {
  const res = await fetch(url, {
    headers: { 'user-agent': UA, referer: 'https://www.xiachufang.com/' },
    signal: AbortSignal.timeout(25000),
  });
  if (!res.ok) return null;
  const type = res.headers.get('content-type') || '';
  if (!type.startsWith('image/')) return null;
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.byteLength < 5000) return null;
  return { buf, type };
}

const recipes = SEED_RECIPES.slice(0, LIMIT);
let done = 0;
let hit = 0;
let miss = 0;

for (let i = 0; i < recipes.length; i++) {
  const { name } = recipes[i];
  if (map[name]) {
    hit++;
    console.log(`· ${name} 已有，跳过`);
    continue;
  }

  const file = `${String(i).padStart(3, '0')}.jpg`;
  const dest = `${OUT_DIR}/${file}`;

  try {
    let urls = [];
    try {
      urls = await searchImageUrls(name);
    } catch (e) {
      console.log(`! ${name} 搜索失败: ${e.message}`);
    }

    let saved = null;
    for (const raw of urls.slice(0, 4)) {
      if (usedUrls.has(thumb(raw))) continue;
      const got = await download(thumb(raw));
      if (!got) continue;
      fs.writeFileSync(dest, got.buf);
      saved = { file: `/food/${file}`, sourceUrl: thumb(raw), bytes: got.buf.byteLength };
      usedUrls.add(thumb(raw));
      break;
    }

    if (saved) {
      map[name] = saved;
      hit++;
      done++;
      console.log(`✓ ${name} → ${saved.file} (${(saved.bytes / 1024).toFixed(0)}KB)`);
    } else {
      miss++;
      console.log(`✗ ${name} 没找到可用图片`);
    }
  } catch (e) {
    miss++;
    console.log(`✗ ${name} 异常: ${e.message}`);
  }

  if (done % 5 === 0) fs.writeFileSync(MAP_FILE, JSON.stringify(map, null, 2));
  await sleep(400 + Math.random() * 400);
}

fs.writeFileSync(MAP_FILE, JSON.stringify(map, null, 2));

/* 生成数据模块 */
const lines = Object.entries(map)
  .sort((a, b) => a[0].localeCompare(b[0], 'zh'))
  .map(([name, v]) => `  ${JSON.stringify(name)}: ${JSON.stringify(v.file)},`);

const module = `/**
 * 菜谱配图（自动生成，勿手改）
 *
 * 来源：下厨房搜索结果页的菜品图，按菜名取首图，尺寸 480×360。
 * 生成脚本：见项目根目录的 crawl-food-images.mjs
 */

export const FOOD_IMAGES = {
${lines.join('\n')}
};

export const FOOD_IMAGE_COUNT = ${Object.keys(map).length};

export const foodImage = name => FOOD_IMAGES[name] || '';
`;

fs.writeFileSync(`${ROOT}/src/data/food-images.js`, module);

console.log(`\n完成：命中 ${hit}，未命中 ${miss}，映射 ${Object.keys(map).length} 条`);

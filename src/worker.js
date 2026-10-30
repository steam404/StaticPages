/**
 * Cloudflare Worker：静态资源 + /api/news（RSS 聚合）+ /api/sync（多端同步）
 *
 * 静态站自己抓不了新闻（跨域限制），所以由 Worker 在边缘节点抓 RSS，
 * 前端只请求同域的 /api/news，没有任何 CORS 问题。
 */

import { handleAuth } from './api/auth.js';
import { handleSync } from './api/sync.js';
import { handleBlob } from './api/blob.js';
import { handleBubbles } from './api/bubbles.js';
import { handleBooks } from './api/books.js';

const FEEDS = [
  { id: 'bbc-zh', name: 'BBC 中文', url: 'https://feeds.bbci.co.uk/zhongwen/simp/rss.xml', lang: 'zh' },
  { id: 'bbc-world', name: 'BBC World', url: 'https://feeds.bbci.co.uk/news/world/rss.xml', lang: 'en' },
  { id: 'nyt-zh', name: '纽约时报中文网', url: 'https://cn.nytimes.com/rss/', lang: 'zh' },
  { id: 'guardian', name: 'The Guardian', url: 'https://www.theguardian.com/world/rss', lang: 'en' },
  { id: 'aljazeera', name: 'Al Jazeera', url: 'https://www.aljazeera.com/xml/rss/all.xml', lang: 'en' },
];

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Cache-Control': 'public, max-age=600',
};

function decodeEntities(input) {
  return String(input)
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(Number(d)))
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCharCode(parseInt(h, 16)))
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&');
}

function stripTags(input) {
  return decodeEntities(String(input).replace(/<[^>]+>/g, ' '))
    .replace(/\s+/g, ' ')
    .trim();
}

function pickTag(block, tag) {
  const m = block.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, 'i'));
  return m ? decodeEntities(m[1]).trim() : '';
}

/** 解析 RSS 2.0 或 Atom，返回统一结构 */
export function parseFeed(xml, feed) {
  const isAtom = /<entry[\s>]/i.test(xml);
  const blockRe = isAtom ? /<entry[\s>][\s\S]*?<\/entry>/gi : /<item[\s>][\s\S]*?<\/item>/gi;
  const blocks = xml.match(blockRe) || [];
  const items = [];

  for (const block of blocks.slice(0, 15)) {
    const title = stripTags(pickTag(block, 'title'));
    if (!title) continue;

    let link = '';
    if (isAtom) {
      const m = block.match(/<link[^>]*href="([^"]+)"/i);
      link = m ? m[1] : '';
    } else {
      link = pickTag(block, 'link') || pickTag(block, 'guid');
    }

    const rawDate = pickTag(block, 'pubDate') || pickTag(block, 'updated') || pickTag(block, 'published');
    const summary = stripTags(pickTag(block, isAtom ? 'summary' : 'description')).slice(0, 160);

    items.push({
      title,
      link: link.trim(),
      summary,
      source: feed.name,
      lang: feed.lang,
      at: rawDate ? Date.parse(rawDate) || 0 : 0,
    });
  }

  return items;
}

async function fetchFeed(feed) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 6000);
  try {
    const res = await fetch(feed.url, {
      signal: controller.signal,
      headers: { 'user-agent': 'yakult-reader/1.0 (+personal site)', accept: 'application/rss+xml, application/xml, text/xml' },
      cf: { cacheTtl: 600, cacheEverything: true },
    });
    if (!res.ok) throw new Error(`${feed.name} HTTP ${res.status}`);
    return parseFeed(await res.text(), feed);
  } finally {
    clearTimeout(timer);
  }
}

export async function collectNews() {
  const results = await Promise.allSettled(FEEDS.map(fetchFeed));
  const failed = results
    .map((r, i) => (r.status === 'rejected' ? `${FEEDS[i].name}: ${r.reason?.message || r.reason}` : null))
    .filter(Boolean);

  const items = results.filter(r => r.status === 'fulfilled').flatMap(r => r.value);

  const seen = new Set();
  const unique = items
    .filter(item => {
      const key = item.title.toLowerCase().slice(0, 40);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .sort((a, b) => b.at - a.at)
    .slice(0, 24);

  return { items: unique, failed };
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname.startsWith('/api/')) {
      if (url.pathname === '/api/news') {
        try {
          const { items, failed } = await collectNews();
          return Response.json({ items, failed, updatedAt: Date.now() }, { headers: CORS });
        } catch (err) {
          return Response.json({ items: [], error: String(err) }, { status: 200, headers: CORS });
        }
      }

      for (const handler of [handleAuth, handleSync, handleBlob, handleBubbles, handleBooks]) {
        const res = await handler(request, env, url);
        if (res) return res;
      }

      return new Response('Not Found', { status: 404 });
    }

    return env.ASSETS.fetch(request);
  },
};

/**
 * 留言气泡：任何已登录（同步过）的人可以留一句，页面随机展示一两条。
 *
 * GET  /api/bubbles?limit=2   公开，随机取
 * POST /api/bubbles           需要登录，{ body, author? }
 */

import { json, fail, requireSession, sameOrigin } from './http.js';

const MAX_LEN = 120;
const MAX_PER_HOUR = 10;

const clean = (s, max) =>
  String(s ?? '')
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);

export async function handleBubbles(request, env, url) {
  if (!url.pathname.startsWith('/api/bubbles')) return null;

  // 没配数据库时静默返回空列表，页面照常显示
  if (!env.DB) return json({ items: [] });

  if (url.pathname === '/api/bubbles' && request.method === 'GET') {
    const raw = Number(url.searchParams.get('limit'));
    const limit = Math.min(Math.max(Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 2, 1), 20);

    const rows = await env.DB.prepare(
      'SELECT id, body, author, created_at FROM bubbles WHERE hidden = 0 ORDER BY RANDOM() LIMIT ?',
    )
      .bind(limit)
      .all();

    const items = (rows?.results || []).map(r => ({
      id: r.id,
      body: r.body,
      author: r.author || '',
      createdAt: r.created_at,
    }));

    return json({ items });
  }

  if (url.pathname === '/api/bubbles' && request.method === 'POST') {
    if (!sameOrigin(request)) return fail(403, '来源不合法');

    const auth = await requireSession(request, env);
    if (auth.error) return auth.error;

    let payload;
    try {
      payload = await request.json();
    } catch {
      return fail(400, '请求格式错误');
    }

    const body = clean(payload?.body, MAX_LEN * 2);
    if (!body) return fail(400, '内容不能为空');
    if (body.length > MAX_LEN) return fail(400, `最多 ${MAX_LEN} 个字`);

    const ip = request.headers.get('cf-connecting-ip') || 'unknown';
    const recent = await env.DB.prepare(
      'SELECT COUNT(*) AS n FROM bubbles WHERE ip = ? AND created_at > ?',
    )
      .bind(ip, Date.now() - 3600 * 1000)
      .first();

    if (Number(recent?.n || 0) >= MAX_PER_HOUR) return fail(429, `一小时最多留 ${MAX_PER_HOUR} 条`);

    const author = clean(payload?.author, 16);
    await env.DB.prepare('INSERT INTO bubbles (body, author, created_at, ip) VALUES (?, ?, ?, ?)')
      .bind(body, author, Date.now(), ip)
      .run();

    return json({ ok: true });
  }

  return fail(405, '方法不支持');
}

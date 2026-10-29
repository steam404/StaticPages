/**
 * 同步接口：整包快照 + rev 乐观并发。
 *
 * GET  /api/sync/state            版本号与更新时间
 * GET  /api/sync/snapshot         拉取快照（If-None-Match 命中返回 304）
 * PUT  /api/sync/snapshot         推送快照（If-Match 版本不符返回 409，?force=1 强制）
 */

import { json, fail, requireSession, getMeta, setMeta, sameOrigin } from './http.js';

/** R2 里保留最近几版快照，用于回滚 */
const KEEP_VERSIONS = 3;

const currentRev = async env => Number((await getMeta(env, 'rev')) || 0);

export async function handleSync(request, env, url) {
  if (!url.pathname.startsWith('/api/sync/')) return null;

  if (!env.DB || !env.BLOBS) return fail(503, '同步未配置');

  const auth = await requireSession(request, env);
  if (auth.error) return auth.error;

  if (url.pathname === '/api/sync/state') {
    if (request.method !== 'GET') return fail(405, '方法不支持');
    return json({
      rev: await currentRev(env),
      updatedAt: Number(await getMeta(env, 'updated_at')) || 0,
    });
  }

  if (url.pathname !== '/api/sync/snapshot') return fail(404, '接口不存在');

  /* ---------------- 拉取 ---------------- */
  if (request.method === 'GET') {
    const rev = await currentRev(env);
    if (rev === 0) return json({ rev: 0, payload: null });

    const etag = (request.headers.get('if-none-match') || '').replace(/"/g, '');
    if (etag === String(rev)) return new Response(null, { status: 304 });

    const obj = await env.BLOBS.get(`snapshot/${rev}.json`);
    if (!obj) return fail(404, '快照不存在');

    const text = await obj.text();
    return json({ rev, payload: JSON.parse(text) }, { headers: { etag: `"${rev}"` } });
  }

  /* ---------------- 推送 ---------------- */
  if (request.method === 'PUT') {
    if (!sameOrigin(request)) return fail(403, '来源不合法');

    const force = url.searchParams.get('force') === '1';
    const rev = await currentRev(env);
    const ifMatch = (request.headers.get('if-match') || '').replace(/"/g, '');

    if (!force && rev > 0 && ifMatch !== String(rev)) {
      return fail(409, '云端有新版本', { conflict: true, rev });
    }

    let payload;
    try {
      payload = await request.json();
    } catch {
      return fail(400, 'JSON 解析失败');
    }

    if (!payload || payload.v !== 1 || typeof payload.ls !== 'object' || payload.ls === null) {
      return fail(400, '快照结构不合法');
    }

    const nextRev = rev + 1;
    await env.BLOBS.put(`snapshot/${nextRev}.json`, JSON.stringify(payload), {
      httpMetadata: { contentType: 'application/json' },
    });
    await setMeta(env, 'rev', nextRev);
    await setMeta(env, 'updated_at', Date.now());

    for (let old = nextRev - KEEP_VERSIONS; old > 0; old--) {
      await env.BLOBS.delete(`snapshot/${old}.json`);
    }

    return json({ rev: nextRev });
  }

  return fail(405, '方法不支持');
}

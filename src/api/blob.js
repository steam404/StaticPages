/**
 * 二进制对象：图片与书籍正文。
 * 内容寻址（key = sha256），因此同一张图/同一本书只存一份。
 *
 * 实际存放在哪里由 storage.js 决定：R2（若绑定）或 KV。
 */

import { json, fail, requireSession, sameOrigin } from './http.js';
import { storageGet, storagePut, storageHead, storageReady } from './storage.js';

const MAX_BYTES = 25 * 1024 * 1024;

const cacheHeaders = key => ({
  'cache-control': 'public, max-age=31536000, immutable',
  etag: `"${key}"`,
});

export async function handleBlob(request, env, url) {
  if (!url.pathname.startsWith('/api/blob/')) return null;

  if (!storageReady(env)) return fail(503, '同步未配置');

  const auth = await requireSession(request, env);
  if (auth.error) return auth.error;

  const key = url.pathname.slice('/api/blob/'.length);
  if (!/^[a-f0-9]{64}$/.test(key)) return fail(400, 'key 不合法');

  const path = `blob/${key}`;

  if (request.method === 'GET' || request.method === 'HEAD') {
    if (request.method === 'HEAD') {
      const meta = await storageHead(env, path);
      if (!meta) return fail(404, '对象不存在');
      return new Response(null, {
        headers: { 'content-type': meta.contentType, ...cacheHeaders(key) },
      });
    }

    const hit = await storageGet(env, path);
    if (!hit) return fail(404, '对象不存在');
    return new Response(hit.bytes, {
      headers: { 'content-type': hit.contentType, ...cacheHeaders(key) },
    });
  }

  if (request.method === 'PUT') {
    if (!sameOrigin(request)) return fail(403, '来源不合法');

    const declared = Number(request.headers.get('content-length') || 0);
    if (declared > MAX_BYTES) return fail(413, '对象过大（上限 25 MB）');

    const buf = await request.arrayBuffer();
    if (buf.byteLength > MAX_BYTES) return fail(413, '对象过大（上限 25 MB）');
    if (buf.byteLength === 0) return fail(400, '空对象');

    await storagePut(
      env,
      path,
      buf,
      request.headers.get('content-type') || 'application/octet-stream',
    );
    return json({ ok: true, size: buf.byteLength });
  }

  return fail(405, '方法不支持');
}

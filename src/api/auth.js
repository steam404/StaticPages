/**
 * 登录：口令 → HMAC 签名的 HttpOnly cookie。
 * 单用户模型，没有注册。
 */

import {
  json,
  fail,
  sha256Hex,
  safeEqual,
  createSession,
  sessionCookie,
  clearCookie,
  readSession,
  sameOrigin,
  hasSessionKey,
} from './http.js';

const WINDOW_MS = 15 * 60 * 1000;
const MAX_ATTEMPTS = 5;

const ipOf = request => request.headers.get('cf-connecting-ip') || 'unknown';

async function tooManyAttempts(env, ip) {
  const row = await env.DB.prepare(
    'SELECT COUNT(*) AS n FROM login_attempts WHERE ip = ? AND ts > ?',
  )
    .bind(ip, Date.now() - WINDOW_MS)
    .first();
  return Number(row?.n || 0) >= MAX_ATTEMPTS;
}

async function recordAttempt(env, ip) {
  await env.DB.prepare('INSERT INTO login_attempts (ip, ts) VALUES (?, ?)').bind(ip, Date.now()).run();
  // 顺手清掉过期记录，避免表无限增长
  await env.DB.prepare('DELETE FROM login_attempts WHERE ts < ?')
    .bind(Date.now() - WINDOW_MS * 4)
    .run();
}

async function clearAttempts(env, ip) {
  await env.DB.prepare('DELETE FROM login_attempts WHERE ip = ?').bind(ip).run();
}

export async function handleAuth(request, env, url) {
  if (url.pathname.startsWith('/api/auth/') && (!env.DB || !hasSessionKey(env))) {
    return fail(503, '同步未配置');
  }

  if (url.pathname === '/api/auth/login') {
    if (request.method !== 'POST') return fail(405, '方法不支持');
    if (!sameOrigin(request)) return fail(403, '来源不合法');

    const ip = ipOf(request);
    if (await tooManyAttempts(env, ip)) return fail(429, '尝试次数过多，15 分钟后再试');

    let body;
    try {
      body = await request.json();
    } catch {
      return fail(400, '请求格式错误');
    }

    const passphrase = String(body?.passphrase || '');
    if (!passphrase) return fail(400, '口令不能为空');

    const hash = await sha256Hex(`yakult-sync:${passphrase}`);
    if (!safeEqual(hash, String(env.SYNC_PASSPHRASE_HASH || ''))) {
      await recordAttempt(env, ip);
      return fail(401, '口令不对');
    }

    await clearAttempts(env, ip);
    const token = await createSession(env);
    return json({ ok: true }, { headers: { 'set-cookie': sessionCookie(token) } });
  }

  if (url.pathname === '/api/auth/me') {
    if (request.method !== 'GET') return fail(405, '方法不支持');
    const session = await readSession(request, env);
    return session ? json({ ok: true }) : fail(401, '未登录');
  }

  if (url.pathname === '/api/auth/logout') {
    if (request.method !== 'POST') return fail(405, '方法不支持');
    return json({ ok: true }, { headers: { 'set-cookie': clearCookie() } });
  }

  return null;
}

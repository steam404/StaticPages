/**
 * 共享工具：JSON 响应、WebCrypto、会话 cookie、D1 小工具。
 */

export const COOKIE_NAME = 'yk_session';
const SESSION_DAYS = 30;

export const json = (data, init = {}) =>
  new Response(JSON.stringify(data), {
    ...init,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      ...(init.headers || {}),
    },
  });

export const fail = (status, message, extra = {}) => json({ error: message, ...extra }, { status });

/* ---------------- WebCrypto ---------------- */

const enc = new TextEncoder();

const toHex = buf =>
  [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');

export async function sha256Hex(text) {
  const digest = await crypto.subtle.digest('SHA-256', enc.encode(text));
  return toHex(digest);
}

async function hmacHex(secret, message) {
  const key = await crypto.subtle.importKey(
    'raw',
    enc.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(message));
  return toHex(sig);
}

/** 常数时间比较（长度不同直接 false） */
export function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/* ---------------- 会话 ---------------- */

/**
 * 会话签名密钥。
 *
 * 优先级：环境变量 SYNC_SECRET → D1 里的 session_key（首次自动生成并持久化）。
 * 放到 D1 之后，密钥就不属于构建产物，重新部署多少次都不会丢，
 * 也不需要每次在面板里手动加变量。
 */
let cachedSessionKey = null;

async function sessionSecret(env) {
  if (env.SYNC_SECRET) return String(env.SYNC_SECRET);
  if (cachedSessionKey) return cachedSessionKey;
  if (!env.DB) return null;

  let key = await getMeta(env, 'session_key');
  if (!key) {
    key = toHex(crypto.getRandomValues(new Uint8Array(32)));
    await setMeta(env, 'session_key', key);
  }
  cachedSessionKey = key;
  return key;
}

/** 有 D1 就够了：会话密钥可以现生成，口令哈希也存在 D1 里 */
export const hasSessionKey = env => Boolean(env.SYNC_SECRET || env.SYNC_PASSPHRASE_HASH || env.DB);

export async function createSession(env) {
  const key = await sessionSecret(env);
  if (!key) throw new Error('缺少会话密钥');
  const exp = Date.now() + SESSION_DAYS * 24 * 3600 * 1000;
  const nonce = toHex(crypto.getRandomValues(new Uint8Array(8)));
  const sig = await hmacHex(key, `${exp}.${nonce}`);
  return `${exp}.${nonce}.${sig}`;
}

export async function readSession(request, env) {
  const key = await sessionSecret(env);
  if (!key) return null;

  const cookie = request.headers.get('cookie') || '';
  const match = cookie.match(new RegExp(`(?:^|;\\s*)${COOKIE_NAME}=([^;]+)`));
  if (!match) return null;

  const [expRaw, nonce, sig] = match[1].split('.');
  const exp = Number(expRaw);
  if (!exp || !nonce || !sig || exp < Date.now()) return null;

  const expected = await hmacHex(key, `${exp}.${nonce}`);
  return safeEqual(sig, expected) ? { exp, nonce } : null;
}

export function sessionCookie(token) {
  return `${COOKIE_NAME}=${token}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=${
    SESSION_DAYS * 24 * 3600
  }`;
}

export function clearCookie() {
  return `${COOKIE_NAME}=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0`;
}

export async function requireSession(request, env) {
  const session = await readSession(request, env);
  if (!session) return { error: fail(401, '未登录') };
  return { session };
}

/** 只允许同源的非 GET 请求，配合 SameSite=Lax 防 CSRF */
export function sameOrigin(request) {
  if (request.method === 'GET' || request.method === 'HEAD') return true;
  const origin = request.headers.get('origin');
  if (!origin) return true; // 同源 fetch 有时不带 Origin
  try {
    return new URL(origin).host === new URL(request.url).host;
  } catch {
    return false;
  }
}

/* ---------------- D1 小工具 ---------------- */

export async function getMeta(env, key) {
  const row = await env.DB.prepare('SELECT v FROM meta WHERE k = ?').bind(key).first();
  return row ? row.v : null;
}

export async function setMeta(env, key, value) {
  await env.DB.prepare(
    'INSERT INTO meta (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v',
  )
    .bind(key, String(value))
    .run();
}

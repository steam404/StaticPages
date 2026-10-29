/**
 * 对象存储适配层。
 *
 * 优先用 R2（若绑定了 BLOBS），否则用 Workers KV（绑定 KV）。
 * 这样不绑支付方式也能用：KV 免费额度 1 GB、单值 25 MiB，足够个人用量。
 */

const DEFAULT_TYPE = 'application/octet-stream';

const hasR2 = env => Boolean(env?.BLOBS?.get && env?.BLOBS?.put);
const hasKV = env => Boolean(env?.KV?.put && (env?.KV?.getWithMetadata || env?.KV?.get));

/** 从 KV 读取，兼容只有 get 的实现 */
async function kvRead(env, key) {
  if (env.KV.getWithMetadata) {
    const { value, metadata } = await env.KV.getWithMetadata(key, { type: 'arrayBuffer' });
    return value ? { value, metadata } : null;
  }
  const value = await env.KV.get(key, { type: 'arrayBuffer' });
  return value ? { value, metadata: null } : null;
}

export const storageReady = env => hasR2(env) || hasKV(env);
export const storageKind = env => (hasR2(env) ? 'r2' : hasKV(env) ? 'kv' : 'none');

/** 读取一个对象，返回 { bytes, contentType } 或 null */
export async function storageGet(env, key) {
  if (hasR2(env)) {
    const obj = await env.BLOBS.get(key);
    if (!obj) return null;
    return {
      bytes: await obj.arrayBuffer(),
      contentType: obj.httpMetadata?.contentType || DEFAULT_TYPE,
    };
  }

  if (hasKV(env)) {
    const hit = await kvRead(env, key);
    if (!hit) return null;
    return {
      bytes: hit.value,
      contentType: hit.metadata?.contentType || DEFAULT_TYPE,
    };
  }

  return null;
}

/** 是否存在，返回 { size, contentType } 或 null */
export async function storageHead(env, key) {
  if (hasR2(env)) {
    const obj = (await env.BLOBS.head?.(key)) ?? (await env.BLOBS.get(key));
    if (!obj) return null;
    return { size: obj.size ?? null, contentType: obj.httpMetadata?.contentType || DEFAULT_TYPE };
  }

  if (hasKV(env)) {
    const hit = await kvRead(env, key);
    if (!hit) return null;
    return { size: hit.value.byteLength, contentType: hit.metadata?.contentType || DEFAULT_TYPE };
  }

  return null;
}

export async function storagePut(env, key, bytes, contentType = DEFAULT_TYPE) {
  if (hasR2(env)) {
    await env.BLOBS.put(key, bytes, { httpMetadata: { contentType } });
    return true;
  }

  if (hasKV(env)) {
    await env.KV.put(key, bytes, { metadata: { contentType } });
    return true;
  }

  throw new Error('没有可用的对象存储绑定');
}

export async function storageDelete(env, key) {
  if (hasR2(env)) {
    await env.BLOBS.delete(key);
    return true;
  }
  if (hasKV(env)) {
    await env.KV.delete(key);
    return true;
  }
  return false;
}

/**
 * KV 是最终一致的：刚写完可能短暂读不到。
 * 快照读取用这个做几次短重试。
 */
export async function storageGetWithRetry(env, key, tries = 4, delayMs = 250) {
  for (let i = 0; i < tries; i++) {
    const hit = await storageGet(env, key);
    if (hit) return hit;
    if (i < tries - 1) await new Promise(r => setTimeout(r, delayMs));
  }
  return null;
}

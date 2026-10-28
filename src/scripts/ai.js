/**
 * AI 客户端：OpenAI 兼容的 /chat/completions。
 * 默认指向 DeepSeek，模型名可在 config.ini 里改。
 */

export class AiError extends Error {}

const fill = (tpl, vars) =>
  String(tpl).replace(/\{(\w+)\}/g, (_, k) => (vars[k] === undefined ? '' : String(vars[k])));

async function chat(config, messages) {
  const { base_url, model, api_key, temperature, timeout_ms } = config.ai;
  const url = `${String(base_url).replace(/\/+$/, '')}/chat/completions`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Number(timeout_ms) || 30000);

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${api_key}`,
      },
      body: JSON.stringify({ model, messages, temperature, stream: false }),
      signal: controller.signal,
    });

    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      throw new AiError(`接口返回 ${res.status}${detail ? '：' + detail.slice(0, 160) : ''}`);
    }

    const data = await res.json();
    const content = data?.choices?.[0]?.message?.content;
    if (!content) throw new AiError('接口没有返回内容');
    return content;
  } catch (err) {
    if (err instanceof AiError) throw err;
    if (err.name === 'AbortError') throw new AiError('请求超时，检查网络或把超时调大');
    throw new AiError(`请求失败：${err.message}（常见原因：浏览器跨域被拦、key 无效、地址写错）`);
  } finally {
    clearTimeout(timer);
  }
}

/** 从模型输出里抠出 JSON（兼容 ```json 代码块和前后废话） */
function pickJSON(text) {
  const fenced = String(text).match(/```(?:json)?\s*([\s\S]*?)```/i);
  const body = fenced ? fenced[1] : String(text);
  const start = body.search(/[[{]/);
  if (start < 0) throw new AiError('模型没有返回 JSON');
  const end = Math.max(body.lastIndexOf('}'), body.lastIndexOf(']'));
  if (end < start) throw new AiError('JSON 不完整');
  try {
    return JSON.parse(body.slice(start, end + 1));
  } catch {
    throw new AiError('返回的 JSON 解析失败');
  }
}

const int = (v, fb = 0) => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.round(n) : fb;
};

export async function aiPing(config) {
  const t0 = performance.now();
  const reply = await chat(config, [{ role: 'user', content: '只回复两个字：收到' }]);
  return { ms: Math.round(performance.now() - t0), reply: reply.trim().slice(0, 40) };
}

export async function aiEstimate(config, dish) {
  const prompt = fill(config.prompts.estimate, { dish });
  const raw = await chat(config, [{ role: 'user', content: prompt }]);
  const data = pickJSON(raw);
  return {
    kcal: int(data.kcal, 300),
    p: int(data.p, 0),
    f: int(data.f, 0),
    c: int(data.c, 0),
    comment: String(data.comment || '').slice(0, 80),
  };
}

export async function aiAdvice(config, { dishes, kcal, p, f, c, target }) {
  const prompt = fill(config.prompts.advice, {
    dishes: dishes.map(d => `- ${d}`).join('\n'),
    kcal: int(kcal),
    p: int(p),
    f: int(f),
    c: int(c),
    target: int(target, 1800),
  });
  const raw = await chat(config, [{ role: 'user', content: prompt }]);
  const data = pickJSON(raw);
  return {
    score: Math.max(0, Math.min(100, int(data.score, 70))),
    comment: String(data.comment || '').slice(0, 120),
    tips: Array.isArray(data.tips) ? data.tips.slice(0, 3).map(t => String(t).slice(0, 60)) : [],
  };
}

export async function aiSuggest(config, ingredients) {
  const prompt = fill(config.prompts.suggest, { ingredients });
  const raw = await chat(config, [{ role: 'user', content: prompt }]);
  const data = pickJSON(raw);
  const list = Array.isArray(data) ? data : data.items || [];
  return list.slice(0, 5).map(x => ({
    name: String(x.name || '').slice(0, 30),
    kcal: int(x.kcal, 300),
    reason: String(x.reason || '').slice(0, 60),
  }));
}

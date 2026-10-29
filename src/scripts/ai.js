/**
 * AI 客户端：OpenAI 兼容的 /chat/completions。
 * 默认指向 DeepSeek，模型名可在 config.txt 里改。
 */

export class AiError extends Error {}

const fill = (tpl, vars) =>
  String(tpl).replace(/\{(\w+)\}/g, (_, k) => (vars[k] === undefined ? '' : String(vars[k])));

async function chat(config, messages, modelOverride) {
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
      body: JSON.stringify({ model: modelOverride || model, messages, temperature, stream: false }),
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
  const d = pickJSON(raw);

  const list = v =>
    Array.isArray(v) ? v.map(s => String(s).trim()).filter(Boolean) : [];
  const CATS = ['荤', '素', '汤', '主食', '甜点'];
  const LEVELS = ['简单', '中等', '有点难'];

  return {
    kcal: int(d.kcal, 300),
    p: int(d.p, 0),
    f: int(d.f, 0),
    c: int(d.c, 0),
    cat: CATS.includes(d.cat) ? d.cat : '荤',
    time: int(d.time, 0) || null,
    difficulty: LEVELS.includes(d.difficulty) ? d.difficulty : '简单',
    servings: Math.max(1, int(d.servings, 1)),
    ingredients: [
      ...list(d.main).map(name => ({ name, kind: 'main', need: true })),
      ...list(d.aux).map(name => ({ name, kind: 'aux', need: true })),
    ],
    steps: list(d.steps).join('\n'),
    tips: String(d.tips || '').slice(0, 120),
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

const CATS = ['荤', '素', '汤', '主食', '甜点'];

/** 拍照识别：把图片交给视觉模型，批量返回菜名和营养 */
export async function aiRecognize(config, imageDataUrl) {  const visionModel = config.ai.vision_model || config.ai.model;

  const messages = [
    {
      role: 'user',
      content: [
        { type: 'text', text: config.prompts.vision },
        { type: 'image_url', image_url: { url: imageDataUrl } },
      ],
    },
  ];

  const raw = await chat(config, messages, visionModel);
  const data = pickJSON(raw);
  const list = Array.isArray(data) ? data : data.dishes || data.items || [];

  return list
    .slice(0, 12)
    .map(x => ({
      name: String(x.name || '').trim().slice(0, 30),
      kcal: int(x.kcal, 250),
      p: int(x.p, 0),
      f: int(x.f, 0),
      c: int(x.c, 0),
      cat: CATS.includes(x.cat) ? x.cat : '荤',
    }))
    .filter(x => x.name);
}

/**
 * 给菜品生成一张卡通配图。 * 走 OpenAI 兼容的 /images/generations，返回 dataURL 或图片 URL。
 */
export async function aiGenerateImage(config, dish) {
  const { base_url, api_key, image_model, image_base_url, image_api_key, timeout_ms } = config.ai;

  if (!image_model) {
    throw new AiError('还没填「绘图模型」，去设置里填一个（如 dall-e-3、flux、seedream）');
  }

  // 绘图可以走独立服务：地址和 key 留空就用文本那套
  const root = String(image_base_url || base_url || '').replace(/\/+$/, '');
  const key = image_api_key || api_key;
  const url = `${root}/images/generations`;
  const prompt = fill(config.prompts.image, { dish });

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Number(timeout_ms) || 60000);

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${key}`,
      },
      body: JSON.stringify({
        model: image_model,
        prompt,
        n: 1,
        size: '512x512',
        response_format: 'b64_json',
      }),
      signal: controller.signal,
    });

    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      throw new AiError(`绘图接口返回 ${res.status}${detail ? '：' + detail.slice(0, 160) : ''}`);
    }

    const data = await res.json();
    const item = data?.data?.[0];

    if (item?.b64_json) return `data:image/png;base64,${item.b64_json}`;
    if (item?.url) return item.url;
    throw new AiError('接口没有返回图片');
  } catch (err) {
    if (err instanceof AiError) throw err;
    if (err.name === 'AbortError') throw new AiError('生成超时');
    throw new AiError(`生成失败：${err.message}`);
  } finally {
    clearTimeout(timer);
  }
}

/** 让模型整理今日全球新闻 */
export async function aiNews(config) {
  const raw = await chat(config, [{ role: 'user', content: config.prompts.news }]);
  const data = pickJSON(raw);
  const list = Array.isArray(data) ? data : data.news || data.items || [];

  return list
    .slice(0, 12)
    .map(x => ({
      title: String(x.title || '').trim().slice(0, 80),
      summary: String(x.summary || '').trim().slice(0, 160),
      source: String(x.source || '').trim().slice(0, 24),
    }))
    .filter(x => x.title);
}

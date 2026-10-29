/**
 * 配置：默认值 + INI 解析/序列化 + 本地存取。
 *
 * 注意：这是纯前端站点，浏览器读不到磁盘上的文件。
 * 所以 config.txt 的用法是「手动导入」——内容存进 localStorage，
 * 文件本身留在你自己电脑上，绝不提交到仓库。
 */

export const DEFAULT_CONFIG = {
  ai: {
    enabled: true,
    base_url: 'https://api.deepseek.com/v1',
    model: 'deepseek-flash',
    vision_model: '',
    image_model: '',
    image_base_url: '',
    image_api_key: '',
    api_key: '',
    temperature: 0.3,
    timeout_ms: 30000,
  },
  prompts: {
    estimate: [
      '你是中餐厨师兼营养师。针对菜「{dish}」，只输出 JSON，不要解释、不要 markdown。',
      '格式：{"kcal":每份热量, "p":蛋白克, "f":脂肪克, "c":碳水克,',
      '"cat":"荤|素|汤|主食|甜点", "time":用时分钟, "difficulty":"简单|中等|有点难", "servings":几人份,',
      '"main":["主材，带用量，如 番茄 2 个"], "aux":["辅料或调料，如 生抽 1 勺"],',
      '"steps":["步骤一","步骤二","步骤三"], "tips":"一条关键注意事项"}',
    ].join('\n'),
    advice: [
      '你是营养师。以下是某人今天吃的菜：',
      '{dishes}',
      '合计 {kcal} kcal，蛋白质 {p}g、脂肪 {f}g、碳水 {c}g，目标 {target} kcal。',
      '只输出 JSON：{"score": 0到100的整数, "comment": "一句话总体评价", "tips": ["建议1", "建议2"]}',
    ].join('\n'),
    suggest: [
      '我有这些食材：{ingredients}',
      '推荐 3 道能做的家常菜，只输出 JSON 数组：[{"name":"菜名","kcal":数字,"reason":"一句话"}]',
    ].join('\n'),
    vision: [
      '你在看一张饭菜照片。识别画面里所有能吃的东西，按一人份估算营养。',
      '只输出 JSON 数组，不要解释、不要 markdown：',
      '[{"name":"菜名","kcal":数字,"p":数字,"f":数字,"c":数字,"cat":"荤|素|汤|主食|甜点"}]',
      '看不清就把这道菜写「看不清的菜」，不要瞎猜细节。',
    ].join('\n'),
    image: [
      '画一张「{dish}」的卡通插画，日系手绘风格，暖色调，俯视摆盘，干净背景，',
      '食物细节清晰、看起来有食欲，不要出现文字和水印。',
    ].join('\n'),
    news: [
      '你是国际新闻编辑。请整理今天全球范围内最重要的 8 条新闻，用中文输出。',
      '覆盖政治、经济、科技、社会、科学等不同领域，避免同质化。',
      '只输出 JSON 数组，不要解释、不要 markdown：',
      '[{"title":"标题（25字内）","summary":"一句话摘要（50字内）","source":"媒体名"}]',
      '要求：只写你确实知道的事实；不确定的就不要写；不要编造链接。',
    ].join('\n'),
    newsSummary: [
      '下面是今天几条新闻的标题和来源摘要。请为每一条写两句话的中文总结，共 60–100 字。',
      '只陈述原文有的事实，不要评论，不要补充原文没有的信息。',
      '只输出 JSON 数组，不要解释、不要 markdown：',
      '[{"i":序号,"summary":"两句话总结"}]',
    ].join('\n'),
  },
};

/* ============================== INI ============================== */

export function parseINI(text) {
  const out = {};
  let section = 'general';
  for (const rawLine of String(text).split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#') || line.startsWith(';')) continue;

    const sec = line.match(/^\[(.+?)\]$/);
    if (sec) {
      section = sec[1].trim().toLowerCase();
      out[section] ||= {};
      continue;
    }

    const eq = line.indexOf('=');
    if (eq < 0) continue;

    const key = line.slice(0, eq).trim().toLowerCase();
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    // 允许 \n 转义，方便多行提示词
    value = value.replace(/\\n/g, '\n');

    out[section] ||= {};
    out[section][key] = value;
  }
  return out;
}

export function toINI(config) {
  const lines = [
    '# 养乐多在吃什么 — 本地配置',
    '# 这个文件只保存在你自己的电脑上，不要提交到仓库（.gitignore 已排除）',
    '',
  ];

  for (const [section, values] of Object.entries(config)) {
    lines.push(`[${section}]`);
    for (const [key, value] of Object.entries(values)) {
      if (typeof value === 'string' && value.includes('\n')) {
        lines.push(`${key} = ${value.replace(/\n/g, '\\n')}`);
      } else {
        lines.push(`${key} = ${value}`);
      }
    }
    lines.push('');
  }
  return lines.join('\n');
}

/** 把 INI 里读到的字符串归一成正确的类型，并补齐缺失字段 */
export function mergeConfig(parsed) {
  const cfg = structuredClone(DEFAULT_CONFIG);

  const ai = parsed.ai || {};
  if ('enabled' in ai) cfg.ai.enabled = String(ai.enabled).toLowerCase() !== 'false';
  if (ai.base_url) cfg.ai.base_url = ai.base_url;
  if (ai.model) cfg.ai.model = ai.model;
  if ('vision_model' in ai) cfg.ai.vision_model = ai.vision_model;
  if ('image_model' in ai) cfg.ai.image_model = ai.image_model;
  if ('image_base_url' in ai) cfg.ai.image_base_url = ai.image_base_url;
  if ('image_api_key' in ai) cfg.ai.image_api_key = ai.image_api_key;
  if ('api_key' in ai) cfg.ai.api_key = ai.api_key;
  if (ai.temperature) cfg.ai.temperature = Number(ai.temperature) || 0.3;
  if (ai.timeout_ms) cfg.ai.timeout_ms = Number(ai.timeout_ms) || 30000;

  const prompts = parsed.prompts || {};
  for (const key of ['estimate', 'advice', 'suggest', 'vision', 'image', 'news', 'newsSummary']) {
    if (prompts[key]) cfg.prompts[key] = prompts[key];
  }
  return cfg;
}

/* ============================== 存取 ============================== */

const KEY = 'yakult.config';

export function loadConfig() {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return structuredClone(DEFAULT_CONFIG);
    const merged = mergeConfig(JSON.parse(raw));

    // 旧版提示词只返回热量，没有做法/食材。
    // 检测到旧的就换回新版默认值，避免升级后 AI 还是旧格式。
    if (!merged.prompts.estimate.includes('"steps"')) {
      merged.prompts = structuredClone(DEFAULT_CONFIG.prompts);
    }
    return merged;
  } catch {
    return structuredClone(DEFAULT_CONFIG);
  }
}

export function saveConfig(config) {
  localStorage.setItem(KEY, JSON.stringify(config));
}

export const isAiReady = config => Boolean(config.ai.enabled && config.ai.base_url && config.ai.api_key && config.ai.model);

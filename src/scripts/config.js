/**
 * 配置：默认值 + INI 解析/序列化 + 本地存取。
 *
 * 注意：这是纯前端站点，浏览器读不到磁盘上的文件。
 * 所以 config.ini 的用法是「手动导入」——内容存进 localStorage，
 * 文件本身留在你自己电脑上，绝不提交到仓库。
 */

export const DEFAULT_CONFIG = {
  ai: {
    enabled: true,
    base_url: 'https://api.deepseek.com/v1',
    model: 'deepseek-v4.1-flash',
    api_key: '',
    temperature: 0.3,
    timeout_ms: 30000,
  },
  prompts: {
    estimate: [
      '你是营养师。估算这道菜「{dish}」每份的营养，只输出 JSON，不要解释。',
      '格式：{"kcal": 数字, "p": 数字, "f": 数字, "c": 数字, "comment": "20字以内点评"}',
      'p/f/c 分别是蛋白质/脂肪/碳水化合物，单位克。',
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
  if ('api_key' in ai) cfg.ai.api_key = ai.api_key;
  if (ai.temperature) cfg.ai.temperature = Number(ai.temperature) || 0.3;
  if (ai.timeout_ms) cfg.ai.timeout_ms = Number(ai.timeout_ms) || 30000;

  const prompts = parsed.prompts || {};
  for (const key of ['estimate', 'advice', 'suggest']) {
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
    return mergeConfig(JSON.parse(raw));
  } catch {
    return structuredClone(DEFAULT_CONFIG);
  }
}

export function saveConfig(config) {
  localStorage.setItem(KEY, JSON.stringify(config));
}

export const isAiReady = config => Boolean(config.ai.enabled && config.ai.base_url && config.ai.api_key && config.ai.model);

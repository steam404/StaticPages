/**
 * TXT 章节解析。
 *
 * 思路参考 Legado 的「多条规则 + 自动挑最合适的一条」：
 *   1. 用一组正则分别找候选标题
 *   2. 对每条规则打分（章数、章长是否合理）
 *   3. 选得分最高的规则，落到章节区间
 *   4. 都没有结果时，按段落切成等长小节，保证至少能翻页
 *
 * 不依赖 DOM，便于单测。
 */

const CN_NUM = '0-9０-９零〇一二三四五六七八九十百千万两';

/** 标题里不该出现的结尾（说明这是正文句子） */
const BAD_END = /[。！？!?；;，,、…—）)」』"”]$/;

/** 规则：按顺序尝试，每条返回 {title, weight} 或 null */
const RULES = [
  {
    name: '第X章',
    weight: 10,
    re: new RegExp(`^第\\s*([${CN_NUM}]{1,12})\\s*([章节回卷集部篇话幕])\\s*[、:：.．·\\-—]?\\s*(.{0,30})$`),
    make: (m, line) => line.trim(),
  },
  {
    name: '序章/楔子/番外',
    weight: 9,
    re: /^(序章|序言|序|楔子|引子|前言|尾声|后记|番外篇?|终章|大结局|完本感言|作者的话)\s*[、:：.．·\-—]?\s*(.{0,30})$/,
    make: (m, line) => line.trim(),
  },
  {
    name: 'Chapter N',
    weight: 9,
    re: /^(?:Chapter|CHAPTER|chapter)\s*([0-9]{1,4})\s*[、:：.．\-—]?\s*(.{0,30})$/,
    make: (m, line) => line.trim(),
  },
  {
    name: '卷X',
    weight: 7,
    re: new RegExp(`^卷\\s*([${CN_NUM}]{1,6})\\s*[、:：.．·\\-—]?\\s*(.{0,30})$`),
    make: (m, line) => line.trim(),
  },
  {
    name: '数字编号',
    weight: 4,
    re: /^([0-9]{1,4})\s*[.．、]\s*(\S.{0,28})$/,
    make: (m, line) => line.trim(),
  },
];

/** 章节行前面常见的修饰：正文 第一章、VIP章节 第3章、正文卷 第五回 */
const PREFIX_RE = /^(?:VIP章节|VIP卷|正文卷|正文|vip|VIP|Vip)\s*[:：、.．]?\s*/;

/** 去掉包裹的括号/书名号，以及「正文」这类前缀，便于匹配 */
function normalizeLine(raw) {
  // 括号可能在行内（【正文】第2章），一并去掉
  let t = String(raw)
    .trim()
    .replace(/[【】\[\]（）()「」『』《》]/g, '')
    .trim();

  t = t.replace(PREFIX_RE, '').trim();
  return t;
}

/** 这一行像不像章节标题 */
function matchLine(line) {
  const t = normalizeLine(line);
  if (!t || t.length > 50) return null;
  if (BAD_END.test(t)) return null;
  // 全是标点或纯数字的不算
  if (!/[\u4e00-\u9fa5A-Za-z0-9]/.test(t)) return null;

  for (const rule of RULES) {
    const m = rule.re.exec(t);
    if (!m) continue;

    // 「第X章」后面必须没有句读，且标题部分不能太长
    const tail = (m[2] || '').trim();
    if (tail.length > 40) continue;

    return { title: rule.make(m, t), weight: rule.weight, rule: rule.name };
  }
  return null;
}

export function isChapterTitle(line) {
  return Boolean(matchLine(line));
}

/** 按行切分，同时记录每行在原文里的字符偏移（不依赖行长度累加，避免 CRLF 误差） */
function splitLines(text) {
  const out = [];
  const re = /([^\n]*)(\n|$)/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    if (m[0] === '') break;
    out.push({ line: m[1].replace(/\r$/, ''), start: m.index });
    if (m[2] === '') break;
  }
  return out;
}

/** 收集某条规则的候选（用规则名过滤 matchLine 的结果） */
function collectByRule(lines, ruleName) {
  const hits = [];
  for (const { line, start } of lines) {
    const hit = matchLine(line);
    if (hit && hit.rule === ruleName) hits.push({ title: hit.title, start });
  }
  return hits;
}

/** 给候选打分：章数太少或章长离谱的规则降权 */
function scoreCandidates(text, hits) {
  if (hits.length < 3) return -1;

  const spans = [];
  for (let i = 0; i < hits.length; i++) {
    const end = i + 1 < hits.length ? hits[i + 1].start : text.length;
    spans.push(end - hits[i].start);
  }
  spans.sort((a, b) => a - b);
  const median = spans[Math.floor(spans.length / 2)];

  // 章长在 300～30000 字最合理
  let score = hits.length;
  if (median < 120) score -= 40;        // 基本是目录条目
  else if (median < 300) score -= 10;
  if (median > 30000) score -= 12;
  if (median > 100000) score -= 30;

  return score;
}

/** 把「太短、明显是目录」的章节并进相邻章，避免出现几十个空章 */
/**
 * 只合并「开头部分、极短」的候选（多半是没被识别成目录块的目录条目）。
 * 正文里的短章节要保留，不能一起吞掉。
 */
function mergeShortChapters(chapters, limit) {
  const MIN = 30;
  const merged = [];

  for (let i = 0; i < chapters.length; i++) {
    const c = chapters[i];
    const len = c.end - c.start;

    if (len < MIN && c.start < limit && i + 1 < chapters.length) {
      chapters[i + 1].start = c.start; // 并进下一章
      continue;
    }
    merged.push(c);
  }
  return merged;
}

/**
 * 去掉开头的目录块：
 * 连续 ≥5 个候选、彼此间隔 < 60 字，几乎可以肯定是目录列表。
 * 只在前 10% 的文本里判断，避免误伤正文中连续出现的短章节。
 */
function dropTocRuns(hits, textLength) {
  const limit = textLength * 0.1;
  const out = [];
  let pendingStart = -1;
  let i = 0;

  while (i < hits.length) {
    let j = i;
    while (j + 1 < hits.length && hits[j + 1].start - hits[j].start < 60) j++;

    const runLength = j - i + 1;
    if (runLength >= 5 && hits[i].start < limit) {
      if (pendingStart < 0) pendingStart = hits[i].start;
      i = j + 1;
      continue;
    }

    const h = { ...hits[i] };
    if (pendingStart >= 0) {
      h.start = pendingStart;
      pendingStart = -1;
    }
    out.push(h);
    i++;
  }

  return out;
}

/** 没有识别出任何章节时的兜底：按段落切成长度接近的若干节 */
function fallbackSections(text, size = 4000) {
  const sections = [];
  const total = text.length;
  let pos = 0;
  let n = 0;

  while (pos < total) {
    let end = Math.min(total, pos + size);
    if (end < total) {
      // 往后找一个段落边界，避免从句子中间切开
      const nextBreak = text.indexOf('\n', end);
      if (nextBreak > -1 && nextBreak - end < 800) end = nextBreak + 1;
    }
    n++;
    sections.push({ title: `第 ${n} 节`, start: pos, end });
    pos = end;
  }

  return sections.length ? sections : [{ title: '全文', start: 0, end: total }];
}

export function parseChapters(text) {
  const src = String(text ?? '');
  if (!src.trim()) return [{ title: '全文', start: 0, end: src.length }];

  const lines = splitLines(src);

  // 1) 先全量扫一遍「第X章/节/回」。只要够 3 条就直接采用，
  //    不再让打分或兜底规则把它挤掉 —— 这类标题几乎不会误判。
  const strictHits = collectByRule(lines, '第X章');
  const names = new Set();

  if (strictHits.length >= 3) {
    for (const n of ['第X章', '序章/楔子/番外', 'Chapter N', '卷X']) names.add(n);
  } else {
    // 2) 没有「第X章」时才按打分挑规则
    let best = null;
    for (const rule of RULES) {
      const hits = collectByRule(lines, rule.name);
      const score = scoreCandidates(src, hits) + rule.weight;
      if (score < 0) continue;
      if (!best || score > best.score) best = { score, hits, rule: rule.name };
    }
    if (!best || best.hits.length < 2) return fallbackSections(src);

    for (const n of [best.rule, '序章/楔子/番外', 'Chapter N']) names.add(n);
  }

  const all = [];
  for (const name of names) all.push(...collectByRule(lines, name));
  all.sort((a, b) => a.start - b.start);

  const deduped = [];
  for (const h of all) {
    if (deduped.length && h.start === deduped[deduped.length - 1].start) continue;
    deduped.push(h);
  }

  const hits = dropTocRuns(deduped, src.length);

  if (hits.length < 2) return fallbackSections(src);

  const chapters = hits.map((h, i) => ({
    title: h.title,
    start: h.start,
    end: i + 1 < hits.length ? hits[i + 1].start : src.length,
  }));

  const cleaned = mergeShortChapters(chapters, src.length * 0.1);

  // 开头若还有一段正文（书名、作者、简介），补成「开始」
  if (cleaned.length && cleaned[0].start > 0) {
    const head = src.slice(0, cleaned[0].start);
    if (head.trim().length > 30) {
      cleaned.unshift({ title: '开始', start: 0, end: cleaned[0].start });
    } else {
      cleaned[0].start = 0;
    }
  }

  return cleaned.length ? cleaned : fallbackSections(src);
}

/** 供测试/调试：返回命中的规则名 */
export function detectRule(text) {
  const src = String(text ?? '');
  const lines = splitLines(src);

  const strict = collectByRule(lines, '第X章');
  if (strict.length >= 3) return { score: strict.length, count: strict.length, rule: '第X章' };

  let best = null;
  for (const rule of RULES) {
    const hits = collectByRule(lines, rule.name);
    const score = scoreCandidates(src, hits) + rule.weight;
    if (score < 0) continue;
    if (!best || score > best.score) best = { score, count: hits.length, rule: rule.name };
  }
  return best;
}

/**
 * TXT 章节解析：从纯文本里识别章节标题，返回 [{title,start,end}]。
 * 单独抽出来便于测试，不依赖 DOM。
 */

const NUM = '[0-9０-９零一二三四五六七八九十百千万两]+';
const UNIT = '[章节回卷部篇集话]';

// 「第一章」「第三卷」这种只有标号的
const RE_CN_BARE = new RegExp(`^第\\s*${NUM}\\s*${UNIT}$`);
// 「第一章 初见」「第一章：初见」「第一章、初见」
const RE_CN_TITLED = new RegExp(`^第\\s*${NUM}\\s*${UNIT}(?:\\s+|[、:：·\\-—]\\s*)(.{1,24})$`);

const RE_SPECIAL_BARE = /^(序章|序言|楔子|引子|前言|尾声|后记|番外|终章|大结局)$/;
const RE_SPECIAL_TITLED = /^(序章|序言|楔子|引子|前言|尾声|后记|番外|终章|大结局)(?:\s+|[、:：·\-—]\s*)(.{1,24})$/;

const RE_EN_BARE = /^(Chapter|CHAPTER)\s+\d+$/;
const RE_EN_TITLED = /^(Chapter|CHAPTER)\s+\d+(?:\s*[:.\-—]\s*|\s+)(.{1,24})$/;

export function isChapterTitle(line) {
  const t = String(line).trim();
  if (!t || t.length > 40) return false;

  // 以句末标点结尾的一律当正文，避免「第一章就写得很乱。」
  if (/[。！？!?；;，,、]$/.test(t)) return false;

  if (RE_CN_BARE.test(t) || RE_SPECIAL_BARE.test(t) || RE_EN_BARE.test(t)) return true;
  return RE_CN_TITLED.test(t) || RE_SPECIAL_TITLED.test(t) || RE_EN_TITLED.test(t);
}

export function parseChapters(text) {
  const src = String(text);
  const chapters = [];
  let offset = 0;

  for (const line of src.split('\n')) {
    if (isChapterTitle(line)) {
      if (chapters.length) chapters[chapters.length - 1].end = offset;
      chapters.push({ title: line.trim(), start: offset, end: src.length });
    }
    offset += line.length + 1;
  }

  if (!chapters.length) return [{ title: '全文', start: 0, end: src.length }];

  if (chapters[0].start > 0) {
    const head = src.slice(0, chapters[0].start).trim();
    if (head) chapters.unshift({ title: '开始', start: 0, end: chapters[0].start });
  }

  return chapters;
}

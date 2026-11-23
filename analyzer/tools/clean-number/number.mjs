import path from 'node:path';

export function numberText(content, { name = 'upload.txt', examples = [], chapterHeadings = null } = {}) {
  const raw = String(content || '').replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');const stripSpace = (s) => s.replace(/[\s\u3000]/g, '');

// ── ① 分句 ──
const END = new Set(['。', '！', '？', '…']);
// 只把引号当收尾符号；括号、书名号不算句末，否则《书》（第1章）会被切断
const CLOSERS = new Set(['」', '』', '”', '’']);
const PUNCT_ONLY = /^[。！？…，、；：""''（）【】《》「」『』”—\-·\s]+$/;

const sentences = [];
let buffer = '';
const flush = () => {
  const text = buffer.trim();
  buffer = '';
  if (!text) return;
  if (PUNCT_ONLY.test(text) && sentences.length && !atomicHeadings.has(sentences.at(-1))) { sentences[sentences.length - 1] += text; return; }
  sentences.push(text);
};
const atomicHeadings = new Set(Array.isArray(chapterHeadings) ? chapterHeadings.map(s=>String(s).trim()) : []);
for (const line of raw.split('\n')) {
if (atomicHeadings.has(line.trim())) { flush(); sentences.push(line.trim()); continue; }
for (const char of line + '\n') {
  buffer += char;
  if (END.has(char)) continue;
  if (CLOSERS.has(char) || char === '\n') { flush(); continue; }
}
}
flush();

const sentenceRecords = sentences.map((text, i) => ({ id: `S${i + 1}`, n: i + 1, text, chars: stripSpace(text).length }));
const sourceChars = stripSpace(raw).length;
const sentenceChars = sentenceRecords.reduce((sum, s) => sum + s.chars, 0);
const coverage = sourceChars ? sentenceChars / sourceChars : 1;

// ── ② 分段 ──
const paragraphs = [];
let current = null;
for (let i = 0; i < sentenceRecords.length; i += 1) {
  const s = sentenceRecords[i];
  if (!current) current = { from: i + 1, to: i + 1, chars: s.chars };
  else { current.to = i + 1; current.chars += s.chars; }
  if (current.chars >= 200 || i + 1 === sentenceRecords.length) { paragraphs.push({ ...current }); current = null; }
}
const paragraphRecords = paragraphs.map((p, i) => ({
  id: `P${i + 1}`, n: i + 1, from: `S${p.from}`, to: `S${p.to}`, chars: p.chars, sentences: p.to - p.from + 1,
}));

// ── ③ 分章 ──
function regexFromExamples(list) {
  const NUM = '[一二三四五六七八九十百千零两0-9]{1,8}';
  const DIGIT = /[一二三四五六七八九十百千零两0-9]/;
  const items = list.map((s) => String(s).trim()).filter(Boolean);
  if (!items.length) return null;
  const parts = items.map((s) => {
    const i = s.split('').findIndex((c) => DIGIT.test(c));
    if (i < 0) return { prefix: s, suffix: '' };
    let j = i;
    while (j < s.length && DIGIT.test(s[j])) j += 1;
    return { prefix: s.slice(0, i), suffix: s.slice(j) };
  });
  const common = (values) => {
    if (!values.length) return '';
    return values.reduce((a, b) => { let i = 0; while (i < a.length && i < b.length && a[i] === b[i]) i += 1; return a.slice(0, i); });
  };
  const prefix = common(parts.map((p) => p.prefix));
  const suffix = items.length >= 2 ? common(parts.map((p) => [...p.suffix].reverse().join(''))) : '';
  const suffixText = [...suffix].reverse().join('');
  const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  try { return new RegExp('^' + esc(prefix) + NUM + esc(suffixText) + '$'); } catch { return null; }
}

const userRegex = regexFromExamples(examples);
const BUILTIN = /^(《.+?》（第[0-9]+章[^）]*）|第[一二三四五六七八九十百千零\d]{1,8}[章节回]|.{2,16}[（(][一二三四五六七八九十百零\d]{1,6}[）)]\s*$)/;
const collect = (matcher, maxLen) => {
  const out = [];
  for (const s of sentenceRecords) {
    const text = s.text.trim();
    if (text.length <= maxLen && matcher.test(text)) out.push({ id: s.id, title: text });
  }
  return out;
};

let headings = [];
let usedRule = 'builtin';
if (Array.isArray(chapterHeadings)) {
  const confirmed = new Set(chapterHeadings.map((s) => String(s).trim()));
  headings = sentenceRecords.filter((s) => confirmed.has(s.text.trim())).map((s) => ({id:s.id,title:s.text.trim()}));
  usedRule = 'confirmed-clean-directory';
} else if (userRegex) {
  headings = collect(userRegex, 60);
  usedRule = 'examples';
}
if (!Array.isArray(chapterHeadings) && headings.length < 3) {
  const fallback = collect(BUILTIN, 60);
  if (fallback.length > headings.length) {
    headings = fallback;
    usedRule = userRegex ? 'builtin-fallback' : 'builtin';
  }
}

// 段落不能跨章节边界，否则目录预览和导入会漏掉下一章开头。
const chapterStarts = headings.map((h) => Number(h.id.slice(1)));
const alignedParagraphs = [];
for (const para of paragraphRecords) {
  const from = Number(para.from.slice(1)); const to = Number(para.to.slice(1));
  const cuts = [from, ...chapterStarts.filter((n) => n > from && n <= to), to + 1];
  for (let i = 0; i < cuts.length - 1; i += 1) {
    const start = cuts[i]; const end = cuts[i + 1] - 1; const n = alignedParagraphs.length + 1;
    alignedParagraphs.push({ id: `P${n}`, n, from: `S${start}`, to: `S${end}`, chars: sentenceRecords.slice(start - 1, end).reduce((sum, s) => sum + s.chars, 0), sentences: end - start + 1 });
  }
}
paragraphRecords.splice(0, paragraphRecords.length, ...alignedParagraphs);

const chapters = headings.map((h, i) => {
  const start = Number(h.id.slice(1));
  const end = i + 1 < headings.length ? Number(headings[i + 1].id.slice(1)) - 1 : sentenceRecords.length;
  return {
    id: `C${i + 1}`, n: i + 1, title: h.title,
    from: `S${start}`, to: `S${end}`, sentences: end - start + 1,
    paragraphs: paragraphRecords.filter((p) => {
      const from = Number(p.from.slice(1));
      return from >= start && from <= end;
    }).map((p) => p.id),
  };
});

// ── ④ 校验 ──
const warnings = [];
if (!chapters.length) warnings.push('没有识别到章节标题');
if (usedRule === 'builtin-fallback') warnings.push('你给的示例没匹配到 3 条以上标题，已改用内置规则（示例格式可能和正文不一致）');
if (coverage < 0.995) warnings.push(`原文覆盖不足 ${(coverage * 100).toFixed(2)}%（句子合计 ${sentenceChars} 字 / 原文 ${sourceChars} 字）：可能有文字被漏掉`);
if (coverage > 1.005) warnings.push(`句子合计超过原文 ${(coverage * 100).toFixed(2)}%：可能有内容被重复计入`);
const dupMap = new Map();
for (const s of sentenceRecords) if (s.chars > 12) dupMap.set(s.text, (dupMap.get(s.text) || 0) + 1);
const dupSentences = [...dupMap.entries()].filter(([, n]) => n > 1);
if (dupSentences.length) warnings.push(`重复句 ${dupSentences.length} 条（同句多次出现）：${dupSentences.slice(0, 3).map(([t]) => t.slice(0, 12)).join('、')}`);
const shortChapters = chapters.filter((c) => c.sentences < 3);
if (shortChapters.length) warnings.push(`过短章节 ${shortChapters.length} 个（<3 句）`);
const longParagraphs = paragraphRecords.filter((p) => p.chars > 400);
if (longParagraphs.length) warnings.push(`超长段落 ${longParagraphs.length} 个（>400 字）`);

const doc = {
  schema: 'novel-numbered/v2',
  app: { name: 'corpus-kit numberer' },
  generatedAt: new Date().toISOString(),
  source: { file: path.basename(name), chars: raw.length },
  numbering: { chapter: 'C', paragraph: 'P', sentence: 'S', order: 'bottom-up' },
  userExamples: examples,
  chapterRule: usedRule,
  totals: { chapters: chapters.length, paragraphs: paragraphRecords.length, sentences: sentenceRecords.length },
  coverage: { sourceChars, sentenceChars, ratio: Number(coverage.toFixed(4)) },
  duplicateSentences: dupSentences.length,
  warnings,
  chapters,
  paragraphs: paragraphRecords,
  sentences: sentenceRecords,
};

return doc;
}

import fs from 'node:fs';
import { getTemplate } from '../../core/prompt-templates.mjs';
import { profileHeadings } from './heading-profile.mjs';
import { buildStructuredIndex } from './structured-index.mjs';

const defaultPrompt = fs.readFileSync(new URL('../../prompts/clean-chapters.prompt', import.meta.url), 'utf8');
const numbered = /^(?:《[^》]+》[（(]第|卷[\d一二三四五六七八九十百千零两]+\s+第|第[\d一二三四五六七八九十百千零两]+[章节回卷部]|[\d０-９]+[.．、)）]|[一二三四五六七八九十百]+[、.．]|Chapter\s+[\dIVXLCDM]+)/i;
const volumePrefix = /^(卷[\d一二三四五六七八九十百千零两]+|第[\d一二三四五六七八九十百千零两]+[卷部])\s+(?=第)/;
const INPUT_LIMIT = 24000;
function batches(rows, prefix, maxRows = 120) {
  if (prefix.length + 2 >= INPUT_LIMIT) throw new Error('章节识别提示词过长，请缩短 Prompt 后重试');
  const result = []; let batch = []; let size = prefix.length + 2;
  for (const row of rows) {
    const length = JSON.stringify(row).length + 1;
    if (prefix.length + length + 2 > INPUT_LIMIT) throw new Error('章节候选内容超过单次模型输入限制');
    if (batch.length && (batch.length >= maxRows || size + length > INPUT_LIMIT)) { result.push(batch); batch = []; size = prefix.length + 2; }
    batch.push(row); size += length;
  }
  if (batch.length) result.push(batch);
  return result;
}
function outlineSample(rows, limit = 6000) {
  const all = rows.map((r) => `${r.index}|${r.line}`);
  if (all.join('\n').length <= limit) return all.join('\n');
  // 均匀保留全书的格式样本；本批仍逐条提供，采样不会跳过候选。
  const count = Math.max(2, Math.floor(limit / (Math.max(...all.map((s) => s.length)) + 1)) - 1);
  return '[全书标题格式采样；非完整目录]\n' + Array.from({ length: count }, (_, i) => all[Math.round(i * (all.length - 1) / (count - 1))]).join('\n');
}
function sourceOrdinal(raw) {
  const text = String(raw).normalize('NFKC').replace(volumePrefix, '');
  const match = text.match(/^(?:《[^》]+》\(第|第)?([\d零〇一二三四五六七八九十百千两]+)(?:[章节回卷部]|[.、)])/);
  if (!match) return null;
  if (/^\d+$/.test(match[1])) return Number(match[1]);
  const digits = {零:0,〇:0,一:1,二:2,两:2,三:3,四:4,五:5,六:6,七:7,八:8,九:9};
  const units = {十:10,百:100,千:1000}; let sum = 0; let n = 0;
  for (const char of match[1]) { if (char in digits) n = digits[char]; else { sum += (n || 1) * units[char]; n = 0; } }
  return sum + n;
}
export function collectChapterCandidates(text) {
  const lines = String(text).split('\n');
  const adjacent = (index, direction) => {
    for (let i = index + direction; i >= 0 && i < lines.length; i += direction) if (lines[i].trim()) return lines[i].trim().slice(0, 100);
    return '';
  };
  return lines.map((raw, index) => ({ index, line: raw.trim(), indented: /^\s/.test(raw) })).filter((row) => row.line && row.line.length <= 90 && (numbered.test(row.line) || (!/^[“‘「『]/.test(row.line) && !/[。！？!?；;，,：:”“‘’」』]$/.test(row.line)))).map((row) => ({ ...row, before: adjacent(row.index, -1), after: adjacent(row.index, 1) }));
}

function titleOf(raw) {
  return raw.replace(volumePrefix, '').replace(/^《[^》]+》[（(]第[^）)]+[）)]\s*/, '')
    .replace(/^第[\d一二三四五六七八九十百千零两]+[章节回卷部]\s*[:：、.．]?\s*/, '')
    .replace(/^(?:[\d０-９]+|[一二三四五六七八九十百]+)[.．、)）]\s*/, '')
    .replace(/^Chapter\s+[\dIVXLCDM]+\s*[:.\-]?\s*/i, '').trim();
}

function headingFamily(raw) {
  const text = String(raw).normalize('NFKC');
  if (volumePrefix.test(text)) return 'volume-chapter';
  if (/^(?:《[^》]+》\(第|第)[\d一二三四五六七八九十百千零两]+[章回节]/.test(text)) return 'chapter';
  if (/^\d+[.、)]/.test(text)) return 'digits';
  if (/^[一二三四五六七八九十百]+[、.]/.test(text)) return 'chinese-list';
  if (/^Chapter\s/i.test(text)) return 'english';
  return 'other';
}

export async function reviewChapterCandidates(rows, model, chat, options = {}) {
  const rules = getTemplate('cleanChapterReview') || fs.readFileSync(new URL('../../prompts/clean-chapter-review.prompt', import.meta.url), 'utf8');
  const input = rows.map((r) => ({ id: 'L' + r.index, title: r.line || r.raw, before: r.before, after: r.after }));
  const reference = options.referenceRows?.length ? '\n【全书绝大多数正文章节的标题格式参考；不是待审核清单】\n' + outlineSample(options.referenceRows, 4000) + '\n下面待审核候选偏离主要标题格式。逐条核实：完整叙事句、人物对话、卷末结束标记应剔除；只有确实独立的小说章节才保留。\n' : '';
  const prefix = rules + reference + '\n【第一轮章节候选及上下文（唯一待审核清单）】\n';
  const rejected = [];
  for (const batch of batches(input, prefix, 60)) {
  const result = await chat({ prompt: prefix + JSON.stringify(batch), model, maxTokens: 2500, temperature: 0, source: options.source || 'clean-chapter-review' });
  const raw = String(result.content || ''); const data = JSON.parse(raw.slice(raw.indexOf('{'), raw.lastIndexOf('}') + 1));
  rejected.push(...(data.reject || []).map((item) => {
    const row = rows.find((r) => 'L' + r.index === item.id && batch.some((b) => b.id === item.id));
    if (!row) throw new Error('章节复核返回了无效定位标识：' + String(item.id));
    return { index: row.index, line: row.line || row.raw, reason: String(item.reason || '') };
  }));
  }
  return rejected;
}

export async function buildChapterIndex(text, fallbackName, model, chat, options = {}) {
  if (chat && options.strategy === 'auto') {
    const profile = profileHeadings(text);
    const minorNumberCount = profile.families.filter(f=>['number-punctuation','chinese-punctuation','number-space'].includes(f.id)).reduce((sum,f)=>sum+f.count,0);
    const mixedShortNumbers = text.length < 600000 && profile.families.length && (profile.families.every(f=>['number-punctuation','chinese-punctuation'].includes(f.id)) || (profile.families.some(f=>f.id==='chapter-章') && minorNumberCount>=8));
    if (profile.rows.some(row=>row.standardized) || (profile.rows.length >= 4 && !mixedShortNumbers)) {
      const structured = await buildStructuredIndex(text, fallbackName, model, chat, { ...options, profile });
      if (structured) return structured;
    }
  }
  const lines = String(text).split('\n');
  const candidates = collectChapterCandidates(text);
  const source = String(options.sourceText || text);
  const explicit = source.split(/\r?\n/).slice(0, 30).map((s) => s.trim()).find((s) => /^《[^》]+》$/.test(s));
  let bookName = options.bookName || (explicit ? explicit.slice(1, -1) : '') || fallbackName || '未命名';
  const selected = new Map();
  const warnings = [];
  const rejected = []; let firstPassCount = 0; let coverageAdded = 0;
  const numberedCandidates = candidates.filter((r) => numbered.test(r.line));
  const outline = outlineSample(numberedCandidates);
  if (chat) {
    const prefix = [getTemplate('clean') || defaultPrompt, '【文档开头（只作书名与结构参考）】', source.slice(0, 1200), '【全书带编号的标题候选总览（可能包含正文列表，必须甄别）】', outline, '【本批候选及相邻正文；只返回本批候选的 index】', ''].join('\n\n');
    for (const batch of batches(candidates, prefix)) {
      const prompt = prefix + JSON.stringify(batch);
      const result = await chat({ prompt, model, maxTokens: 5000, temperature: 0, source: 'clean-chapters' });
      const raw = String(result.content || '');
      const data = JSON.parse(raw.slice(raw.indexOf('{'), raw.lastIndexOf('}') + 1));
      if (!explicit && !options.bookName && data.bookName && source.includes(String(data.bookName))) bookName = String(data.bookName);
      for (const item of data.rows || []) {
        const row = batch.find((r) => r.index === Number(item.index));
        if (!row || (item.kind && item.kind !== 'chapter')) continue;
        selected.set(row.index, { ...row, number: sourceOrdinal(row.line) || (Number(item.number) > 0 ? Number(item.number) : null), kind: 'chapter', source: 'model' });
      }
    }
    // 长目录初筛偶尔会漏项；仅补核原文中尚未选中的编号候选，仍由模型判断层级。
    firstPassCount = selected.size;
    const omitted = numberedCandidates.filter((row) => !selected.has(row.index));
    if (selected.size && omitted.length) {
      const prefix = [getTemplate('clean') || defaultPrompt, '【文档开头】', source.slice(0, 1200), '【全书主标题格式参考】', outline,
        '【遗漏补核】下面是第一轮未选中的编号候选。逐条判断是否为遗漏的正文章节；正文列表仍须排除，换卷后章号重置不应遗漏。只返回本批候选的 index。', ''].join('\n\n');
      for (const batch of batches(omitted, prefix, 60)) {
        const result = await chat({ prompt: prefix + JSON.stringify(batch), model, maxTokens: 3000, temperature: 0, source: 'clean-chapter-coverage' });
        const raw = String(result.content || ''); const data = JSON.parse(raw.slice(raw.indexOf('{'), raw.lastIndexOf('}') + 1));
        for (const item of data.rows || []) {
          const row = batch.find((r) => r.index === Number(item.index));
          if (row && (!item.kind || item.kind === 'chapter')) selected.set(row.index, { ...row, number: sourceOrdinal(row.line) || (Number(item.number) > 0 ? Number(item.number) : null), kind: 'chapter', source: 'model' });
        }
      }
    }
    coverageAdded = selected.size - firstPassCount;
    if (selected.size) {
      const reviewRows = [...selected.values()].sort((a, b) => a.index - b.index);
      rejected.push(...await reviewChapterCandidates(reviewRows, model, chat));
      for (const item of rejected) selected.delete(item.index);
      const remaining = [...selected.values()]; const families = new Map();
      for (const row of remaining) { const family = headingFamily(row.line); if (!families.has(family)) families.set(family, []); families.get(family).push(row); }
      const dominant = [...families.values()].sort((a,b) => b.length - a.length)[0] || [];
      if (dominant.length >= 10 && dominant.length / remaining.length >= 0.8) {
        const main = new Set(dominant.map((row) => row.index)); const outliers = remaining.filter((row) => !main.has(row.index));
        if (outliers.length) {
          const audit = await reviewChapterCandidates(outliers, model, chat, { referenceRows: dominant, source: 'clean-chapter-outlier-review' });
          rejected.push(...audit); for (const item of audit) selected.delete(item.index);
        }
      }
    }
    const supplements = candidates.filter((row) => /^(?:《[^》]+》\s*)?(?:[（(【\[]\s*)?(?:前言|序言|序章|楔子|引子|后记|後記|跋|附录|附錄|第[\d一二三四五六七八九十百千]+[卷部])/.test(row.line));
    if (supplements.length) {
      const rules = getTemplate('cleanSupplementary') || fs.readFileSync(new URL('../../prompts/clean-supplementary.prompt', import.meta.url), 'utf8');
      const prefix = rules + '\n【附属篇目候选及上下文】\n';
      for (const batch of batches(supplements, prefix, 60)) {
      const result = await chat({ prompt: prefix + JSON.stringify(batch), model, maxTokens: 1500, temperature: 0, source: 'clean-supplementary' });
      const raw = String(result.content || ''); const data = JSON.parse(raw.slice(raw.indexOf('{'), raw.lastIndexOf('}') + 1));
      for (const item of data.rows || []) {
        const row = batch.find((r) => r.index === Number(item.index));
        if (row && ['preface', 'afterword', 'appendix', 'volume'].includes(item.kind)) selected.set(row.index, { ...row, number: null, kind: item.kind, source: 'model' });
      }
      }
    }
  } else {
    for (const row of candidates) {
      const match = row.line.match(/^(?:《[^》]+》[（(])?第(\d+)[章回]/);
      if (match) selected.set(row.index, { ...row, kind: 'chapter', number: Number(match[1]), source: 'rule' });
    }
  }
  const sections = [...selected.values()].sort((a, b) => a.index - b.index);
  let ordinal = 0;
  for (const section of sections) {
    if (section.kind === 'chapter') {
      ordinal += 1;
      section.number = sourceOrdinal(section.line) || section.number || ordinal;
      section.title = titleOf(section.line);
      section.volumeLabel = section.line.match(volumePrefix)?.[1] || '';
      section.heading = `《${bookName}》（第${section.number}章${section.volumeLabel ? '·' + section.volumeLabel : ''}）${section.title ? ' ' + section.title : ''}`;
    } else { section.title = section.line; section.heading = section.line; }
    section.raw = section.line;
  }
  const chapters = sections.filter((s) => s.kind === 'chapter');
  for (let i = 1; i < chapters.length; i += 1) if (chapters[i].volumeLabel === chapters[i - 1].volumeLabel && chapters[i].number !== chapters[i - 1].number + 1) warnings.push(`章号不连续：${chapters[i - 1].number} → ${chapters[i].number}`);
  const byLine = new Map(sections.map((s) => [s.index, s]));
  const body = lines.map((line, index) => byLine.get(index)?.heading || line).join('\n');
  const toc = sections.map((s) => s.heading);
  return { bookName, chapterCount: chapters.length, chapters, sections, warnings, structured: `书名《${bookName}》\n\n共 ${chapters.length} 章\n\n清洗后目录：\n${toc.join('\n')}\n\n清洗正文：\n\n${body}`, cleanDoc: { 书名: bookName, 目录: toc, 正文: body }, validation: { candidates: candidates.length, firstPassCount, coverageAdded, rejected, modelChapters: chapters.filter((s) => s.source === 'model').length, supplementarySections: sections.length - chapters.length } };
}

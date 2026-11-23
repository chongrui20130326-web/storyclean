import { detectChapter } from './vendor/parse.mjs';
import { scanInvisible } from './vendor/invisible.mjs';

const banner = /^[\p{Script=Han}\d]{0,12}(?:https?:\/\/|www\.)[a-z\d.-]+\.(?:com|net|org|cn|cc|info)\/?$/iu;
const toc = /^(?:目\s*录|Table of Contents)$/i;
const compact = (s) => s.replace(/\s/g, '');
export const visibleChars = (s) => compact(s).length;

export function sourceLines(text) {
  const rows = [];
  let start = 0;
  for (const match of text.matchAll(/\r\n|\r|\n/g)) {
    rows.push({ line: rows.length + 1, start, end: match.index, raw: text.slice(start, match.index) });
    start = match.index + match[0].length;
  }
  if (start < text.length || !rows.length) {
    rows.push({ line: rows.length + 1, start, end: text.length, raw: text.slice(start) });
  }
  return rows;
}

const normalizedLine = (raw) => scanInvisible(raw).cleaned.trim();

export function defaultEdits(text, fallback) {
  const rows = sourceLines(text).map(row => ({ ...row, text: normalizedLine(row.raw) }));
  const first = rows.find(row => row.text);
  const titleMatch = first?.text.match(/^《([^》]{1,80})》$/);
  const titleLine = titleMatch ? first.line : null;
  const title = titleMatch?.[1]?.trim() || fallback;
  const lastHeading = new Map();
  for (const row of rows) {
    if (detectChapter(row.text)) lastHeading.set(compact(row.text), row.line);
  }
  const removed = [];
  const headings = [];
  let directory = false;
  for (const row of rows) {
    if (!row.text || row.line === titleLine) continue;
    if (toc.test(row.text) && row.line <= 40 && !headings.length) {
      directory = true;
      removed.push({ line: row.line, reason: '独立目录标题' });
      continue;
    }
    if (banner.test(compact(row.text))) {
      removed.push({ line: row.line, reason: '独立站点网址行' });
      continue;
    }
    if (detectChapter(row.text)) {
      if (directory && lastHeading.get(compact(row.text)) > row.line) {
        removed.push({ line: row.line, reason: '目录中重复出现的章标题' });
      } else {
        directory = false;
        headings.push({ line: row.line, title: row.text });
      }
    } else {
      directory = false;
    }
  }
  return { title, titleLine, headings, removed, merges: [] };
}

function label(value, field) {
  if (typeof value !== 'string' || !value.trim() || value.length > 250 || /[\r\n\u0000]/.test(value)) {
    throw Error(field + '须为 1–250 字的单行文本');
  }
  return value.trim();
}

export function makeClean(text, edits) {
  const original = sourceLines(text);
  const rows = original.map(row => ({ ...row, text: normalizedLine(row.raw) }));
  if (!edits || ![edits.headings, edits.removed, edits.merges].every(Array.isArray)) {
    throw Error('缺少清洗选项');
  }
  const title = label(edits.title, '书名');
  const used = new Set();
  function reserve(line) {
    if (!Number.isInteger(line) || !rows[line - 1]?.text || used.has(line)) {
      throw Error('原文行号无效、为空或同时选中多种处理：' + line);
    }
    used.add(line);
    return line;
  }
  const titleLine = edits.titleLine == null ? null : reserve(edits.titleLine);
  const byLine = (a, b) => a.line - b.line;
  const headings = edits.headings.map(row => ({ line: reserve(row.line), title: label(row.title, '章标题') })).sort(byLine);
  const removed = edits.removed.map(row => ({ line: reserve(row.line), reason: label(row.reason, '删除原因') })).sort(byLine);
  const merges = edits.merges.map(reserve).sort((a, b) => a - b);
  const headingByLine = new Map(headings.map(row => [row.line, row.title]));
  const removalByLine = new Map(removed.map(row => [row.line, row.reason]));
  const mergeSet = new Set(merges);
  const audit = [];
  const groups = [];
  let current = { title: '正文', headingLine: null, paragraphs: [] };
  groups.push(current);
  let previousBody = null;
  let bodyOffset = 0;
  let paragraphCount = 0;
  for (const row of rows) {
    const { line, start, end, raw } = row;
    const record = { line, start, end };
    if (row.text !== raw) audit.push({ ...record, action: !row.text ? 'blank' : 'normalize', before: raw, after: row.text });
    if (line === titleLine) {
      audit.push({ ...record, action: 'title', before: row.text, after: title });
      previousBody = null;
    } else if (headingByLine.has(line)) {
      current = { title: headingByLine.get(line), headingLine: line, paragraphs: [] };
      groups.push(current);
      audit.push({ ...record, action: 'heading', before: row.text, after: current.title });
      previousBody = null;
    } else if (removalByLine.has(line)) {
      audit.push({ ...record, action: 'remove', before: row.text, reason: removalByLine.get(line) });
      previousBody = null;
    } else if (!row.text) {
      previousBody = null;
    } else {
      if (mergeSet.has(line)) {
        if (!previousBody) throw Error('原文第 ' + line + ' 行须紧接一个正文行才能合并');
        audit.push({ ...record, action: 'merge', intoLine: previousBody.pieces[0].line });
      } else {
        bodyOffset += paragraphCount++ > 0 ? 1 : 0;
        previousBody = { start: bodyOffset, end: bodyOffset, text: '', pieces: [] };
        current.paragraphs.push(previousBody);
      }
      previousBody.text += row.text;
      previousBody.pieces.push({ line, sourceStart: start, sourceEnd: end, start: bodyOffset, end: bodyOffset + row.text.length });
      bodyOffset += row.text.length;
      previousBody.end = bodyOffset;
    }
  }
  const chapters = groups.filter(group => group.headingLine !== null || group.paragraphs.length);
  const body = chapters.flatMap(group => group.paragraphs.map(p => p.text)).join('\n');
  if (!body.trim()) throw Error('清洗后没有正文，请检查书名、目录和移除选项');
  const warnings = chapters.filter(c => !c.paragraphs.length).map(c => '章标题后无正文（原文第 ' + c.headingLine + ' 行）');
  return { title, edits: { title, titleLine, headings, removed, merges }, chapters, body, lineCount: rows.length, audit, warnings };
}

// 在旧版句末标点规则上，保留连续标点和随后的闭引号。过短的完整句保持独立。
const sentenceEnd = /[。！？!?…]+[”’」』）》】\u0022]*|\.{3,}[”’」』）》】\u0022]*|\.(?=\s|$)/gu;

export function makeNumbered(clean) {
  const chapters = [];
  const paragraphs = [];
  const sentences = [];
  let sentenceChars = 0;
  for (const group of clean.chapters) {
    const chapterId = 'C' + (chapters.length + 1);
    const chapter = { id: chapterId, n: chapters.length + 1, title: group.title, headingLine: group.headingLine, paragraphIds: [], from: null, to: null };
    chapters.push(chapter);
    for (const paragraph of group.paragraphs) {
      const { text, start, end, pieces } = paragraph;
      const paragraphId = 'P' + (paragraphs.length + 1);
      const p = { id: paragraphId, n: paragraphs.length + 1, chapterId, text, start, end, sourceLines: pieces.map(row => row.line), from: null, to: null };
      chapter.paragraphIds.push(paragraphId);
      paragraphs.push(p);
      let cursor = 0;
      let pieceIndex = 0;
      const append = (next) => {
        const span = text.slice(cursor, next);
        const content = span.trim();
        if (content) {
          const absoluteStart = start + cursor + span.length - span.trimStart().length;
          const absoluteEnd = absoluteStart + content.length;
          while (pieces[pieceIndex].end <= absoluteStart) pieceIndex += 1;
          const source = [];
          for (let i = pieceIndex; i < pieces.length && pieces[i].start < absoluteEnd; i += 1) {
            const { line, sourceStart, sourceEnd } = pieces[i];
            source.push({ line, start: sourceStart, end: sourceEnd });
          }
          const n = sentences.length + 1;
          const id = 'S' + n;
          sentences.push({ id, n, chapterId, chapterTitle: chapter.title, paragraphId, text: content, start: absoluteStart, end: absoluteEnd, source });
          sentenceChars += visibleChars(content);
          p.from ??= id;
          p.to = id;
          chapter.from ??= id;
          chapter.to = id;
        }
        cursor = next;
      };
      for (const match of text.matchAll(sentenceEnd)) {
        const after = match.index + match[0].length;
        // “好！”她答道。中，随后的叙述归入同一完整句。
        if (/[”’」』]$/.test(match[0]) && /^[^\s，。！？!?：]{0,5}(?:说|道|问|回答|喊|叫|答道)[，。！？!?:：]/.test(text.slice(after, after + 12))) continue;
        append(after);
      }
      append(text.length);
    }
  }
  const sourceChars = visibleChars(clean.body);
  if (!sentences.length || sourceChars !== sentenceChars) throw Error('编号未覆盖全部清洗正文');
  return {
    schema: 'novel-numbered/v2',
    offsetEncoding: 'utf16',
    chapters, paragraphs, sentences,
    coverage: { sourceChars, sentenceChars, ratio: 1 },
  };
}


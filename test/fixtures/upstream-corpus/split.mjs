/**
 * P0：分章 + 段落编号。
 *
 * 这一层必须由代码完成，不能让模型做：
 *   - 编号是后续所有层的主键（P0001 / S01），模型会改写、跳号、重排；
 *   - 编号一旦不稳定，L1 的段号范围、L3.5 的回填、L4 的逐字校验全部失效。
 *
 * 原文永不修改：这里只产出「编号 → 原文」的映射，不删字、不改字。
 */

const CHAPTER_PATTERNS = [
  /^\s*第[0-9零一二三四五六七八九十百千两〇]{1,8}[章回卷部篇节][^\n]{0,40}$/,
  /^\s*Chapter\s+[0-9IVXLCivxlc]+[^\n]{0,60}$/i,
  /^\s*[0-9]{1,4}[.、]\s*[^\n]{0,40}$/,
];

const MAX_PARAGRAPH_CHARS = 1200;

export function isChapterHeading(line) {
  const text = line.trim();
  if (!text || text.length > 80) return false;
  return CHAPTER_PATTERNS.some((re) => re.test(text));
}

/** 一句一段会毁掉上下文，所以只按空行切；超长段再按句末标点续切。 */
function splitParagraphs(body) {
  const blocks = body
    .replace(/\r\n?/g, '\n')
    .split(/\n\s*\n+/)
    .map((block) => block.replace(/[ \t]+/g, ' ').trim())
    .filter(Boolean);

  const result = [];
  for (const block of blocks) {
    if (block.length <= MAX_PARAGRAPH_CHARS) {
      result.push(block);
      continue;
    }
    let rest = block;
    while (rest.length > MAX_PARAGRAPH_CHARS) {
      const window = rest.slice(0, MAX_PARAGRAPH_CHARS);
      const cut = Math.max(
        window.lastIndexOf('。'),
        window.lastIndexOf('！'),
        window.lastIndexOf('？'),
        window.lastIndexOf('；'),
      );
      if (cut < MAX_PARAGRAPH_CHARS * 0.4) {
        result.push(window);
        rest = rest.slice(MAX_PARAGRAPH_CHARS);
      } else {
        result.push(window.slice(0, cut + 1));
        rest = rest.slice(cut + 1);
      }
    }
    if (rest.trim()) result.push(rest.trim());
  }
  return result;
}

/** 单章内若没有空行分隔，按行切；只有「硬换行」的文本才把短行并回上一段。 */
function fallbackLines(body) {
  const lines = body.split('\n').map((line) => line.trim()).filter(Boolean);
  const lengths = lines.map((line) => line.length).sort((a, b) => a - b);
  const median = lengths[Math.floor(lengths.length / 2)] ?? 0;
  // 中位行长 ≥ 50 说明是「一行一段」，不要合并，否则会把整章粘成几坨。
  if (median >= 50) return lines;

  const merged = [];
  for (const line of lines) {
    const last = merged[merged.length - 1];
    if (last && (last.length < 40 || line.length < 40)) merged[merged.length - 1] = `${last}${line}`;
    else merged.push(line);
  }
  return merged;
}

/**
 * 把章节重切成「分析单元」。
 *
 * 原因：L3 的阶段划分以章节为坐标，一本没有章节标记的书会退化成 1 章，
 * 结构上不可能切出 3–8 个连续阶段。这里按目标字数把长章切开，保证至少有 3 个单元。
 * 单元在数据结构上仍然是 `chapter`，只是标题标成「第 N 节」。
 */
function normalizeUnits(chapters, totalChars) {
  const target = Math.max(1200, Math.min(3000, Math.floor(totalChars / 5)));

  let units = [];
  for (const chapter of chapters) {
    let buffer = [];
    let size = 0;
    const flush = () => {
      if (!buffer.length) return;
      units.push({ title: chapter.title, paragraphs: buffer });
      buffer = [];
      size = 0;
    };
    for (const paragraph of chapter.paragraphs) {
      buffer.push(paragraph);
      size += paragraph.text.length;
      if (size >= target) flush();
    }
    flush();
  }

  // 仍然不足 3 个单元：把最长单元按段对半切，直到够数或无法再切。
  let guard = 0;
  while (units.length < 3 && guard < 20) {
    guard += 1;
    units.sort((a, b) => b.paragraphs.length - a.paragraphs.length);
    const largest = units[0];
    if (!largest || largest.paragraphs.length < 2) break;
    const half = Math.ceil(largest.paragraphs.length / 2);
    units.shift();
    units.push({ title: largest.title, paragraphs: largest.paragraphs.slice(0, half) });
    units.push({ title: largest.title, paragraphs: largest.paragraphs.slice(half) });
  }

  if (units.length < 2) throw new Error('文本太短：切不出足够的分析单元，无法做人物弧划分。');

  const multi = units.length !== chapters.length;
  let counter = 0;
  return units.map((unit, index) => {
    const paragraphs = unit.paragraphs.map((paragraph) => {
      counter += 1;
      return { id: paragraphId(counter), text: paragraph.text };
    });
    return {
      index: index + 1,
      title: multi ? `第${index + 1}节` : unit.title,
      sourceTitle: unit.title,
      from: paragraphs[0].id,
      to: paragraphs[paragraphs.length - 1].id,
      paragraphs,
    };
  });
}

/**
 * 决定这一章怎么切段。
 *
 * 两种常见排版：
 *   A. 一行一段（空行很少，行长中位数 ~90）→ 按行切；
 *   B. 空行分段（空行密度高）→ 按空行切；若是硬换行（行长中位数 < 50）再把短行并回去。
 * 只看「有没有空行」会判错：整本只有一个空行时，按空行切会把九千字当成一段。
 */
function chooseBlocks(body) {
  const rawLines = body.split('\n');
  const nonBlank = rawLines.map((line) => line.trim()).filter(Boolean);
  if (nonBlank.length === 0) return [];

  const lengths = nonBlank.map((line) => line.length).sort((a, b) => a - b);
  const median = lengths[Math.floor(lengths.length / 2)] ?? 0;
  const blankDensity = (rawLines.length - nonBlank.length) / Math.max(1, rawLines.length);
  const linePerParagraph = median >= 50 && blankDensity < 0.15;

  if (linePerParagraph) return nonBlank;
  const blocks = splitParagraphs(body);
  return blocks.length <= 1 ? fallbackLines(body) : blocks;
}

export function splitBook(rawText, options = {}) {
  const text = rawText
    .replace(/^\uFEFF/, '')
    .replace(/\uFFFD/g, '')
    .replace(/\r\n?/g, '\n')
    .replace(/\n{3,}/g, '\n\n');

  const lines = text.split('\n');
  const chapters = [];
  let current = { title: '正文', lines: [] };

  for (const line of lines) {
    if (isChapterHeading(line)) {
      if (current.lines.some((item) => item.trim())) chapters.push(current);
      current = { title: line.trim(), lines: [] };
    } else {
      current.lines.push(line);
    }
  }
  if (current.lines.some((item) => item.trim())) chapters.push(current);

  if (chapters.length === 0) chapters.push({ title: '正文', lines });

  let counter = 0;
  const raw = [];
  for (const chapter of chapters) {
    const body = chapter.lines.join('\n');
    const blocks = chooseBlocks(body);
    if (blocks.length === 0) continue;
    const paragraphs = blocks.map((block) => {
      counter += 1;
      return { id: paragraphId(counter), text: block };
    });
    raw.push({ title: chapter.title, paragraphs });
  }

  if (raw.length === 0) throw new Error('分章失败：没有解析出任何正文段落。');

  const totalChars = raw.reduce((sum, chapter) => sum + chapter.paragraphs.reduce((s, p) => s + p.text.length, 0), 0);
  const outline = raw.length >= 3 ? raw.map((chapter, index) => ({
    index: index + 1,
    title: chapter.title,
    from: chapter.paragraphs[0].id,
    to: chapter.paragraphs[chapter.paragraphs.length - 1].id,
    paragraphs: chapter.paragraphs,
  })) : normalizeUnits(raw, totalChars);

  return {
    title: options.title || '未命名',
    source: options.source || '',
    chapterCount: outline.length,
    paragraphCount: counter,
    autoUnits: outline.length !== raw.length,
    chapters: outline,
  };
}

export function paragraphId(n) {
  return `P${String(n).padStart(4, '0')}`;
}

export function paragraphNumber(id) {
  const match = /^P(\d+)$/.exec(String(id || '').trim());
  return match ? Number(match[1]) : NaN;
}

/** 把段落数组拍平成「编号 + 正文」的全局视图。 */
export function flatten(book) {
  const rows = [];
  for (const chapter of book.chapters) {
    for (const paragraph of chapter.paragraphs) {
      rows.push({ ...paragraph, chapter: chapter.index, chapterTitle: chapter.title });
    }
  }
  return rows;
}

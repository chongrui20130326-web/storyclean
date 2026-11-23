import path from 'node:path';
import { splitBook } from './split.mjs';

/**
 * 语料文件解析。
 *
 * 支持三种输入：
 *  1. novel-corpus（NovelStyle 的标准语料）：canonicalText + chapters/paragraphs 的 UTF-16 区间
 *  2. chatstory-novel-project（导出的工程）：chapters/paragraphs 直接带 text
 *  3. 纯文本 / Markdown（回落到按标题切章）
 *
 * 只要是 JSON，就必须**严格校验**：认不出来就报错，绝不悄悄当成纯文本切，
 * 否则会切出一本内容全是 JSON 字符串的废书，跑完两小时才发现。
 */

export class CorpusFormatError extends Error {
  constructor(message, detail = '') {
    super(message);
    this.name = 'CorpusFormatError';
    this.detail = detail;
  }
}

const ID = (index) => `P${String(index).padStart(4, '0')}`;
const SUPPORTED = 'novel-corpus、chatstory-novel-project、corpus-kit-project';

function build({ title, source, chapters, format }) {
  const cleaned = chapters
    .map((chapter) => ({
      title: chapter.title || '',
      paragraphs: (chapter.paragraphs || []).filter((paragraph) => String(paragraph.text || '').trim()),
    }));

  const totalParagraphs = cleaned.reduce((sum, chapter) => sum + chapter.paragraphs.length, 0);
  const totalChars = cleaned.reduce((sum, chapter) => sum + chapter.paragraphs.reduce((n, p) => n + p.text.trim().length, 0), 0);

  if (!totalParagraphs) throw new CorpusFormatError('文件里没有可用的段落（所有段落都是空的）', `格式：${format}`);
  if (totalChars < 20) throw new CorpusFormatError(`正文只有 ${totalChars} 字，太少，不像是小说正文`, `格式：${format}`);

  let counter = 0;
  const normalized = cleaned.map((chapter, chapterIndex) => ({
    index: chapterIndex + 1,
    title: chapter.title || `第 ${chapterIndex + 1} 章`,
    paragraphs: chapter.paragraphs.map((paragraph) => {
      counter += 1;
      return { id: ID(counter), text: paragraph.text.trim(), sourceId: paragraph.sourceId || null };
    }),
  }));

  return {
    title: title || '未命名',
    source: source || '',
    format,
    chapterCount: normalized.length,
    paragraphCount: counter,
    charCount: totalChars,
    chapters: normalized,
    mapping: normalized.flatMap((chapter) => chapter.paragraphs.map((paragraph) => ({ id: paragraph.id, sourceId: paragraph.sourceId }))),
  };
}

/** novel-corpus：正文统一存在 canonicalText，单位只存区间。 */
function parseNovelCorpus(doc, fallbackTitle) {
  if (typeof doc.canonicalText !== 'string' || !doc.canonicalText.trim()) {
    throw new CorpusFormatError('novel-corpus 缺少 canonicalText（全书正文）');
  }
  if (!Array.isArray(doc.chapters) || !Array.isArray(doc.paragraphs)) {
    throw new CorpusFormatError('novel-corpus 缺少 chapters 或 paragraphs 数组');
  }
  if (!doc.paragraphs.length) throw new CorpusFormatError('novel-corpus 的 paragraphs 是空的');

  const byId = new Map(doc.paragraphs.map((item) => [item.id, item]));
  let unresolved = 0;

  const chapters = doc.chapters.map((chapter, index) => {
    const ids = chapter.paragraphIds || [];
    const paragraphs = ids.map((id) => {
      const paragraph = byId.get(id);
      const start = paragraph?.range?.start;
      const end = paragraph?.range?.end;
      if (!Number.isInteger(start) || !Number.isInteger(end) || end <= start) { unresolved += 1; return null; }
      const text = doc.canonicalText.slice(start, end);
      if (!text.trim()) { unresolved += 1; return null; }
      return { text, sourceId: id };
    }).filter(Boolean);
    return { title: chapter.title || `第 ${index + 1} 章`, paragraphs };
  });

  const declared = doc.chapters.reduce((sum, chapter) => sum + (chapter.paragraphIds || []).length, 0);
  if (declared && unresolved > declared * 0.2) {
    throw new CorpusFormatError(
      `有 ${unresolved}/${declared} 个段落的区间取不出正文，句章区间和 canonicalText 对不上`,
      '可能是 offsetEncoding 不是 utf16，或者正文被改过',
    );
  }

  return build({ title: doc.name || fallbackTitle, source: doc.source?.fileName || '', chapters, format: 'novel-corpus' });
}

/** chatstory-novel-project：段落直接带 text。 */
function parseProject(doc, fallbackTitle) {
  if (!Array.isArray(doc.chapters) || !doc.chapters.length) throw new CorpusFormatError('工程里没有 chapters 数组');
  const paragraphs = Array.isArray(doc.paragraphs) ? doc.paragraphs : [];
  if (!paragraphs.length) throw new CorpusFormatError('工程里没有 paragraphs（章节有内容但段落是空的）');

  const chapters = doc.chapters
    .slice()
    .sort((a, b) => (a.order ?? 0) - (b.order ?? 0))
    .map((chapter, index) => {
      let list = paragraphs.filter((paragraph) => paragraph.chapterId === chapter.id);
      if (!list.length && typeof chapter.content === 'string') list = [{ id: `${chapter.id}-0`, text: chapter.content }];
      return {
        title: chapter.title || `第 ${index + 1} 章`,
        paragraphs: list.map((paragraph) => ({ text: String(paragraph.text || paragraph.content || ''), sourceId: paragraph.id })),
      };
    });

  return build({ title: doc.project?.name || fallbackTitle, source: doc.project?.fileName || '', chapters, format: 'chatstory-novel-project' });
}

/** corpus-kit 自己导出的工程：章/段直接带 text，分析结果挂在 scenes 上。 */
function parseKitProject(doc, fallbackTitle) {
  const chapters = (doc.chapters || []).map((chapter, index) => ({
    title: chapter.title || `第 ${index + 1} 章`,
    paragraphs: (chapter.paragraphs || []).map((paragraph) => ({ text: String(paragraph.text || ''), sourceId: paragraph.sourceId || paragraph.id })),
  }));
  return build({ title: doc.book?.title || fallbackTitle, source: doc.book?.source || '', chapters, format: 'corpus-kit-project' });
}

/** corpus-kit 自己的清洗语料（corpus.json）：章/段/句/场景都在里面。 */
function parseKitCorpus(doc, fallbackTitle) {
  if (!Array.isArray(doc.paragraphs) || !doc.paragraphs.length) throw new CorpusFormatError('corpus-kit-corpus 缺少 paragraphs');
  const byId = new Map(doc.paragraphs.map((paragraph) => [paragraph.id, paragraph]));

  const chapters = (doc.chapters || []).map((chapter, index) => ({
    title: chapter.title || `第 ${index + 1} 章`,
    paragraphs: (chapter.paragraphIds || []).map((id) => {
      const paragraph = byId.get(id);
      return paragraph ? { text: String(paragraph.text || ''), sourceId: paragraph.sourceId || id } : null;
    }).filter(Boolean),
  }));

  const book = build({ title: doc.book?.title || fallbackTitle, source: doc.book?.source || '', chapters, format: 'corpus-kit-corpus' });

  // 清洗时已经切好的场景，导入时一并带进来，省掉 P2。
  const scenes = (doc.scenes || []).map((scene, index) => ({
    sceneId: scene.sceneId || `S${String(index + 1).padStart(2, '0')}`,
    序号: index + 1,
    章: 0,
    跨章: scene.跨章,
    从: scene.从,
    到: scene.到,
    段落数: scene.paragraphIds?.length || 0,
    是否含情色: scene.是否含情色 !== false,
    参与者: [],
    场所: '',
    摘要: scene.摘要 || '',
  }));
  if (scenes.length) Object.defineProperty(book, 'scenes', { value: scenes, enumerable: false });
  return book;
}

export function parseCorpusFile(raw, fileName = 'book') {
  const fallbackTitle = path.basename(fileName, path.extname(fileName));
  const head = String(raw || '').trimStart();

  // 只有明确不是 JSON 的才走纯文本切分。
  if (!head.startsWith('{') && !head.startsWith('[')) {
    return splitBook(raw, { title: fallbackTitle, source: fileName });
  }

  let doc;
  try {
    doc = JSON.parse(raw);
  } catch (error) {
    throw new CorpusFormatError(`JSON 解析失败：${error.message}`, '文件可能被截断，或者不是 UTF-8');
  }

  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) {
    throw new CorpusFormatError('JSON 顶层必须是对象', `实际是：${Array.isArray(doc) ? '数组' : typeof doc}`);
  }

  if (doc.format === 'novel-corpus') return parseNovelCorpus(doc, fallbackTitle);
  if (doc.format === 'chatstory-novel-project') return parseProject(doc, fallbackTitle);
  if (doc.format === 'corpus-kit-project') return parseKitProject(doc, fallbackTitle);
  if (doc.format === 'corpus-kit-corpus') return parseKitCorpus(doc, fallbackTitle);

  // 没写 format 但结构像工程，也接受。
  if (Array.isArray(doc.chapters) && Array.isArray(doc.paragraphs)) return parseProject(doc, fallbackTitle);

  const seen = doc.format ? `format = "${doc.format}"` : '没有 format 字段';
  throw new CorpusFormatError(
    `认不出这个 JSON 的结构（${seen}），无法用来做小说分析`,
    `支持：${SUPPORTED}。如果这是别的软件的工程文件，请导出成其中一种，或直接给 .txt`,  );
}

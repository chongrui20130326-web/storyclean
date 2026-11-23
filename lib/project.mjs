import { createHash } from 'node:crypto';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { defaultEdits, makeClean, makeNumbered } from './text.mjs';
import { decodeNovel } from './vendor/encoding.mjs';
import { makeCharacters, makeMentions, makeScenes } from './tables.mjs';

export const FORMAT = 'novel-cleaning-project';
export const VERSION = 1;
export const sha256 = (value) => createHash('sha256').update(value).digest('hex');
export const stamp = () => new Date().toISOString();
export function bookBasis(project) {
  const { title, titleLine, headings, removed, merges } = project.clean.edits;
  return sha256(JSON.stringify([project.source.sha256, title, titleLine, headings.map(({ line, title }) => [line, title]),
    removed.map(({ line, reason }) => [line, reason]), merges]));
}

function fileName(name) {
  return path.win32.basename(String(name || '未命名.txt')).trim().slice(0, 250) || '未命名.txt';
}

function sourceOf(bytes, name) {
  const { text, encoding, bom, notes } = decodeNovel(bytes);
  return { file: fileName(name), encoding, bom, notes, sha256: sha256(bytes), base64: bytes.toString('base64'), text };
}

function newProject(source, edits) {
  return {
    format: FORMAT, version: VERSION, createdAt: stamp(), source,
    clean: makeClean(source.text, edits), cleanReviews: [], numbered: null,
    scenes: null, characters: null, mentions: null,
  };
}

export function fromTxt(bytes, name) {
  const source = sourceOf(bytes, name);
  const fallback = path.parse(source.file).name || '未命名';
  return newProject(source, defaultEdits(source.text, fallback));
}

export function saveCleaning(project, edits) {
  const clean = makeClean(project.source.text, edits);
  if (isDeepStrictEqual(clean.edits, project.clean.edits)) return false;
  Object.assign(project, { clean, numbered: null, scenes: null, characters: null, mentions: null,
    cleanReviews: project.cleanReviews.filter(row => appliedReview(clean, row)) });
  return true;
}

export function saveNumbering(project) {
  project.numbered = makeNumbered(project.clean);
  return project.numbered;
}

export function compatibleCorpus(project) {
  const indexed = project.numbered ?? makeNumbered(project.clean);
  return {
    format: 'novel-corpus', version: 1, name: project.clean.title, offsetEncoding: 'utf16',
    canonicalText: project.clean.body, source: { fileName: project.source.file, sha256: project.source.sha256 },
    chapters: indexed.chapters.map(({ id, title, paragraphIds }) => ({ id, title, paragraphIds })),
    paragraphs: indexed.paragraphs.map(({ id, start, end }) => ({ id, range: { start, end } })),
  };
}

const LEGACY = new Set(['corpus-kit-project', 'corpus-kit-corpus', 'novel-corpus', 'chatstory-novel-project']);
const singleLine = (value) => typeof value === 'string' ? value.replace(/\s+/g, ' ').trim().slice(0, 250) : '';

function parseJson(text) {
  try {
    return JSON.parse(text.trimStart());
  } catch {
    throw Error('工程文件不是完整的 JSON');
  }
}

function fromLegacy(bytes, name, doc) {
  const source = sourceOf(bytes, name);
  const title = singleLine(doc.book?.title || doc.project?.name || doc.name) || path.parse(source.file).name;
  if (!Array.isArray(doc.chapters) || !doc.chapters.length) throw Error('旧工程缺少章节');
  const paragraphs = Array.isArray(doc.paragraphs) ? doc.paragraphs : [];
  const byId = new Map(paragraphs.map(p => [p.id, p]));
  if (['novel-corpus', 'corpus-kit-corpus'].includes(doc.format) &&
    (byId.size !== paragraphs.length || paragraphs.some(p => typeof p.id !== 'string' || !p.id))) {
    throw Error('旧语料的段落编号缺失或重复');
  }
  const chatByChapter = new Map();
  if (doc.format === 'chatstory-novel-project') {
    const chapterIds = new Set(doc.chapters.map(chapter => chapter.id));
    if (chapterIds.size !== doc.chapters.length || paragraphs.some(p => !chapterIds.has(p.chapterId))) {
      throw Error('旧工程的章段引用不一致');
    }
    for (const p of paragraphs) {
      if (!chatByChapter.has(p.chapterId)) chatByChapter.set(p.chapterId, []);
      chatByChapter.get(p.chapterId).push(p);
    }
  }
  const chapters = doc.format === 'chatstory-novel-project'
    ? [...doc.chapters].sort((a, b) => (a.order ?? 0) - (b.order ?? 0))
    : doc.chapters;
  const lines = [];
  const index = [];
  const headings = [];
  const usedIds = new Set();
  let nextLine = 1;
  let previousEnd = 0;
  for (const chapter of chapters) {
    const heading = singleLine(chapter.title) || '第' + (headings.length + 1) + '章';
    headings.push({ line: nextLine++, title: heading });
    lines.push(heading);
    let rows;
    if (doc.format === 'corpus-kit-project') rows = chapter.paragraphs;
    else if (doc.format === 'chatstory-novel-project') {
      rows = chatByChapter.get(chapter.id) || (typeof chapter.content === 'string' ? [{ text: chapter.content }] : []);
    } else {
      if (!Array.isArray(chapter.paragraphIds)) throw Error('旧工程缺少章节的段落引用');
      rows = chapter.paragraphIds.map(id => {
        if (!byId.has(id)) throw Error('旧工程的段落引用不存在：' + id);
        return byId.get(id);
      });
    }
    if (!Array.isArray(rows)) throw Error('旧工程缺少段落列表');
    for (const p of rows) {
      if (p.id != null && usedIds.has(p.id)) throw Error('旧工程的段落编号或引用重复');
      if (p.id != null) usedIds.add(p.id);
      let text = p.text ?? p.content;
      if (doc.format === 'novel-corpus') {
        const { start, end } = p.range || {};
        if (typeof doc.canonicalText !== 'string' || !Number.isInteger(start) || !Number.isInteger(end)
          || start < 0 || end <= start || end > doc.canonicalText.length) throw Error('旧工程的正文区间无效');
        if (start < previousEnd) throw Error('旧工程的正文区间重叠或顺序错误');
        previousEnd = end;
        text = doc.canonicalText.slice(start, end);
      }
      if (typeof text !== 'string') throw Error('旧工程的段落缺少原文');
      if (!text.trim()) continue;
      const normalized = text.replace(/\r\n?/g, '\n');
      const lineCount = normalized.split('\n').length;
      index.push({ id: String(p.sourceId || p.id || ''), fromLine: nextLine, toLine: nextLine + lineCount - 1 });
      nextLine += lineCount;
      lines.push(normalized);
    }
  }
  if (['novel-corpus', 'corpus-kit-corpus'].includes(doc.format) && usedIds.size !== paragraphs.length) {
    throw Error('旧工程有未归入章节的段落');
  }
  source.origin = { format: doc.format, version: doc.version ?? null, paragraphs: index };
  source.text = lines.join('\n');
  return newProject(source, { title, titleLine: null, headings, merges: [], removed: [] });
}

export function importProject(bytes, name) {
  let text;
  try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
  catch { text = decodeNovel(bytes).text; }
  // NUL in a successfully decoded UTF-8 string can indicate UTF-16 without a BOM.
  if (text.includes('\u0000')) text = decodeNovel(bytes).text;
  const doc = parseJson(text);
  if (doc?.format === FORMAT) return validateProject(doc);
  if (LEGACY.has(doc?.format)) return fromLegacy(bytes, name, doc);
  throw Error('工程格式不受支持');
}

function validateSource(source) {
  if (!source || typeof source.base64 !== 'string' || typeof source.file !== 'string') throw Error('工程缺少原稿');
  const bytes = Buffer.from(source.base64, 'base64');
  if (!bytes.length || bytes.toString('base64') !== source.base64 || sha256(bytes) !== source.sha256) {
    throw Error('源文件 SHA-256 或字节记录不一致');
  }
  let expected;
  if (source.origin) {
    const old = parseJson(decodeNovel(bytes).text);
    if (!LEGACY.has(old?.format)) throw Error('旧工程来源格式无效');
    expected = fromLegacy(bytes, source.file, old).source;
  } else {
    expected = sourceOf(bytes, source.file);
  }
  if (!isDeepStrictEqual(source, expected)) throw Error('原稿编码或解码文本与源字节不一致');
}

export function validateProject(project) {
  if (project?.format !== FORMAT || project.version !== VERSION) throw Error('初始书籍工程格式或版本无效');
  if (typeof project.createdAt !== 'string' || !Number.isFinite(Date.parse(project.createdAt))) throw Error('工程创建时间无效');
  validateSource(project.source);
  const clean = makeClean(project.source.text, project.clean?.edits);
  if (!isDeepStrictEqual(project.clean, clean)) throw Error('清洗正文或审计记录不一致');
  if (!Array.isArray(project.cleanReviews) || project.cleanReviews.some(row => !row || Object.keys(row).length !== 5
    || !reviewKind(row.stage, row.kind) || !validProvenance(row.provenance) || !appliedReview(clean, row))
    || new Set(project.cleanReviews.map(row => row.line)).size !== project.cleanReviews.length) {
    throw Error('清洗建议来源或原文行引用不一致');
  }
  if (project.numbered !== null && !isDeepStrictEqual(project.numbered, makeNumbered(clean))) {
    throw Error('章段句编号、引用或正文区间不一致');
  }
  validateAnalysis(project);
  const fields = ['format', 'version', 'createdAt', 'source', 'clean', 'cleanReviews', 'numbered', 'scenes', 'characters', 'mentions'];
  return Object.fromEntries(fields.map(key => [key, project[key]]));
}

const reviewKind = (stage, kind) => (stage === 'structure' && ['title', 'heading', 'body'].includes(kind))
  || (stage === 'body' && ['remove', 'merge'].includes(kind));

function appliedReview(clean, { line, kind, text }) {
  if (!Number.isInteger(line) || line <= 0 || line > clean.lineCount || typeof text !== 'string' || !text.trim() || text.length > 250) return false;
  const { edits } = clean;
  if (kind === 'title') return edits.titleLine === line && edits.title === text;
  if (kind === 'heading') return edits.headings.some(row => row.line === line && row.title === text);
  if (kind === 'remove') return edits.removed.some(row => row.line === line && row.reason === text);
  if (kind === 'merge') return edits.merges.includes(line) && text === '并入上一正文行';
  return text === '恢复为正文' && clean.chapters.some(chapter => chapter.paragraphs.some(p => p.pieces.some(piece => piece.line === line)));
}

export function saveReviewSources(project, suggestions, adoptionList, priorBasis) {
  if (adoptionList == null) return false;
  if (!Array.isArray(adoptionList) || adoptionList.length > project.clean.lineCount) throw Error('采用建议的清单无效');
  const byLine = new Map(project.cleanReviews.map(row => [row.line, row]));
  for (const input of adoptionList) {
    const { stage, line, kind } = input;
    const suggestion = suggestions?.[stage];
    if (!reviewKind(stage, kind) || suggestion?.basis !== priorBasis) throw Error('清洗建议已过期，请重新运行复核');
    const row = suggestion.rows.find(item => item.line === line && item.kind === kind);
    if (!row) throw Error('找不到指定的原文行建议');
    if (appliedReview(project.clean, row)) byLine.set(line, { ...row, stage, provenance: suggestion.provenance });
  }
  const reviews = [...byLine.values()].sort((a, b) => a.line - b.line);
  if (isDeepStrictEqual(project.cleanReviews, reviews)) return false;
  project.cleanReviews = reviews;
  return true;
}

function validProvenance(p) {
  return p && typeof p.model === 'string' && Boolean(p.model) && p.model.length <= 250
    && typeof p.promptHash === 'string' && /^[0-9a-f]{64}$/.test(p.promptHash)
    && Number.isInteger(p.promptVersion) && p.promptVersion >= 1
    && typeof p.at === 'string' && Number.isFinite(Date.parse(p.at)) && Object.keys(p).length === 4;
}

function validateAnalysis(project) {
  const { scenes, characters, mentions } = project;
  const sentences = project.numbered?.sentences;
  const basis = bookBasis(project);
  for (const record of [scenes, characters]) {
    if (record === null) continue;
    const p = record?.provenance;
    if (!sentences || record?.basis !== basis || !validProvenance(p)
      || Object.keys(record).length !== (record === scenes ? 4 : 3)) {
      throw Error('模型产物来源或正文版本不一致');
    }
  }
  if (scenes && !isDeepStrictEqual(scenes.rows, makeScenes(sentences, scenes.cuts))) throw Error('场景覆盖或句子范围不一致');
  if (characters && (!Array.isArray(characters.rows) || !isDeepStrictEqual(characters.rows, makeCharacters(sentences, characters.rows)))) {
    throw Error('角色编号、别名或原文证据不一致');
  }
  if (mentions !== null && (!scenes || !characters || !isDeepStrictEqual(mentions,
    { basis, method: 'lexicon/v1', rows: makeMentions(sentences, scenes.rows, characters.rows) }))) {
    throw Error('人称编号、原文位置、角色或场景引用不一致');
  }
}


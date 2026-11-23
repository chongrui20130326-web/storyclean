import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { HttpError } from '../lib/storage.mjs';
import { writeJsonAtomic } from './core/atomic-json.mjs';
import { decodeNovel } from './tools/clean-number/clean-core/encoding.mjs';
import { MIN_SCENE_SENTENCES, ROLLING_SCENE_STRATEGY } from './analysis/scene-boundaries.mjs';
import { readSceneRoles } from './analysis/scene-roles.mjs';
import { SCENE_ROLE_STRATEGY, validateSceneRoleLayer } from './analysis/scene-role-evidence.mjs';
import { mappingFile, readMentionMapping, validateMentionMapping } from './analysis/mention-mappings.mjs';

export const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
export const FORMAT = 'novel-cleaning-project';
export const VERSION = 2;
export const projectCap = 512 * 1024 * 1024;
export const readJson = (file, fallback = null) => {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return fallback; throw error; }
};

export function fileName(value) {
  const name = path.win32.basename(String(value || '未命名.txt')).trim();
  if (!name || name.length > 230 || /[\x00-\x1f]/.test(name)) throw Error('小说文件名无效');
  return name;
}

export function bookId(value) {
  const name = String(value ?? '').replace(/[\\/:*?"<>|\x00-\x1f]/g, '_').trim();
  if (!name || name.length > 190 || /^\.+$/.test(name) || /\.$/.test(name)
    || /^(?:con|aux|nul|prn|com[0-9]|lpt[0-9])(?:\.|$)/i.test(name)) throw Error('书名不合法');
  return name;
}

const isToken = value => typeof value === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(value);

export function readSource(input) {
  const file = fileName(input.name);
  if (typeof input.content !== 'string') throw Error('没有收到正文');
  let buffer;
  if (typeof input.bytesBase64 === 'string') {
    buffer = Buffer.from(input.bytesBase64, 'base64');
    if (buffer.toString('base64') !== input.bytesBase64) throw Error('原稿字节编码不正确');
  } else {
    buffer = Buffer.from(input.content, 'utf8');
  }
  if (!buffer.length || buffer.length > 20 * 1024 * 1024) throw Error('原稿为空或超过 20 MiB');
  const decoded = decodeNovel(buffer);
  if (decoded.text !== input.content) throw Error('提交文本与原稿字节不一致');
  return { file, encoding: decoded.encoding, bom: decoded.bom, sha256: sha256(buffer), base64: buffer.toString('base64'), text: decoded.text };
}

export const nestedSentences = book => (book.chapters || []).flatMap(chapter => chapter.paragraphs.flatMap(paragraph => paragraph.sentences));
export const sentenceNumber = row => Number(String(row.sid ?? row.id).match(/S(\d+)$/)?.[1]);

const stageFiles = {
  pronouns: 'number-mentions.json',
  scenes: 'l2/scenes-llm.json',
  sceneRoles: 'l2/scene-roles.json',
  characters: 'l2/characters.json',
  mentions: 'l2/mention-table.json',
  relations: 'l2/relations.json',
};

export function readProject(work) {
  const initial = readJson(path.join(work, 'initial.json'));
  const book = readJson(path.join(work, 'book.json'));
  if (!initial || !book) throw new HttpError(404, '找不到这本书');
  const layers = Object.fromEntries(Object.entries(stageFiles).map(([stage, file]) => [stage, readJson(path.join(work, file))]));
  const sceneRoles = readSceneRoles(work);
  const current = layers.scenes?.scenes;
  const matches = !current || sceneRoles?.scenes.every((scene, index) => scene.from === current[index]?.from
    && scene.to === current[index]?.to && scene.sceneId === current[index]?.sceneId);
  layers.sceneRoles = matches && (!sceneRoles?.complete || current?.length === sceneRoles.scenes.length) ? sceneRoles : null;
  if (layers.characters?.strategy === SCENE_ROLE_STRATEGY && !layers.sceneRoles?.rosterReady) {
    layers.characters = layers.relations = layers.mentions = null;
  }
  if (!layers.mentions?.method) layers.mentions = null;
  const { document } = readMentionMapping(work, layers);
  return { format: FORMAT, version: VERSION, ...initial, book, ...layers, ...(document && { mentionMapping: document }) };
}

function validateSource(source) {
  if (!source || typeof source.base64 !== 'string' || typeof source.text !== 'string') throw Error('缺少原稿或原稿字节');
  const expected = readSource({ name: source.file, content: source.text, bytesBase64: source.base64 });
  if (expected.sha256 !== source.sha256 || expected.encoding !== source.encoding || expected.bom !== source.bom) {
    throw Error('原稿 SHA-256 或编码记录不一致');
  }
  return expected;
}

function alignSentenceOffsets(text, sentences) {
  const blank = /\s/;
  let cursor = 0;
  const skip = () => { while (cursor < text.length && blank.test(text[cursor])) cursor += 1; };
  const rows = sentences.map(row => {
    skip();
    const start = cursor;
    for (let i = 0; i < row.text.length; i += 1) {
      if (blank.test(row.text[i])) continue;
      skip();
      if (text[cursor] !== row.text[i]) throw Error('编号后文字与待编号原文不一致：' + row.id);
      cursor += 1;
    }
    return { id: row.id, start, end: cursor };
  });
  skip();
  if (cursor !== text.length) throw Error('编号没有覆盖待编号原文');
  return { encoding: 'utf16', text: 'numbering-input', sentences: rows };
}

export function validateProject(doc) {
  if (doc?.format !== FORMAT || doc.version !== VERSION || !Array.isArray(doc.numbered?.sentences)
    || !Array.isArray(doc.book?.chapters) || !Array.isArray(doc.book?.frontMatter)) throw Error('初始工程格式不正确');
  const source = validateSource(doc.source);
  const { book, numbered, scenes, sceneRoles, characters, mentions, relations, pronouns, mentionMapping } = doc;
  if (doc.clean != null) {
    const clean = doc.clean.cleanDoc;
    if (typeof clean?.['书名'] !== 'string' || typeof clean?.['正文'] !== 'string' || !Array.isArray(clean['目录'])) throw Error('清洗结果格式不正确');
  }
  const offsets = alignSentenceOffsets(doc.clean?.cleanDoc['正文'] ?? source.text, numbered.sentences);
  if (doc.offsets && (doc.offsets.encoding !== offsets.encoding || doc.offsets.text !== offsets.text
    || !Array.isArray(doc.offsets.sentences) || doc.offsets.sentences.length !== offsets.sentences.length
    || offsets.sentences.some((row, index) => {
      const other = doc.offsets.sentences[index];
      return row.id !== other?.id || row.start !== other.start || row.end !== other.end;
    }))) throw Error('编号区间与待编号原文不一致');
  const indexed = [...book.frontMatter, ...nestedSentences(book)];
  const number = /^S[1-9]\d*$/;
  if (indexed.length !== numbered.sentences.length || indexed.some((row, index) => {
    const source = numbered.sentences[index];
    return !number.test(source.id) || source.id !== 'S' + (index + 1) || sentenceNumber(row) !== index + 1 || row.text !== source.text;
  })) throw Error('编号与书籍正文存在遗漏、重复或次序不一致');
  const lines = nestedSentences(book);
  const lineById = new Map(lines.map(row => [sentenceNumber(row), row]));
  const sceneByLine = new Map();
  if (scenes) {
    if (!Array.isArray(scenes.scenes)) throw Error('场景表格式不正确');
    const rolling = scenes.strategy === ROLLING_SCENE_STRATEGY;
    if (rolling && lines.length < MIN_SCENE_SENTENCES && scenes.scenes.length !== 1) throw Error('不足 20 句的全文须保留为一场');
    let covered = 0;
    for (const [position, scene] of scenes.scenes.entries()) {
      const from = Number(String(scene.from).slice(1));
      const to = Number(String(scene.to).slice(1));
      const index = Number(scene.sceneId?.slice(2));
      if (!Number.isSafeInteger(to) || to < from || !lineById.has(to) || from !== sentenceNumber(lines[covered] || {})
        || !number.test(scene.from) || !number.test(scene.to) || scene.sceneId !== 'SC' + String(index).padStart(3, '0')
        || index !== position + 1) throw Error('场景编号或句子范围不正确');
      let chars = 0;
      for (let n = from; n <= to; n += 1) {
        const row = lineById.get(n);
        if (!row || sceneByLine.has(n)) throw Error('场景覆盖存在遗漏或重复');
        sceneByLine.set(n, scene.sceneId);
        chars += row.text.length;
        covered += 1;
      }
      if ((!rolling && chars > 5000) || chars !== scene.chars || to - from + 1 !== scene.sentences) {
        throw Error('场景字数或句数不一致');
      }
      if (rolling && lines.length >= MIN_SCENE_SENTENCES && scene.sentences < MIN_SCENE_SENTENCES) throw Error('场景不足 20 句');
    }
    if (covered !== lines.length) throw Error('场景没有覆盖书籍的全部章节句子');
  }
  if (characters && !Array.isArray(characters.characters)) throw Error('角色表格式不正确');
  const names = new Map();
  for (const row of characters?.characters ?? []) {
    if (!/^CH\d+$/.test(row.id) || !row.name || !Array.isArray(row.aliases) || names.has(row.id)) throw Error('角色编号不正确或重复');
    names.set(row.id, new Set([row.name, ...row.aliases]));
  }
  if (sceneRoles) {
    if (sceneRoles.sourceHash !== sha256(JSON.stringify(book))) throw Error('逐场角色与当前书籍编号不一致');
    validateSceneRoleLayer(sceneRoles, lineById, scenes?.scenes, characters);
  }
  if (mentions) {
    if (!characters || !Array.isArray(mentions.mentions)) throw Error('场景人称表格式不正确');
    const seen = new Set();
    for (const m of mentions.mentions) {
      const row = lineById.get(m.sentence);
      if (!row || typeof m.surface !== 'string' || !m.surface || !/^M\d+$/.test(m.id) || seen.has(m.id)
        || !Number.isInteger(m.start) || !Number.isInteger(m.end) || m.start < 0
        || row.text.slice(m.start, m.end) !== m.surface || m.end !== m.start + m.surface.length
        || (m.characterId && !names.get(m.characterId)?.has(m.surface)) || (m.sceneId || '') !== (sceneByLine.get(m.sentence) || '')) {
        throw Error('场景人称编号、位置或角色引用不一致');
      }
      seen.add(m.id);
    }
  }
  if (relations && !Array.isArray(relations.relations)) throw Error('角色关系表格式不正确');
  if (mentionMapping != null) validateMentionMapping(mentionMapping, { scenes, characters, mentions, sceneRoles }, lineById, sha256(JSON.stringify(book)));
  if (pronouns && !Array.isArray(pronouns.mentions)) throw Error('全文代词表格式不正确');
  return { format: FORMAT, version: VERSION, source, clean: doc.clean ?? null, numbered, offsets, book,
    pronouns: pronouns ?? null, scenes: scenes ?? null, sceneRoles: sceneRoles ?? null,
    characters: characters ?? null, mentions: mentions ?? null, relations: relations ?? null, ...(mentionMapping && { mentionMapping }) };
}

export function createLibrary(root) {
  root = path.resolve(root);
  const shelf = path.join(root, 'books');
  const drafts = path.join(root, 'drafts');
  fs.mkdirSync(shelf, { recursive: true });
  fs.mkdirSync(drafts, { recursive: true });
  const seat = id => path.join(shelf, sha256(id.toLowerCase()));
  const current = id => path.join(seat(id), 'current.json');
  const location = value => {
    const id = String(value || '');
    if (!id) throw new HttpError(404, '找不到这本书');
    const record = readJson(current(id));
    if (!record || !isToken(record.version)) throw new HttpError(404, '找不到这本书');
    return { ...record, work: path.join(seat(id), record.version) };
  };
  return {
    root,
    list() {
      return fs.readdirSync(shelf, { withFileTypes: true }).filter(entry => entry.isDirectory())
        .map(entry => readJson(path.join(shelf, entry.name, 'current.json'))).filter(Boolean)
        .sort((a, b) => b.at.localeCompare(a.at)).map(({ id, title, at }) => ({ id, title, at }));
    },
    location,
    get(value) {
      const record = location(value);
      return { ...record, book: readJson(path.join(record.work, 'book.json')) };
    },
    draft(token = null) {
      if (token !== null && !isToken(token)) throw new HttpError(404, '找不到清洗或编号记录');
      return { token: token || randomUUID(), get dir() { return path.join(drafts, this.token); } };
    },
    publish(id, project) {
      const version = randomUUID();
      const work = path.join(seat(id), version);
      const { book, source, numbered, clean, offsets } = project;
      const record = { id, title: book.title || id, version, at: new Date().toISOString() };
      fs.mkdirSync(path.join(work, 'l2'), { recursive: true });
      writeJsonAtomic(path.join(work, 'initial.json'), { source, numbered, clean, offsets }, 0);
      writeJsonAtomic(path.join(work, 'book.json'), book, 0);
      for (const [stage, file] of Object.entries(stageFiles)) if (project[stage]) {
        writeJsonAtomic(path.join(work, file), project[stage], 0);
      }
      if (project.mentionMapping) writeJsonAtomic(path.join(work, 'l2', mappingFile), project.mentionMapping, 0);
      if (project.pronouns && !project.mentions) writeJsonAtomic(path.join(work, 'l2', 'mention-table.json'), project.pronouns, 0);
      writeJsonAtomic(current(id), record, 0);
      return { ...record, work, book };
    },
    importProject(doc) {
      const checked = validateProject(doc);
      const title = bookId(checked.book.title || checked.source.file);
      const full = this.list();
      let id = title;
      for (let n = 2; full.some(row => row.id.toLowerCase() === id.toLowerCase()); n += 1) id = title.slice(0, 178) + '（' + n + '）';
      return this.publish(id, checked);
    },
  };
}


import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';

export const sha256 = value => createHash('sha256').update(value).digest('hex');

export function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT' && fallback !== undefined) return fallback;
    throw error;
  }
}

export function loadBook(work) {
  const source = fs.readFileSync(path.join(work, 'book.json'));
  const book = JSON.parse(source);
  if (!Array.isArray(book.chapters) || !book.chapters.length) throw Error('请先保存内容编号');
  return { book, sourceHash: sha256(source), l2: path.join(work, 'l2') };
}

export function sentenceRows(book) {
  const rows = [];
  for (const chapter of book.chapters) {
    for (const paragraph of chapter.paragraphs || []) {
      for (const sentence of paragraph.sentences || []) {
        const match = /S([1-9]\d*)$/.exec(String(sentence.sid || sentence.id || ''));
        const n = match ? Number(match[1]) : NaN;
        if (!Number.isSafeInteger(n) || (rows.length && n !== rows.at(-1).n + 1)) {
          throw Error('原文句号无效或不连续，请先检查内容编号');
        }
        if (typeof sentence.text !== 'string' || !sentence.text) throw Error('原文句子正文无效：S' + n);
        rows.push({ n, text: sentence.text, chapterId: chapter.id, chapterTitle: chapter.title || chapter.id });
      }
    }
  }
  if (!rows.length) throw Error('请先保存包含正文句子的内容编号');
  return rows;
}

export function writeJsonLines(file, rows) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = file + '.' + randomUUID() + '.tmp';
  try {
    fs.writeFileSync(temporary, rows.map(row => JSON.stringify(row) + '\n').join(''), { flag: 'wx', mode: 0o600 });
    fs.renameSync(temporary, file);
  } finally {
    fs.rmSync(temporary, { force: true });
  }
}

export function archiveFiles(files) {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-') + '-' + randomUUID().slice(0, 8);
  const existing = files.filter(file => fs.existsSync(file));
  for (const file of existing) fs.copyFileSync(file, file + '.bak-' + stamp, fs.constants.COPYFILE_EXCL);
  for (const file of existing) fs.rmSync(file);
}

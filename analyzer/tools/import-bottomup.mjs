import { writeJsonAtomic } from '../core/atomic-json.mjs';
import fs from 'node:fs';
import path from 'node:path';

/**
 * 把自底向上编号结果（章/段/句 + 区间）转成 corpus-kit 的 book.json。
 * 段落 id 用 C1P1，句子 id 用 C1P1S1，同时保留原始 S 号便于回溯。
 */

const src = process.argv[2];
const work = process.argv[3] || 'work/numbered';
if (!src) { console.error('用法：node tools/import-bottomup.mjs <编号json> [work目录]'); process.exit(1); }

const doc = JSON.parse(fs.readFileSync(src, 'utf8'));
const sentences = doc.sentences || [];
const byId = new Map(sentences.map((s) => [s.id, s]));

// 段落 → 句子列表
const paraSentences = new Map();
for (const para of doc.paragraphs || []) {
  const from = Number(String(para.from).slice(1));
  const to = Number(String(para.to).slice(1));
  paraSentences.set(para.id, sentences.slice(from - 1, to));
}

// 章节 → 段落列表（按句号区间反查）
const chapters = [];
for (const chapter of doc.chapters || []) {
  const from = Number(String(chapter.from).slice(1));
  const to = Number(String(chapter.to).slice(1));
  const paras = (doc.paragraphs || []).filter((p) => {
    const pFrom = Number(String(p.from).slice(1));
    const pTo = Number(String(p.to).slice(1));
    return pTo >= from && pFrom <= to;
  });

  const paragraphs = paras.map((para, pi) => {
    const list = (paraSentences.get(para.id) || []).filter((s) => {
      const n = Number(String(s.id).slice(1));
      return n >= from && n <= to;
    });
    const pid = `${chapter.id}P${pi + 1}`;
    return {
      id: pid,
      text: list.map((s) => s.text).join(''),
      sentences: list.map((s, si) => ({ id: `${pid}S${si + 1}`, text: s.text, sid: s.id })),
    };
  });

  chapters.push({
    id: chapter.id,
    title: chapter.title || chapter.id,
    from: chapter.from,
    to: chapter.to,
    paragraphs,
  });
}

const paragraphCount = chapters.reduce((sum, c) => sum + c.paragraphs.length, 0);
const sentenceCount = chapters.reduce((sum, c) => sum + c.paragraphs.reduce((n, p) => n + p.sentences.length, 0), 0);


// 全文人称代词编号：M000001 起，句子 ↔ 代词双向可查
function numberMentions(book) {
  const PRONOUNS = ['我们', '你们', '他们', '她们', '它们', '咱们', '大家', '自己', '人家', '彼此',
    '我', '你', '他', '她', '它', '咱', '其'];
  const sortByLen = [...PRONOUNS].sort((a, b) => b.length - a.length);
  const category = (w) => {
    if (/^我们|咱|咱们|大家|咱$/.test(w)) return '第一人称';
    if (/^你们|^你$/.test(w)) return '第二人称';
    if (/^他/.test(w)) return '第三人称男';
    if (/^她/.test(w)) return '第三人称女';
    if (/^它/.test(w)) return '非人';
    return '其他';
  };

  const mentions = [];
  const bySentence = new Map();
  let seq = 0;
  let sentenceNo = 0;

  for (const chapter of book.chapters || []) {
    for (const para of chapter.paragraphs || []) {
      for (const sentence of para.sentences || []) {
        sentenceNo += 1;
        sentence.sentenceNo = sentenceNo;
        const text = String(sentence.text || '');
        const ids = [];
        let i = 0;
        while (i < text.length) {
          let hit = '';
          for (const w of sortByLen) {
            if (text.startsWith(w, i)) { hit = w; break; }
          }
          if (!hit) { i += 1; continue; }
          seq += 1;
          const id = 'M' + String(seq).padStart(6, '0');
          mentions.push({
            id,
            sentence: sentenceNo,
            sentenceId: sentence.id || '',
            chapterId: chapter.id || '',
            text: hit,
            category: category(hit),
            offset: i,
          });
          ids.push(id);
          i += hit.length;
        }
        sentence.mentions = ids;
        if (ids.length) bySentence.set(sentence.id || String(sentence.sentenceNo), ids);
      }
    }
  }
  return { mentions, total: mentions.length };
}

const book = {
  format: 'novel-corpus',
  schema: 'corpus-kit/v2',
  title: doc.source?.file ? doc.source.file.replace(/\.(txt|md)$/i, '') : path.basename(src),
  numbering: doc.numbering || null,
  warnings: doc.warnings || [],
  chapterCount: chapters.length,
  paragraphCount,
  sentenceCount,
  chapters,
  frontMatter: chapters.length ? sentences.filter((s) => Number(String(s.id).slice(1)) < Number(String(chapters[0].from).slice(1))) : sentences,
};

fs.mkdirSync(work, { recursive: true });
// 书籍工程创建时一并建立 l2，后续步骤不再依赖兜底
fs.mkdirSync(path.join(work, 'l2'), { recursive: true });
const mentionResult = numberMentions(book);
book.mentionCount = mentionResult.total;
writeJsonAtomic(path.join(work, 'book.json'), book, 2);
writeJsonAtomic(path.join(work, 'l2', 'mention-table.json'), {
  total: mentionResult.total,
  mentions: mentionResult.mentions,
}, 2);
console.log('人称代词 ' + mentionResult.total + ' 条（M000001 起）');
console.log(`已写入 ${path.join(work, 'book.json')}`);
console.log(`章 ${chapters.length} · 段 ${paragraphCount} · 句 ${sentenceCount}`);
console.log(`编号样例：${chapters[0]?.paragraphs?.[0]?.id} / ${chapters[0]?.paragraphs?.[0]?.sentences?.[0]?.id}`);

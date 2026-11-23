import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const content = '《星海纪事》\r\n序章\r\n我在旧城。\r\n\r\n1.初航\r\n\r\n他&#x20;朝她走来。\r\n\r\n最新网址https://example.com/\r\n\r\n2.归途\r\n“她来了！”他说。\r\n';

function tempRoot(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'novel-clean-parity-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

const readJson = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));

test('chapter review, numbered ranges and imported pronouns preserve the analyzer output', async (t) => {
  const { createCleanNumberTool } = await import('../analyzer/tools/clean-number/service.mjs');
  const modelConsole = { async chat({ source }) {
    switch (source) {
      case 'clean-chapters': return { content: '{"rows":[{"index":4,"kind":"chapter","number":1}]}' };
      case 'clean-chapter-coverage': return { content: '{"rows":[{"index":10,"kind":"chapter","number":2}]}' };
      case 'clean-chapter-review': return { content: '{"reject":[]}' };
      case 'clean-supplementary': return { content: '{"rows":[{"index":1,"kind":"preface"}]}' };
      default: throw new Error(`意外的模型复核阶段 ${source}`);
    }
  } };
  const tool = createCleanNumberTool({ root: tempRoot(t), modelConsole });
  const clean = await tool.clean({ name: '下载副本.txt', content, ai: false });

  assert.deepEqual(clean.cleanDoc, {
    书名: '星海纪事',
    目录: ['序章', '《星海纪事》（第1章） 初航', '《星海纪事》（第2章） 归途'],
    正文: '     《星海纪事》\n\n序章\n     我在旧城。\n\n《星海纪事》（第1章） 初航\n     他 朝她走来。\n\n《星海纪事》（第2章） 归途\n     “她来了！”他说。\n',
  });
  assert.equal(clean.chapterValidation.coverageAdded, 1);
  assert.deepEqual(clean.cleaningAudit.removedParagraphs, [{ line: 9, text: '最新网址https://example.com/', reason: '广告 / 作者留言 / 网站提示' }]);

  const numbered = tool.number({ cleanDoc: clean.cleanDoc, name: '星海纪事.txt' });
  assert.deepEqual(numbered.coverage, { sourceChars: 54, sentenceChars: 54, ratio: 1 });
  assert.deepEqual(numbered.doc.chapters.map(({ id, from, to, paragraphs }) => [id, from, to, paragraphs]), [
    ['C1', 'S4', 'S5', ['P2']], ['C2', 'S6', 'S8', ['P3']],
  ]);
  assert.deepEqual(numbered.doc.paragraphs.map(({ id, from, to }) => [id, from, to]), [
    ['P1', 'S1', 'S3'], ['P2', 'S4', 'S5'], ['P3', 'S6', 'S8'],
  ]);
  assert.deepEqual(numbered.doc.sentences.slice(-2).map(({ id, text }) => [id, text]), [['S7', '“她来了！”'], ['S8', '他说。']]);

  const { work } = tool.importNumbered({ numbered: numbered.numbered, title: '清洗测试工作目录' });
  const book = readJson(path.join(work, 'book.json'));
  assert.equal(book.title, '星海纪事');
  assert.deepEqual(book.frontMatter.map(({ id }) => id), ['S1', 'S2', 'S3']);
  assert.deepEqual(book.chapters.flatMap(({ paragraphs }) => paragraphs.flatMap(({ sentences }) => sentences.map(({ id, sid }) => [id, sid]))), [
    ['C1P1S1', 'S4'], ['C1P1S2', 'S5'], ['C2P1S1', 'S6'], ['C2P1S2', 'S7'], ['C2P1S3', 'S8'],
  ]);
  const { mentions } = readJson(path.join(work, 'l2', 'mention-table.json'));
  assert.deepEqual(mentions.map(({ id, sentenceId, text, offset }) => [id, sentenceId, text, offset]), [
    ['M000001', 'C1P1S2', '他', 0], ['M000002', 'C1P1S2', '她', 3], ['M000003', 'C2P1S2', '她', 1], ['M000004', 'C2P1S3', '他', 0],
  ]);
});

test('optional prose review retains the original text when the model invents corrections', async () => {
  const { createCleanNumberTool } = await import('../analyzer/tools/clean-number/service.mjs');
  const seen = [];
  const modelConsole = { async chat({ source, model }) {
    seen.push({ source, model });
    switch (source) {
      case 'clean-chapters': return { content: '{"rows":[{"index":0,"kind":"chapter","number":1}]}' };
      case 'clean-chapter-review': return { content: '{"reject":[]}' };
      case 'clean-number': return { content: '{"decisions":[{"id":"T0001","merge":true,"merged":"模型添写了新的内容。","confidence":0.99,"reason":"换行截断"}]}' };
      default: throw new Error(`意外的模型复核阶段 ${source}`);
    }
  } };
  const tool = createCleanNumberTool({ modelConsole });
  const input = { name: '测试.txt', content: '第一章 起点\n他从附近的站台看见\n一辆小车唿啸而过。', ai: true, model: 'structure-fixture' };
  const clean = await tool.clean({ ...input, bodyModel: 'body-fixture' });
  assert.match(clean.text, /他从附近的站台看见一辆小车唿啸而过。/);
  assert.ok(clean.issues.some(({ type, layer, applied }) => type === 'truncation' && layer === 'ai' && applied));
  assert.deepEqual([...new Set(seen.filter(row => row.source === 'clean-number').map(row => row.model))], ['body-fixture']);
  assert.deepEqual([...new Set(seen.filter(row => row.source !== 'clean-number').map(row => row.model))], ['structure-fixture']);
  seen.length = 0;
  await tool.clean(input);
  assert.deepEqual([...new Set(seen.filter(row => row.source === 'clean-number').map(row => row.model))], ['structure-fixture']);
});

test('import keeps every numbered sentence when the source has no confirmed chapters', async (t) => {
  const { createCleanNumberTool } = await import('../analyzer/tools/clean-number/service.mjs');
  const tool = createCleanNumberTool({ root: tempRoot(t) });
  const numbered = tool.number({ name: '无章.txt', cleanDoc: { 书名: '无章', 目录: [], 正文: '他站在海边。\n她走过来了。' } });
  const { work } = tool.importNumbered({ numbered: numbered.numbered });
  const book = readJson(path.join(work, 'book.json'));
  assert.equal(book.chapterCount, 0);
  assert.deepEqual(book.frontMatter.map(({ id, text }) => [id, text]), [['S1', '他站在海边。'], ['S2', '她走过来了。']]);
});

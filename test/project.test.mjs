import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const fixture = readFileSync(new URL('../examples/雾港来信.txt', import.meta.url));
const load = () => import('../lib/project.mjs');

test('保留 UTF-16 原稿与人工修正的章节、断行和覆盖区间', async () => {
  const { fromTxt, saveCleaning, saveNumbering, validateProject } = await load();
  const bytes = Buffer.concat([Buffer.from([255, 254]), Buffer.from(fixture.toString().replaceAll('\n', '\r\n'), 'utf16le')]);
  const p = fromTxt(bytes, '雾港来信.txt');
  assert.equal(p.source.encoding, 'UTF-16LE');
  assert.deepEqual(Buffer.from(p.source.base64, 'base64'), bytes);
  assert.equal(p.clean.title, '雾港来信');
  assert.deepEqual(p.clean.edits.headings.map(x => x.line), [6, 12]);
  saveCleaning(p, { ...p.clean.edits, title: '雾港', merges: [10] });
  saveNumbering(p);
  assert.deepEqual(p.numbered.chapters.map(c => c.id), ['C1', 'C2']);
  assert.equal(p.numbered.sentences[0].text, '林舟推开仓门。');
  assert.equal(p.numbered.sentences[1].text, '沈棠说：“你迟到了。”');
  assert.equal(p.numbered.sentences[3].text, '雨还没有停，他把信交给沈棠。');
  assert.equal(p.numbered.sentences.length, 8);
  assert.equal(p.numbered.coverage.ratio, 1);
  assert.deepEqual(p.clean.audit.filter(a => a.action === 'merge').map(a => a.line), [10]);
  for (const s of p.numbered.sentences) assert.equal(p.clean.body.slice(s.start, s.end), s.text);
  validateProject(p);
  const changed = structuredClone(p);
  changed.numbered.sentences[1].start -= 1;
  assert.throws(() => validateProject(changed), /编号|区间/);
});

test('旧书籍工程只迁移可核查的章段，保留输入文件与原段 ID', async () => {
  const { importProject, saveNumbering } = await load();
  const bytes = Buffer.from(JSON.stringify({
    format: 'corpus-kit-project', version: 2, book: { title: '旧船' },
    chapters: [{ title: '上船', paragraphs: [{ id: 'P0002', text: '雪停了。有人在甲板上挥手。' }] }],
    scenes: [{ sceneId: 'S01', 从: 'P0001', 到: 'P0001' }],
  }));
  const p = importProject(bytes, 'project.json');
  assert.equal(p.clean.title, '旧船');
  assert.equal(p.clean.body, '雪停了。有人在甲板上挥手。');
  assert.deepEqual(Buffer.from(p.source.base64, 'base64'), bytes);
  assert.equal(p.source.origin.paragraphs[0].id, 'P0002');
  saveNumbering(p);
  assert.equal(p.numbered.chapters[0].title, '上船');
  assert.equal(p.scenes, null);
});

test('无书名和无目录的小说保留开头，含引号和重复标点的正文逐字编号', async () => {
  const { fromTxt, saveNumbering, validateProject } = await load();
  const p = fromTxt(Buffer.from('他问：“你好吗？！” 她说：“我很好……” 再见。\n\n未完'), '手稿.txt');
  saveNumbering(p);
  assert.equal(p.clean.title, '手稿');
  assert.equal(p.numbered.chapters[0].title, '正文');
  assert.deepEqual(p.numbered.sentences.map(s => s.text), ['他问：“你好吗？！”', '她说：“我很好……”', '再见。', '未完']);
  validateProject(p);
});

test('无 BOM 的 UTF-16 英文稿保留实际编码和正文', async () => {
  const { fromTxt, validateProject } = await load();
  const text = 'Rain fell. The ship left.';
  const p = fromTxt(Buffer.from(text, 'utf16le'), 'letter.txt');
  assert.equal(p.source.encoding, 'UTF-16LE');
  assert.equal(p.source.bom, false);
  assert.equal(p.clean.body, text);
  validateProject(p);
});

test('旧语料拒绝重复段落区间或重复段落引用', async () => {
  const { importProject } = await load();
  const base = {
    format: 'novel-corpus', name: 'old', canonicalText: '第一句。第二句。',
    chapters: [{ title: '第一章', paragraphIds: ['P1', 'P2'] }],
    paragraphs: [{ id: 'P1', range: { start: 0, end: 4 } }, { id: 'P2', range: { start: 0, end: 4 } }],
  };
  assert.throws(() => importProject(Buffer.from(JSON.stringify(base)), 'old.json'), /重叠/);
  base.chapters[0].paragraphIds = ['P1', 'P1'];
  assert.throws(() => importProject(Buffer.from(JSON.stringify(base)), 'old.json'), /重复/);
});


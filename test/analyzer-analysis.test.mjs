import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const loadStages = () => import('../analyzer/analysis/index.mjs');
const ok = value => ({ ok: true, content: JSON.stringify(value) });

function bookFixture(t, paragraphs) {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'clean-analyzer-analysis-'));
  t.after(() => fs.rmSync(work, { recursive: true, force: true }));
  let n = 0;
  const chapters = paragraphs.map((chapter, i) => ({
    id: 'C' + (i + 1), title: '第一现场', paragraphs: chapter.map(rows => ({
      text: rows.join(''), sentences: rows.map(text => ({ sid: 'S' + ++n, text })),
    })),
  }));
  fs.writeFileSync(path.join(work, 'book.json'), JSON.stringify({ chapters }));
  const file = name => path.join(work, 'l2', name);
  return { work, file, read: name => JSON.parse(fs.readFileSync(file(name), 'utf8')) };
}

test('场景从未成场的第一句重新组批，暂停续跑保留滚动起点，且每场至少二十句', async t => {
  const { runSceneSegmentation } = await loadStages();
  const sentences = Array.from({ length: 90 }, () => '文'.repeat(149) + '。');
  const { work, file, read } = bookFixture(t, [[sentences]]);
  const startOf = prompt => Number(prompt.match(/【本批待判句子：完整原文】\n(\d+)\./)[1]);
  let calls = 0;
  await assert.rejects(runSceneSegmentation({ work, model: 'mock', chat: async ({ prompt }) => {
    calls += 1;
    if (calls === 1) return { ok: false, truncated: true, error: '输出达到 token 上限', content: ' ' };
    if (calls === 2) {
      assert.match(prompt, /上次输出校验失败/);
      assert.equal(startOf(prompt), 1);
      return ok({ cuts: [8, 20, 29] });
    }
    assert.equal(startOf(prompt), 21);
    return { ok: false, error: 'HTTP 503' };
  } }), /HTTP 503/);
  assert.equal(read('scenes.progress.json').cursor, 33);
  assert.equal(read('scenes.progress.json').nextAt, 20);
  const partial = fs.readFileSync(file('scenes.partial.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  assert.deepEqual(partial.map(x => [x.from, x.to]), [['S1', 'S20']]);
  assert.equal(fs.existsSync(file('scenes-llm.json')), false);

  const result = await runSceneSegmentation({ work, model: 'mock', resume: true, chat: async ({ prompt }) => {
    const starts = new Map([[21, [40]], [41, [60]], [61, [75, 80]]]);
    assert.ok(starts.has(startOf(prompt)));
    if (startOf(prompt) === 21) return ok({ checks: [
      { cut: 20, next: 21, change: '时间', newScene: true },
      { cut: 40, next: 41, change: '地点', newScene: true },
    ] });
    return ok({ cuts: starts.get(startOf(prompt)) });
  } });
  assert.deepEqual(result.scenes.map(x => [x.sceneId, x.from, x.to, x.sentences]), [
    ['SC001', 'S1', 'S20', 20], ['SC002', 'S21', 'S40', 20],
    ['SC003', 'S41', 'S60', 20], ['SC004', 'S61', 'S90', 30],
  ]);
  assert.equal(read('segmentation.verify.json').coveredSentences, 90);
});

test('真正越界的句号仍然会报错，且不会推进保存的场景进度', async t => {
  const { runSceneSegmentation } = await loadStages();
  const sentences = Array.from({ length: 60 }, () => '文'.repeat(149) + '。');
  const { work, read } = bookFixture(t, [[sentences]]);
  await assert.rejects(runSceneSegmentation({ work, model: 'mock', chat: async () => ok({ cuts: [999] }) }), /S999/);
  assert.equal(read('scenes.progress.json').cursor, 0);
  assert.match(read('segmentation.verify.json').errors[0], /S999/);
});

test('连续情节超过多个输入批次仍保留同一场，接缝在下一批用完整句复核', async t => {
  const { runSceneSegmentation } = await loadStages();
  const paragraphs = Array.from({ length: 100 }, (_, i) => ('第' + (i + 1) + '句').padEnd(199, '海') + '。');
  const { work } = bookFixture(t, [[paragraphs.slice(0, 37)], [paragraphs.slice(37)]]);
  const windowStarts = [];
  const result = await runSceneSegmentation({ work, model: 'mock', chat: async ({ prompt }) => {
    const batch = prompt.split('【本批待判句子：完整原文】\n')[1].split('\n【后续参考】')[0];
    const lines = batch.split('\n');
    const start = Number(lines[0].match(/^\d+/)[0]);
    windowStarts.push(start);
    assert.equal(lines.length, 25);
    assert.deepEqual(lines.map(line => line.replace(/^\d+\. /, '')), paragraphs.slice(start - 1, start + 24));
    if (start > 1) assert.match(prompt, new RegExp('前文参考 S' + (start - 1)));
    return ok({ checks: [] });
  } });
  assert.deepEqual(windowStarts, [1, 26, 51, 76]);
  assert.deepEqual(result.scenes.map(row => [row.from, row.to, row.sentences, row.chars, row.chapterIds]), [
    ['S1', 'S100', 100, 20000, ['C1', 'C2']],
  ]);
});

test('全文不足二十句时保留一场并标注原因', async t => {
  const { runSceneSegmentation } = await loadStages();
  const { work, read } = bookFixture(t, [[['他进门。', '第二天，他坐船离开。']]]);
  const result = await runSceneSegmentation({ work, model: 'mock', chat: async () => ok({ cuts: [1] }) });
  assert.deepEqual(result.scenes.map(row => [row.from, row.to]), [['S1', 'S2']]);
  assert.match(read('segmentation.verify.json').warnings[0], /全文只有 2 句/);
});
test('character table consolidates globally and scanner keeps pronouns unassigned', async t => {
  const { runCharacterTable, runMentions, runSceneSegmentation } = await loadStages();
  const { work, file, read } = bookFixture(t, [[['林薇说：“他们叫我小薇。”', '林薇望着父亲。']]]);
  await runSceneSegmentation({ work, model: 'mock', chat: async () => ok({ checks: [] }) });
  let calls = 0;
  const { characters } = await runCharacterTable({ work, model: 'mock', chat: async ({ prompt }) => {
    calls += 1;
    if (calls === 1) {
      assert.match(prompt, /林薇说：“他们叫我小薇。”/);
      return ok({ characters: [{ 姓名: '林薇', 别名: ['小薇', '我'] }, { 姓名: '小薇', 别名: [] }] });
    }
    assert.match(prompt, /【人物候选】/);
    return ok({ characters: [{ 姓名: '林薇', 别名: ['小薇', '我'] }, { 姓名: '他', 别名: [] }] });
  } });
  assert.equal(calls, 2);
  assert.deepEqual(characters.map(x => [x.id, x.name, x.aliases]), [['CH01', '林薇', ['小薇']]]);
  assert.equal(characters[0].evidence[0].sentence, 1);
  assert.deepEqual(read('relations.json').relations, []);
  assert.deepEqual(read('characters.json').characters, characters);

  const result = await runMentions({ work });
  assert.deepEqual(result.mentions.map(x => [x.id, x.surface, x.cls, x.sentence, x.start, x.end, x.characterId, x.inDialog, x.sceneId]), [
    ['M000001', '林薇', 'name', 1, 0, 2, 'CH01', false, 'SC001'],
    ['M000002', '他们', 'collective', 1, 5, 7, '', true, 'SC001'],
    ['M000003', '我', 'pronoun', 1, 8, 9, '', true, 'SC001'],
    ['M000004', '小薇', 'name', 1, 9, 11, 'CH01', true, 'SC001'],
    ['M000005', '林薇', 'name', 2, 0, 2, 'CH01', false, 'SC001'],
    ['M000006', '父亲', 'kinship', 2, 4, 6, '', false, 'SC001'],
  ]);
});

test('the original same-sentence relation pass resumes without replacing the saved character table', async t => {
  const { runCharacterTable } = await loadStages();
  const { work, read } = bookFixture(t, [[['林薇和陆平是朋友。']]]);
  const candidates = { characters: [{ 姓名: '林薇', 别名: [] }, { 姓名: '陆平', 别名: [] }] };
  await assert.rejects(runCharacterTable({ work, model: 'mock', chat: async ({ prompt }) => {
    return prompt.includes('下面每行是同句') ? { ok: false, error: 'HTTP 503' } : ok(candidates);
  } }), /HTTP 503/);
  const { generatedAt } = read('characters.json');
  await runCharacterTable({ work, model: 'mock', resume: true, chat: async ({ prompt }) => {
    assert.match(prompt, /1\. 林薇和陆平是朋友。/);
    return ok({ relations: [{ 句子: 1, 甲: 'CH01', 类型: '朋友', 乙: 'CH02' }] });
  } });
  assert.equal(read('characters.json').generatedAt, generatedAt);
  assert.deepEqual(read('relations.json').relations, [{
    from: 'CH01', fromName: '林薇', type: '朋友', to: 'CH02', toName: '陆平', chapter: 'C1',
    evidence: [{ sentence: 1, text: '林薇和陆平是朋友。' }],
  }]);
});

test('a failed character window does not produce a final table', async t => {
  const { runCharacterTable } = await loadStages();
  const { work, file } = bookFixture(t, [[['林薇走进院子。']]]);
  await assert.rejects(runCharacterTable({ work, model: 'mock', chat: async () => ({ ok: false, error: 'HTTP 503' }) }), /HTTP 503/);
  assert.equal(fs.existsSync(file('characters.json')), false);
});

test('角色按场景保存候选，超时缩短输入，续跑只重试尚未保存的片段', async t => {
  const { runCharacterTable } = await loadStages();
  const { characterCheckpoint } = await import('../analyzer/analysis/characters.mjs');
  const { work, file, read } = bookFixture(t, [[['林薇走进院子。'], ['陆平' + '文'.repeat(620) + '。', '赵梅' + '字'.repeat(620) + '。']]]);
  fs.mkdirSync(path.dirname(file('scenes-llm.json')));
  fs.writeFileSync(file('scenes-llm.json'), JSON.stringify({ scenes: [
    { sceneId: 'SC001', from: 'S1', to: 'S1' }, { sceneId: 'SC002', from: 'S2', to: 'S3' },
  ] }));
  const names = (...values) => ok({ characters: values.map(姓名 => ({ 姓名 })) });
  const input = prompt => prompt.split('【正文】\n')[1];
  const calls = [];
  await assert.rejects(runCharacterTable({ work, model: 'mock', chat: async ({ prompt }) => {
    const part = input(prompt);
    if (part.includes('林薇')) return names('林薇');
    calls.push(part.slice(0, 2));
    if (part.includes('陆平') && part.includes('赵梅')) {
      const saved = characterCheckpoint(work);
      assert.equal(saved.done, 1);
      assert.equal(saved.through, 1);
      assert.deepEqual(saved.scenes[0].names.map(row => row.name), ['林薇']);
      throw Error('模型请求超时');
    }
    return part.includes('陆平') ? names('陆平') : { ok: false, error: 'HTTP 503' };
  } }), /HTTP 503/);
  assert.deepEqual(calls, ['陆平', '陆平', '赵梅']);
  assert.equal(characterCheckpoint(work).done, 1);
  assert.deepEqual(read('characters.progress.json').candidates.map(row => row.name), ['林薇', '陆平']);
  await runCharacterTable({ work, model: 'mock', chat: async ({ prompt }) => {
    if (prompt.includes('【人物候选】')) return names('林薇', '陆平', '赵梅');
    assert.match(input(prompt), /^赵梅/);
    return names('赵梅');
  } });
  const finished = characterCheckpoint(work);
  assert.equal(finished.resumable, false);
  assert.deepEqual(finished.scenes.map(scene => scene.names.map(row => row.name)), [['林薇'], ['陆平', '赵梅']]);
});

test('旧版真名表断点沿用原批次，已超时的一批续跑时直接缩短', async t => {
  const { runCharacterTable, originalCharacterPrompts, characterCheckpoint } = await import('../analyzer/analysis/characters.mjs');
  const { loadBook, sha256 } = await import('../analyzer/analysis/files.mjs');
  const { work, file, read } = bookFixture(t, [[
    ['林薇' + '文'.repeat(3500) + '。'], ['陆平' + '字'.repeat(3500) + '。'],
  ]]);
  fs.mkdirSync(path.dirname(file('characters.progress.json')));
  const snapshot = JSON.stringify({
    sourceHash: loadBook(work).sourceHash, model: 'original', cursor: 1, complete: false,
    templateHash: sha256(JSON.stringify(Object.values(originalCharacterPrompts))),
    candidates: [{ name: '林薇', aliases: [] }],
  });
  fs.writeFileSync(file('characters.progress.json'), snapshot);
  fs.writeFileSync(file('truncation-report.json'), JSON.stringify({ failures: [
    { tool: 'build-character-table.mjs', phase: '角色识别', reason: '模型请求超时' },
  ] }));
  fs.writeFileSync(file('scenes-llm.json'), JSON.stringify({ scenes: [{ sceneId: 'SC001', from: 'S1', to: 'S2' }] }));
  assert.equal(characterCheckpoint(work).through, 1);
  assert.match(characterCheckpoint(work).error, /模型请求超时/);
  await assert.rejects(runCharacterTable({ work, model: 'different', chat: () => assert.fail() }), /切回「original」/);
  assert.equal(fs.readFileSync(file('characters.progress.json'), 'utf8'), snapshot);
  let windows = 0;
  await runCharacterTable({ work, model: 'original', chat: async ({ prompt }) => {
    if (prompt.includes('【人物候选】')) return ok({ characters: [{ 姓名: '林薇' }, { 姓名: '陆平' }] });
    const part = prompt.split('【正文】\n')[1];
    assert.ok(part.length < 3503);
    assert.doesNotMatch(part, /林薇/);
    windows += 1;
    return ok({ characters: part.includes('陆平') ? [{ 姓名: '陆平' }] : [] });
  } });
  assert.equal(windows, 2);
  assert.equal(read('characters.progress.json').cursor, 2);
});

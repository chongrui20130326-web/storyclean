import assert from 'node:assert/strict';
import { test } from 'node:test';

const load = () => import('../lib/tables.mjs');
const sentences = (texts) => texts.map((text, i) => ({ n: i + 1, id: 'S' + (i + 1), text, chapterId: 'C' + (i < 2 ? 1 : 2), chapterTitle: '' }));

test('场景可跨章而不重复正文，超过上限的语义场只在完整句边界切开', async () => {
  const { makeScenes } = await load();
  const rows = sentences(['雨'.repeat(2600), '风'.repeat(2200), '潮'.repeat(400), '黎明。']);
  const scenes = makeScenes(rows, [3]);
  assert.deepEqual(scenes.map(s => [s.sceneId, s.from, s.to, s.boundary]), [
    ['SC001', 'S1', 'S1', 'length-limit'],
    ['SC002', 'S2', 'S3', 'model'],
    ['SC003', 'S4', 'S4', 'end'],
  ]);
  assert.deepEqual(scenes[1].chapterIds, ['C1', 'C2']);
  assert.throws(() => makeScenes(sentences(['雨'.repeat(5001)]), []), /单句超过5000字/);
  assert.throws(() => makeScenes(rows, [4]), /切点/);
});

test('人称扫描采用最长匹配，保留共用别名的歧义、对话和原句区间', async () => {
  const { makeCharacters, makeMentions, makeScenes } = await load();
  const rows = sentences(['沈棠说：“我们去找林舟。”', '两人都叫小舟，她点头。']);
  const role = makeCharacters(rows, [
    { name: '林舟', aliases: ['小舟', '他'] }, { name: '沈棠', aliases: ['小舟', '她'] },
    { name: '她', aliases: [] },
  ]);
  assert.deepEqual(role.map(r => [r.id, r.name, r.aliases, r.firstSeen]), [
    ['CH01', '沈棠', ['小舟'], 'S1'], ['CH02', '林舟', ['小舟'], 'S1'],
  ]);
  const mentions = makeMentions(rows, makeScenes(rows, [1]), role);
  assert.deepEqual(mentions.map(m => [m.surface, m.cls, m.sceneId, m.characterId, m.inDialog]), [
    ['沈棠', 'name', 'SC001', 'CH01', false], ['我们', 'collective', 'SC001', '', true],
    ['林舟', 'name', 'SC001', 'CH02', true], ['小舟', 'name', 'SC002', '', false], ['她', 'pronoun', 'SC002', '', false],
  ]);
  assert.deepEqual(mentions[3].candidateIds, ['CH01', 'CH02']);
  assert.equal(mentions[3].source, 'ambiguous-literal');
  for (const m of mentions) assert.equal(rows[m.sentence - 1].text.slice(m.start, m.end), m.surface);
});

test('场景截断后缩小请求窗口，按完整句推进且可以判定上一批末句', async () => {
  const { modelSceneCuts } = await import('../lib/vendor/scene-boundaries.mjs');
  const rows = sentences(['风停了。', '船驶入码头。', '三日后他们登上山顶。', '月亮升起来了。', '他们点起营火。']);
  const processed = [];
  const calls = [];
  const cuts = await modelSceneCuts(rows, {
    onBatch: checkpoint => processed.push(checkpoint.done),
    async chat(prompt) {
      const input = prompt.split('【本批待判句子：完整原文】\n')[1].split('\n【后续参考】')[0];
      const n = Number(input.match(/^\d+/)[0]);
      const count = input.split('\n').length;
      calls.push([n, count]);
      assert.ok(prompt.includes('可选的场景起始编号'));
      for (const line of input.split('\n')) {
        const [number, text] = line.split('. ');
        assert.equal(text, rows[Number(number) - 1].text);
      }
      if (count > 2) return { ok: false, error: '模型输出达到 token 上限', content: '  ' };
      return { content: JSON.stringify({ starts: n === 3 ? [3] : [] }) };
    },
  });
  assert.deepEqual(calls.slice(0, 5), [[1, 5], [1, 5], [1, 3], [1, 3], [1, 2]]);
  assert.deepEqual(processed, [2, 4, 5]);
  assert.deepEqual(cuts, [2]);
});

test('批次末端只由后一批的完整正文判定，前一批的参考区不会锁定切点', async () => {
  const { modelSceneCuts } = await import('../lib/vendor/scene-boundaries.mjs');
  const rows = sentences(['甲。', '乙。', '丙。', '丁。']);
  let attempts = 0;
  const result = await modelSceneCuts(rows, {
    maxChars: 4,
    async chat() {
      attempts += 1;
      return { content: JSON.stringify({ cuts: attempts === 1 ? [2] : [] }) };
    },
  });
  assert.deepEqual(result, []);
  assert.equal(attempts, 3);
});

test('模型误判她俩为姓名时，人称扫描仍按集体代词处理', async () => {
  const { characterCandidates, makeCharacters, makeMentions, makeScenes } = await load();
  const rows = sentences(['沈棠看着她俩。']);
  const candidates = characterCandidates({ characters: [{ name: '她俩', aliases: [] }, { name: '沈棠', aliases: ['她俩'] }] }, rows);
  const characters = makeCharacters(rows, candidates);
  assert.deepEqual(characters.map(row => [row.name, row.aliases]), [['沈棠', []]]);
  const m = makeMentions(rows, makeScenes(rows, []), characters);
  assert.equal(m[1].surface, '她俩');
  assert.equal(m[1].cls, 'collective');
  assert.equal(m[1].characterId, '');
});


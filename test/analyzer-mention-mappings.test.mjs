import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

const scenes = [
  { sceneId: 'SC001', from: 'S1', to: 'S3' },
  { sceneId: 'SC002', from: 'S4', to: 'S5' },
];
const text = ['林舟说：“我来。”', '那位老人拿起了银色怀表。', '后来他走了。', '刚才拿起了银色怀表的老人名叫沈棠。', '其他东西留在原地。林舟与沈棠对视，他们都笑了。'];
const chars = [{ id: 'CH01', name: '林舟', aliases: [] }, { id: 'CH02', name: '沈棠', aliases: [] }];

test('按原文逐处映射，保留断点，跨场补证，拒绝不存在的角色或伪造引文', async t => {
  const { runMentionMappings, readMentionMapping, validateMentionMapping } = await import('../analyzer/analysis/mention-mappings.mjs');
  const { scanMentions } = await import('../analyzer/analysis/mentions.mjs');
  const { loadBook } = await import('../analyzer/analysis/files.mjs');
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'novel-mapping-test-'));
  t.after(() => fs.rmSync(work, { recursive: true, force: true }));
  const l2 = path.join(work, 'l2');
  fs.mkdirSync(l2);
  const book = { chapters: [{ id: 'C1', paragraphs: [{ sentences: text.map((value, i) => ({ id: 'S' + (i + 1), text: value })) }] }] };
  fs.writeFileSync(path.join(work, 'book.json'), JSON.stringify(book));
  const { sourceHash } = loadBook(work);
  const mentionTable = { sourceHash, method: '词表扫描（无模型）', ...scanMentions(book, scenes, chars) };
  const layers = { scenes: { sourceHash, scenes }, characters: { sourceHash, characters: chars }, mentions: mentionTable };
  const mention = (sentence, surface) => mentionTable.mentions.find(m => m.sentence === sentence && m.surface === surface);
  const me = mention(1, '我').id;
  const old = mention(2, '老人').id;
  const he = mention(3, '他').id;
  const nonhuman = mention(5, '他').id;
  const they = mention(5, '他们').id;
  const ok = rows => ({ ok: true, content: JSON.stringify({ mappings: rows }) });
  const answer = (mentionId, characterIds, sentence, quote) => ({ mentionId, status: characterIds.length ? 'mapped' : 'nonperson', characterIds, evidence: [{ sentence, quote }] });
  const progress = [];
  let firstRunCalls = 0;
  await assert.rejects(runMentionMappings({ work, layers, model: 'fixture', onProgress: row => progress.push(row), chat: async ({ prompt }) => {
    firstRunCalls += 1;
    if (!prompt.includes(me)) throw Error('模型请求超时');
    return ok([answer(me, ['CH01'], 1, '林舟说：“我来。”'), answer(he, ['CH09'], 3, '后来他走了。')]);
  } }), /超时/);
  assert.equal(firstRunCalls, 2);
  assert.equal(readMentionMapping(work, layers).document.scenes.length, 1);
  assert.equal(progress[0].etaSeconds, null);
  const estimate = progress.find(row => row.phase === 'local' && row.work?.done === 1 && row.done === 0);
  assert.equal(estimate?.work.total, 2);
  assert(estimate.etaSeconds > 0);
  let calls = 0;
  const queries = [];
  const retrieval = { key: 'fixture', model: 'fixture-embedding', client: {
    embedDocuments: async list => list.map(() => [1, 1]),
    embedQuery: async text => { queries.push(text); return [1, 1]; },
  } };
  const resumed = [];
  const result = await runMentionMappings({ work, layers, model: 'fixture', retrieval, onProgress: row => resumed.push(row), chat: async ({ prompt }) => {
    calls += 1;
    if (prompt.includes('跨场复核')) return ok([answer(old, ['CH02'], 4, text[3]), answer(he, ['CH02'], 4, '伪造')]);
    assert(!prompt.includes(me));
    return ok([answer(nonhuman, [], 5, '其他东西留在原地。'), answer(they, ['CH01', 'CH02'], 5, '林舟与沈棠对视')]);
  } });
  assert(calls >= 2);
  assert.equal(result.phase, 'done');
  assert.equal(resumed[0].work?.total, 1);
  assert.equal(resumed[0].work?.done, 0);
  assert(resumed.some(row => row.indexing && row.work?.unit === 'passages'));
  assert(resumed.some(row => row.phase === 'review' && !row.indexing && row.work?.unit === 'batches'));
  assert.equal(resumed.at(-1).etaSeconds, undefined);
  assert.equal(result.retrieval, 'hybrid');
  assert(queries.length >= 1);
  const all = new Map(result.scenes.flatMap(s => s.results).map(r => [r.mentionId, r]));
  assert.equal(all.size, mentionTable.mentions.length);
  assert.equal(all.get(mention(1, '林舟').id).method, 'exact');
  assert.deepEqual(all.get(me).characterIds, ['CH01']);
  assert.deepEqual(all.get(old).characterIds, ['CH02']);
  assert.equal(all.get(old).method, 'retrieval');
  assert.equal(all.get(he).status, 'pending');
  assert.equal(all.get(nonhuman).status, 'nonperson');
  assert.deepEqual(all.get(they).characterIds, ['CH01', 'CH02']);
  validateMentionMapping(result, layers, new Map(text.map((line, i) => [i + 1, { text: line }])), sourceHash);
  const forged = structuredClone(result);
  forged.scenes[0].results.find(item => item.mentionId === old).evidence[0].start += 1;
  assert.throws(() => validateMentionMapping(forged, layers, new Map(text.map((line, i) => [i + 1, { text: line }])), sourceHash), /证据/);
  assert.equal(readMentionMapping(work, { ...layers, characters: { characters: chars.slice(0, 1) } }).stale, true);
});

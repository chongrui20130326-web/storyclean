import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createServer } from 'node:http';
import test from 'node:test';

function workDir(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'novel-role-hybrid-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

test('本书混合检索保存向量、保留两字姓名、二次运行复用并限制检索范围', async t => {
  const { withBookRoleSearch } = await import('../analyzer/analysis/role-hybrid-search.mjs');
  const work = workDir(t);
  const rows = ['史强把烟盒收了起来。', '物理学教授走上讲台。', '这段尚未处理。'].map((text, i) => ({ n: i + 1, text }));
  const scenes = rows.map(({ n }) => ({ sceneId: 'SC00' + n, from: 'S' + n, to: 'S' + n }));
  const embedded = [];
  const embedding = { model: 'mock', key: 'fixture', client: {
    async embedDocuments(texts) {
      embedded.push(...texts);
      return texts.map(text => text.includes('讲台') ? [1, 0, 0] : text.includes('史强') ? [0, 1, 0] : [1, 1, 0]);
    },
    async embedQuery() { return [1, 0, 0]; },
  } };
  const run = (count, action) => withBookRoleSearch({ work, rows, scenes: scenes.slice(0, count), sourceHash: 'fixture', embedding }, action);
  await run(3, async search => assert.equal((await search('教师', [])).length, 3));
  await run(2, async search => {
    const result = await search('教物理的人', ['史强']);
    assert.deepEqual(new Set(result.map(doc => doc.metadata.sceneId)), new Set(['SC001', 'SC002']));
    assert.ok(result.some(doc => doc.pageContent.includes('史强') && doc.metadata.methods.includes('exact')));
  });
  assert.deepEqual(embedded, rows.map(row => row.text));
});

test('LangChain 向量适配器仅访问配置的兼容网关并保持模型独立', async t => {
  const { createRoleEmbeddings, checkRoleEmbeddings } = await import('../analyzer/analysis/role-hybrid-search.mjs');
  const requestLog = [];
  const service = createServer(async (req, res) => {
    let payload = '';
    for await (const part of req) payload += part;
    requestLog.push({ url: req.url, body: JSON.parse(payload), auth: req.headers.authorization });
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ data: [{ embedding: [0.8, 0.6], index: 0 }], model: 'test-embedding' }));
  });
  await new Promise(resolve => service.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { service.closeAllConnections(); service.close(resolve); }));
  const embeddings = createRoleEmbeddings({ gateway: 'http://127.0.0.1:' + service.address().port + '/v1',
    apiKey: 'unit-test-key', roleEmbeddingModel: 'test-embedding', timeoutMs: 1000 });
  assert.deepEqual(await checkRoleEmbeddings(embeddings), { model: 'test-embedding', dimensions: 2 });
  assert.equal(requestLog[0].url, '/v1/embeddings');
  assert.equal(requestLog[0].body.model, 'test-embedding');
  assert.equal(requestLog[0].auth, 'Bearer unit-test-key');
});

test('混合检索发现措辞不同的同一行动，并拒绝仅同职业或未处理原句', async t => {
  const { findHybridReviewCandidates } = await import('../analyzer/analysis/role-hybrid-identities.mjs');
  const work = workDir(t);
  const text = ['那名教物理的人走上讲台。', '物理学教授名叫李平。', '刚才走上讲台的物理学教授名叫叶哲泰。', '另一个人说走上讲台的人叫陈东。'];
  const rows = text.map((text, i) => ({ text, n: i + 1 }));
  const address = { sentence: 1, surface: '那名教物理的人', start: 0, end: 7, kind: 'address' };
  const presence = { sentence: 1, surface: '走上讲台', start: 7, end: 11, kind: 'presence' };
  const people = [
    { id: 'CH01', name: '', aliases: [], evidence: [address] },
    { id: 'CH02', name: '李平', aliases: [], evidence: [] },
    { id: 'CH03', name: '叶哲泰', aliases: [], evidence: [] },
    { id: 'CH04', name: '陈东', aliases: [], evidence: [] },
  ];
  const scenes = rows.map(({ n }) => ({ sceneId: 'SC00' + n, from: 'S' + n, to: 'S' + n, roles: n === 1
    ? [{ roleId: 'CH01', status: 'present', evidence: [address, presence] }] : [] }));
  const embeddings = { model: 'mock', key: 'k', client: {
    async embedDocuments(strings) { return strings.map(value => value.includes('讲台') ? [1, 0] : [0, 1]); },
    async embedQuery() { return [1, 0]; },
  } };
  const found = await findHybridReviewCandidates({ work, sourceHash: 'fixture', people, rows, scenes: scenes.slice(0, 3),
    embedding: embeddings, exact: [], checked: {} });
  assert.deepEqual(found.map(x => [x.from, x.to, x.identitySentence, x.bridge.surface]), [['CH01', 'CH03', 3, '走上讲台']]);
});

test('向量网关失败会回退，重新复核已完成场景不会重跑正文或关系附表', async t => {
  const { runSceneRoles, readSceneRoles, sceneRoleCheckpoint } = await import('../analyzer/analysis/scene-roles.mjs');
  const { validateSceneRoleLayer } = await import('../analyzer/analysis/scene-role-evidence.mjs');
  const work = workDir(t);
  const l2 = path.join(work, 'l2');
  fs.mkdirSync(l2);
  const lines = ['那名教物理的人走上讲台。', '刚才走上讲台的物理学教授名叫叶哲泰。'];
  const scenes = lines.map((_line, i) => ({ sceneId: 'SC00' + (i + 1), from: 'S' + (i + 1), to: 'S' + (i + 1) }));
  fs.writeFileSync(path.join(l2, 'scenes-llm.json'), JSON.stringify({ scenes }));
  fs.writeFileSync(path.join(work, 'book.json'), JSON.stringify({ chapters: [{ id: 'C1', paragraphs: [
    { sentences: lines.map((text, i) => ({ text, sid: 'S' + (i + 1) })) },
  ] }] }));
  const ok = value => ({ ok: true, content: JSON.stringify(value) });
  await runSceneRoles({ work, model: 'chat', chat: async ({ prompt }) => ok({ roles: prompt.includes('SC001') ? [
    { name: '', status: 'present', evidence: [
      { sentence: 1, surface: '那名教物理的人', kind: 'address' },
      { sentence: 1, surface: '那名教物理的人走上讲台', kind: 'presence' },
    ] },
  ] : [{ name: '叶哲泰', status: 'mentioned', evidence: [{ sentence: 2, surface: '叶哲泰', kind: 'name' }] }] }) });
  const without = readSceneRoles(work);
  assert.equal(without.people.length, 2);
  const relationFile = path.join(l2, 'relations.json');
  const untouched = fs.readFileSync(relationFile, 'utf8');
  let offline = true, reviewed = 0;
  const retrieval = { model: 'mock', key: 'profile', load: async () => ({
    client: { async embedDocuments(values) {
      if (offline) throw Error('模型不可用');
      return values.map(() => [1, 1]);
    }, async embedQuery() { return [1, 1]; } },
  }) };
  const review = () => runSceneRoles({ work, model: 'chat', reviewOnly: true, retrieval, chat: async ({ prompt }) => {
    assert.match(prompt, /【待核对身份】/);
    assert.match(prompt, /observedAction/);
    reviewed++;
    return ok({ links: [{ from: 'CH01', to: 'CH02', mentionSentence: 1, identitySentence: 2, quote: '刚才走上讲台的物理学教授名叫叶哲泰' }] });
  } });
  await review();
  assert.equal(sceneRoleCheckpoint(work).retrieval.mode, 'fallback');
  assert.equal(reviewed, 0);
  offline = false;
  await review();
  const after = readSceneRoles(work);
  assert.equal(after.complete, true);
  assert.equal(after.retrievalModel, 'mock');
  assert.equal(reviewed, 1);
  assert.deepEqual(after.scenes.map(scene => scene.roles[0].roleId), ['CH02', 'CH02']);
  assert.equal(after.people[0].identityLinks[0].bridge.surface, '走上讲台');
  assert.equal(fs.readFileSync(relationFile, 'utf8'), untouched);
  const roster = JSON.parse(fs.readFileSync(path.join(l2, 'characters.json'), 'utf8'));
  validateSceneRoleLayer(after, new Map(lines.map((text, i) => [i + 1, { text }])), scenes, roster);
});

test('向量批次中断后从已持久化的八段之后继续', async t => {
  const { withBookRoleSearch } = await import('../analyzer/analysis/role-hybrid-search.mjs');
  const work = workDir(t);
  const rows = Array.from({ length: 10 }, (_, i) => ({ n: i + 1, text: '正文片段 ' + (i + 1) }));
  const scenes = rows.map(({ n }) => ({ sceneId: 'SC' + String(n).padStart(3, '0'), from: 'S' + n, to: 'S' + n }));
  const requests = [];
  const embedding = { model: 'mock', key: 'batch-fixture', client: {
    async embedDocuments(texts) {
      requests.push(texts);
      if (requests.length === 2) throw Error('暂时中断');
      return texts.map(() => [1, 1]);
    },
    async embedQuery() { return [1, 1]; },
  } };
  const index = () => withBookRoleSearch({ work, rows, scenes, sourceHash: 'fixture', embedding }, async () => {});
  await assert.rejects(index(), /暂时中断/);
  await index();
  assert.deepEqual(requests.map(texts => texts.length), [8, 2, 2]);
  assert.deepEqual(requests[2], requests[1]);
});

test('二十四个带预期的小场景对照原句检索和混合复核', async t => {
  const { retrieveIdentityCandidates } = await import('../analyzer/analysis/scene-role-retrieval.mjs');
  const { findHybridReviewCandidates } = await import('../analyzer/analysis/role-hybrid-identities.mjs');
  const cases = [
    ['红衣旅客', '敲响窗户', '红衣旅客名叫陈清。', true],
    ['戴帽访客', '推开木门', '戴帽访客就是陈清。', true],
    ['那名教物理的人', '走上讲台', '刚才走上讲台的物理学教授名叫陈清。', true],
    ['那位不住咳嗽的人', '合上书本', '先前合上书本的店主名叫陈清。', true],
    ['戴灰帽子的人', '接过信封', '此前接过信封的来客就是陈清。', true],
    ['拎着篮子的妇人', '捡起钥匙', '刚才捡起钥匙的邻居名叫陈清。', true],
    ['那名教物理的人', '走上讲台', '物理学教授名叫陈清。', false],
    ['那名教物理的人', '走上讲台', '刚才另一位走上讲台的人名叫陈清。', false],
    ['那名教物理的人', '走上讲台', '听说刚才走上讲台的教授名叫陈清。', false],
    ['那名教物理的人', '走上讲台', '刚才走上讲台的教授不一定名叫陈清。', false],
    ['那名教物理的人', '走上讲台', '刚才收起书本的教授名叫陈清。', false],
    ['那名教物理的人', '走上讲台', '刚才走上讲台的教授名叫陈清吗？', false],
  ];
  const root = workDir(t);
  let exactHits = 0, hybridHits = 0, wrong = 0;
  for (const [i, [label, action, next, wanted]] of cases.entries()) {
    const rows = [{ n: 1, text: label + action + '。' }, { n: 2, text: next }];
    const address = { kind: 'address', sentence: 1, surface: label, start: 0, end: label.length };
    const presence = { kind: 'presence', sentence: 1, surface: label + action, start: 0, end: label.length + action.length };
    const people = [{ id: 'CH01', name: '', aliases: [], evidence: [address] }, { id: 'CH02', name: '陈清', aliases: [], evidence: [] }];
    const scenes = [
      { sceneId: 'SC001', from: 'S1', to: 'S1', roles: [{ roleId: 'CH01', status: 'present', evidence: [address, presence] }] },
      { sceneId: 'SC002', from: 'S2', to: 'S2', roles: [] },
    ];
    const embedding = { model: 'fixture', key: 'comparison', client: {
      async embedDocuments(texts) { return texts.map(text => text.includes(action) ? [1, 0] : [0, 1]); },
      async embedQuery() { return [1, 0]; },
    } };
    const exact = retrieveIdentityCandidates(people, rows, 2);
    const hybrid = await findHybridReviewCandidates({ work: path.join(root, String(i)), sourceHash: String(i), people, rows, scenes,
      embedding, exact, checked: {} });
    const hits = [...exact, ...hybrid];
    exactHits += wanted ? exact.length : 0;
    hybridHits += wanted ? hits.length : 0;
    wrong += wanted ? 0 : hits.length;
    assert.equal(hits.length, Number(wanted), '标注场景对照 ' + (i + 1));
  }
  assert.deepEqual({ exactHits, hybridHits, wrong }, { exactHits: 2, hybridHits: 6, wrong: 0 });
});

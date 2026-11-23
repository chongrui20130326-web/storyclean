import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const ok = value => ({ ok: true, content: JSON.stringify(value) });
const evidence = (sentence, surface, kind) => ({ sentence, surface, kind });

function fixture(t, scenes) {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'novel-scene-roles-'));
  t.after(() => fs.rmSync(work, { recursive: true, force: true }));
  const l2 = path.join(work, 'l2');
  fs.mkdirSync(l2);
  let n = 0;
  const sections = scenes.map((sentences, index) => {
    const from = 'S' + (n + 1);
    const rows = sentences.map(text => ({ sid: 'S' + ++n, text }));
    return { range: { sceneId: 'SC00' + (index + 1), from, to: 'S' + n }, paragraph: { text: sentences.join(''), sentences: rows } };
  });
  fs.writeFileSync(path.join(work, 'book.json'), JSON.stringify({ chapters: [{ id: 'C1', paragraphs: sections.map(row => row.paragraph) }] }));
  const complete = () => fs.writeFileSync(path.join(l2, 'scenes-llm.json'), JSON.stringify({ scenes: sections.map(row => row.range) }));
  const partial = count => fs.writeFileSync(path.join(l2, 'scenes.partial.jsonl'), sections.slice(0, count).map(row => JSON.stringify(row.range)).join('\n'));
  return { work, l2, complete, partial };
}

test('逐场核对出场、仅被提及和待确认，后续揭示姓名后回填已保存的场景', async t => {
  const { runSceneRoles, readSceneRoles } = await import('../analyzer/analysis/scene-roles.mjs');
  const { work, l2, complete, partial } = fixture(t, [
    ['这位物理学教授走上讲台。', '台下有人说赵敏昨天来过。'],
    ['这位物理学教授就是叶哲泰。', '叶哲泰拿起讲稿。'],
  ]);
  const old = path.join(l2, 'characters.progress.json');
  fs.writeFileSync(old, '{"cursor":17,"candidates":[{"name":"爱翁","aliases":[]}]}');
  partial(1);
  const run = chat => runSceneRoles({ work, model: 'fixture', chat });
  await run(async () => ok({ roles: [
    { name: '', status: 'present', evidence: [evidence(1, '这位物理学教授', 'address'), evidence(1, '走上讲台', 'presence')] },
    { name: '赵敏', status: 'mentioned', evidence: [evidence(2, '赵敏', 'name'), evidence(2, '赵敏昨天来过', 'mention')] },
    { name: '爱翁', status: 'present', evidence: [evidence(1, '爱翁', 'name')] },
  ] }));
  const first = readSceneRoles(work);
  assert.equal(first.complete, false);
  assert.equal(first.scenes.length, 1);
  assert.deepEqual(first.scenes[0].roles.map(row => row.status), ['present', 'mentioned']);
  const teacher = first.scenes[0].roles[0].roleId;
  assert.equal(first.people.find(row => row.id === teacher).name, '');
  complete();
  await assert.rejects(run(async ({ prompt }) => {
    assert.match(prompt, /SC002/);
    throw Error('模型请求超时');
  }), /模型请求超时/);
  assert.deepEqual(readSceneRoles(work).scenes, first.scenes);
  await run(async ({ prompt }) => {
    if (prompt.startsWith('角色表：')) return ok({ relations: [] });
    assert.match(prompt, /SC002/);
    const source = prompt.split('编号原文】\n')[1];
    return ok({ roles: [source.startsWith('3.') ? {
      name: '叶哲泰', knownId: teacher, status: 'uncertain', evidence: [
        evidence(3, '叶哲泰', 'name'), evidence(3, '这位物理学教授就是叶哲泰', 'identity'),
      ], aliases: [{ name: '这位物理学教授', sentence: 3, quote: '这位物理学教授就是叶哲泰' }],
    } : { name: '叶哲泰', status: 'present', evidence: [evidence(4, '叶哲泰', 'name'), evidence(4, '拿起讲稿', 'presence')] }] });
  });
  const final = readSceneRoles(work);
  assert.equal(final.complete, true);
  assert.deepEqual(final.scenes.map(scene => scene.roles[0].roleId), [teacher, teacher]);
  assert.deepEqual(final.people.find(row => row.id === teacher).aliases, []);
  assert.equal(final.people.find(row => row.id === teacher).name, '叶哲泰');
  assert.equal(final.scenes[0].roles[0].evidence[0].sentence, 1);
  assert.equal(JSON.parse(fs.readFileSync(old, 'utf8')).cursor, 17);
});

test('只复核身份未确认的人，保留已保存的场景和证据位置', async t => {
  const { runSceneRoles, readSceneRoles } = await import('../analyzer/analysis/scene-roles.mjs');
  const { work, complete } = fixture(t, [
    ['老先生进了门。'], ['老先生就是陈清。陈清坐了下来。'],
  ]);
  complete();
  const calls = [];
  await runSceneRoles({ work, model: 'fixture', chat: async ({ prompt }) => {
    calls.push(prompt);
    if (prompt.includes('【待核对身份】')) {
      return ok({ links: [{ from: 'CH01', to: 'CH02', mentionSentence: 1, identitySentence: 2, quote: '老先生就是陈清' }] });
    }
    if (prompt.includes('SC001')) return ok({ roles: [{ name: '', status: 'present', evidence: [
      evidence(1, '老先生', 'address'), evidence(1, '进了门', 'presence'),
    ] }] });
    return ok({ roles: [{ name: '陈清', status: 'present', evidence: [
      evidence(2, '陈清', 'name'), evidence(2, '坐了下来', 'presence'), evidence(2, '老先生就是陈清', 'identity'),
    ] }] });
  } });
  const result = readSceneRoles(work);
  assert.equal(calls.filter(prompt => prompt.includes('【待核对身份】')).length, 1);
  assert.equal(result.scenes[0].roles[0].roleId, result.scenes[1].roles[0].roleId);
  assert.equal(result.people.length, 1);
  assert.equal(result.people[0].name, '陈清');
});

test('后场明确透露本名时更新同一角色编号，早场名称继续留在原文证据中', async t => {
  const { runSceneRoles, readSceneRoles } = await import('../analyzer/analysis/scene-roles.mjs');
  const { work, complete } = fixture(t, [['阿岚走进房间。'], ['阿岚的本名是林岚。']]);
  complete();
  await runSceneRoles({ work, model: 'fixture', chat: async ({ prompt }) => {
    if (prompt.includes('SC001')) return ok({ roles: [{ name: '阿岚', status: 'present', evidence: [
      evidence(1, '阿岚', 'name'), evidence(1, '走进房间', 'presence'),
    ] }] });
    return ok({ roles: [{ name: '林岚', status: 'mentioned', knownId: 'CH01', evidence: [
      evidence(2, '林岚', 'name'), evidence(2, '阿岚的本名是林岚', 'identity'),
    ] }] });
  } });
  const result = readSceneRoles(work);
  assert.deepEqual(result.people.map(row => [row.id, row.name, row.aliases]), [['CH01', '林岚', ['阿岚']]]);
  assert.equal(result.scenes[0].roles[0].evidence[0].surface, '阿岚');
  assert.equal(result.scenes[0].roles[0].roleId, 'CH01');
});

test('长场景缩短超时输入，续跑只重新请求未保存的句子', async t => {
  const { runSceneRoles, readSceneRoles } = await import('../analyzer/analysis/scene-roles.mjs');
  const { work, complete } = fixture(t, [[
    '林岚进门。' + '雨'.repeat(1000), '季河挥手。' + '路'.repeat(1000), '陈清低头。' + '灯'.repeat(1000),
  ]]);
  complete();
  const numbered = prompt => prompt.split('编号原文】\n')[1];
  let calls = 0;
  await assert.rejects(runSceneRoles({ work, model: 'fixture', chat: async ({ prompt }) => {
    calls += 1;
    if (calls === 1) return { ok: false, truncated: true, error: '模型输出达到 token 上限' };
    if (calls === 2) {
      assert.doesNotMatch(numbered(prompt), /季河/);
      return ok({ roles: [{ name: '林岚', status: 'present', evidence: [
        evidence(1, '林岚', 'name'), evidence(1, '进门', 'presence'),
      ] }] });
    }
    throw Error('模型网关返回 HTTP 503');
  } }), /503/);
  assert.equal(readSceneRoles(work).scenes.length, 0);
  await runSceneRoles({ work, model: 'fixture', chat: async ({ prompt }) => {
    assert.match(numbered(prompt), /^2\. 季河/);
    assert.doesNotMatch(numbered(prompt), /林岚/);
    return ok({ roles: [{ name: '季河', status: 'present', evidence: [
      evidence(2, '季河', 'name'), evidence(2, '挥手', 'presence'),
    ] }] });
  } });
  assert.deepEqual(readSceneRoles(work).people.map(row => row.name), ['林岚', '季河']);
});

test('证据支持 S 编号和唯一原句定位，职称只留下本场称呼', async () => {
  const { readSceneFindings } = await import('../analyzer/analysis/scene-role-evidence.mjs');
  const rows = [
    { n: 14, offset: 0, text: '这位物理学教授走上讲台。' },
    { n: 15, offset: 0, text: '叶哲泰低下头。铃响了。' },
    { n: 16, offset: 0, text: '铃响了。' },
  ];
  const result = readSceneFindings({ roles: [
    { name: '这位物理学教授', status: 'present', evidence: [
      evidence('S14', '这位物理学教授', 'name'), evidence('14', '走上讲台', 'presence'),
    ] },
    { name: '叶哲泰', status: 'present', evidence: [
      evidence(2, '叶哲泰低下头', 'presence'), evidence(2, '铃响了', 'presence'),
    ] },
  ] }, rows);
  assert.deepEqual(result.map(row => [row.name, row.label, row.status]), [
    ['', '这位物理学教授', 'present'], ['叶哲泰', '', 'present'],
  ]);
  assert.equal(result[1].evidence.find(row => row.kind === 'name').sentence, 15);
  assert.equal(result[1].evidence.some(row => row.surface === '铃响了'), false);
});

test('职业、身份和机构不能进入真名表，具体人物的称呼仍可定位', async () => {
  const { readSceneFindings } = await import('../analyzer/analysis/scene-role-evidence.mjs');
  const surfaces = ['罪犯', '军人', '警察', '国内大媒体的记者', '地球三体组织', '一群戴着白手套拿着相机的警察', '叶哲泰', '周文王', '格里高利教皇', '李军'];
  const rows = surfaces.map((name, i) => ({ n: i + 1, offset: 0, text: name + '走进大厅。' }));
  const value = { roles: surfaces.map((name, i) => ({ name, status: 'present', evidence: [
    evidence(i + 1, name, 'name'), evidence(i + 1, '走进大厅', 'presence'),
  ] })) };
  const result = readSceneFindings(value, rows);
  assert.deepEqual(result.filter(row => row.name).map(row => row.name), ['叶哲泰', '周文王', '格里高利教皇', '李军']);
  assert.deepEqual(result.filter(row => !row.name).map(row => row.label), surfaces.slice(0, 4));
  assert.ok(result.filter(row => !row.name).every(row => row.status === 'present' && row.evidence.some(fact => fact.kind === 'address')
    && row.evidence.every(fact => fact.kind !== 'name')));
  assert.deepEqual(readSceneFindings({ roles: [value.roles[4]] }, rows), []);
});

test('按原句区分物件、地点、概念和人物，保留明确命名的同形角色名', async () => {
  const { readSceneFindings } = await import('../analyzer/analysis/scene-role-evidence.mjs');
  const samples = [
    ['原子', '丁仪谈到普通原子的展开。'], ['宇宙', '他提到宇宙大爆炸。'],
    ['书房', '丁仪去书房找资料。'], ['台球桌', '两人靠在那张台球桌旁边。'],
    ['客厅', '他们走进了客厅。'], ['会议室', '众人散去，会议室空了。'],
    ['良湘', '记得良湘加速器的爆炸案。'], ['刘慈欣', '《三体》 作者：刘慈欣'],
    ['原子', '她的名字叫「原子」。'], ['叶文洁', '史强提到了叶文洁。'],
    ['科学执政官', '科学执政官站起来说话。'],
  ];
  const rows = samples.map(([, text], i) => ({ n: i + 1, text }));
  const roles = samples.map(([name], i) => ({ name, status: 'mentioned', evidence: [evidence(i + 1, name, 'name')] }));
  const result = readSceneFindings({ roles }, rows);
  assert.deepEqual(result.map(({ name, label }) => [name, label]), [['原子', ''], ['叶文洁', ''], ['', '科学执政官']]);
  assert.equal(result[0].evidence[0].sentence, 9);
  assert.deepEqual(readSceneFindings({ roles: roles.slice(0, 8) }, rows), []);
});

test('清理既有真名断点保留场景、角色编号、证据和恢复位置', async t => {
  const { repairSceneRoleFiles, readSceneRoles, sceneRoleCheckpoint } = await import('../analyzer/analysis/scene-roles.mjs');
  const { work, l2, partial } = fixture(t, [['警察推门。', '李军点头。地球三体组织已经解散。', '他听说了良湘加速器的事故。'], ['后续场景。']]);
  partial(1);
  const anchor = (sentence, surface, start, kind) => ({ sentence, surface, start, end: start + surface.length, kind });
  const people = [
    { id: 'CH01', name: '警察', label: '', aliases: [], evidence: [anchor(1, '警察', 0, 'name')], firstSeen: 1, lastSeen: 1 },
    { id: 'CH02', name: '李军', label: '', aliases: [], evidence: [anchor(2, '李军', 0, 'name')], firstSeen: 2, lastSeen: 2 },
    { id: 'CH03', name: '地球三体组织', label: '', aliases: [], evidence: [anchor(2, '地球三体组织', 5, 'name')], firstSeen: 2, lastSeen: 2 },
    { id: 'CH04', name: '良湘', label: '', aliases: [], evidence: [anchor(3, '良湘', 4, 'name')], firstSeen: 3, lastSeen: 3 },
  ];
  const roleFile = path.join(l2, 'scene-roles.progress.json');
  fs.writeFileSync(roleFile, JSON.stringify({
    strategy: 'scene-evidence-v1', people, nextId: 5, complete: false, phase: 'waiting-scenes', at: '2026-01-01T00:00:00.000Z',
    scenes: [{ sceneId: 'SC001', from: 'S1', to: 'S3', roles: [
      { roleId: 'CH01', status: 'present', evidence: [...people[0].evidence, anchor(1, '推门', 2, 'presence')] },
      { roleId: 'CH02', status: 'mentioned', evidence: people[1].evidence },
      { roleId: 'CH03', status: 'mentioned', evidence: people[2].evidence },
      { roleId: 'CH04', status: 'mentioned', evidence: people[3].evidence },
    ] }],
  }));
  const before = fs.readFileSync(roleFile, 'utf8');
  assert.equal(repairSceneRoleFiles(work).changed, true);
  assert.equal(repairSceneRoleFiles(work).changed, false);
  const cleaned = readSceneRoles(work);
  assert.deepEqual(cleaned.people.map(row => [row.id, row.name, row.label]), [['CH01', '', '警察'], ['CH02', '李军', '']]);
  assert.deepEqual(cleaned.scenes[0].roles[0].evidence[0], anchor(1, '警察', 0, 'address'));
  assert.equal(cleaned.nextId, 5);
  assert.equal(sceneRoleCheckpoint(work).done, 1);
  const backup = fs.readdirSync(l2).find(name => name.startsWith('scene-roles.progress.json.bak-'));
  assert.equal(fs.readFileSync(path.join(l2, backup), 'utf8'), before);
});

test('旧名单把多场同一职称当同一人时，改回各场待确认人物', async () => {
  const { applyRoleNamePolicy } = await import('../analyzer/analysis/scene-role-names.mjs');
  const role = sentence => ({ roleId: 'CH01', status: 'present', evidence: [
    { sentence, surface: '军人', start: 0, end: 2, kind: 'name' },
    { sentence, surface: '离开房间', start: 2, end: 6, kind: 'presence' },
  ] });
  const state = { people: [{ id: 'CH01', name: '军人', label: '', aliases: [], evidence: [role(1).evidence[0]] }],
    scenes: [{ roles: [role(1)] }, { roles: [role(5)] }], nextId: 2 };
  assert.equal(applyRoleNamePolicy(state).changed, true);
  assert.deepEqual(state.scenes.map(scene => scene.roles[0].roleId), ['CH01', 'CH02']);
  assert.deepEqual(state.people.map(person => [person.name, person.label, person.firstSeen]), [['', '军人', 1], ['', '军人', 5]]);
  assert.equal(applyRoleNamePolicy(state).changed, false);
});

test('原文证据校验失败时缩小当前片段，续跑复用已经保存的片段', async t => {
  const { runSceneRoles, readSceneRoles } = await import('../analyzer/analysis/scene-roles.mjs');
  const { work, complete } = fixture(t, [['陈清走到门口。', '林岚写完一封信。']]);
  complete();
  let errors = 0;
  await assert.rejects(runSceneRoles({ work, model: 'fixture', chat: async ({ prompt }) => {
    const body = prompt.split('编号原文】\n')[1];
    if (body.includes('1. 陈清') && body.includes('2. 林岚')) {
      errors += 1;
      return ok({ roles: [{ name: '任意姓名', status: 'present', evidence: [evidence(20, '原文中没有', 'name')] }] });
    }
    if (body.startsWith('1. 陈清')) return ok({ roles: [{ name: '陈清', status: 'present', evidence: [evidence(1, '陈清走到门口', 'presence')] }] });
    throw Error('HTTP 503');
  } }), /HTTP 503/);
  assert.ok(errors > 0);
  await runSceneRoles({ work, model: 'fixture', chat: async ({ prompt }) => {
    assert.match(prompt.split('编号原文】\n')[1], /^2\. 林岚/);
    return ok({ roles: [{ name: '林岚', status: 'present', evidence: [evidence(2, '林岚写完一封信', 'presence')] }] });
  } });
  assert.deepEqual(readSceneRoles(work).people.map(row => row.name), ['陈清', '林岚']);
});

test('场景尚未全书切完也能从同书原句检索身份，保留本场出场与跨场证据', async t => {
  const { runSceneRoles, readSceneRoles, sceneRoleCheckpoint } = await import('../analyzer/analysis/scene-roles.mjs');
  const { validateSceneRoleLayer } = await import('../analyzer/analysis/scene-role-evidence.mjs');
  const { loadBook, sentenceRows } = await import('../analyzer/analysis/files.mjs');
  const { work, partial } = fixture(t, [
    ['这位物理学教授走上讲台。'],
    ['物理学教授名叫叶哲泰。'],
    ['还有后续章节。'],
  ]);
  partial(2);
  let reviewed = 0, extracted = 0;
  const run = () => runSceneRoles({ work, model: 'fixture', chat: async ({ prompt }) => {
    if (prompt.includes('【待核对身份】')) {
      reviewed += 1;
      assert.match(prompt, /物理学教授名叫叶哲泰/);
      if (reviewed === 1) throw Error('HTTP 503');
      return ok({ links: [{ from: 'CH01', to: 'CH02', mentionSentence: 1, identitySentence: 2, quote: '物理学教授名叫叶哲泰' }] });
    }
    extracted += 1;
    if (prompt.includes('SC001')) return ok({ roles: [{ name: '', status: 'present', evidence: [
      evidence(1, '这位物理学教授', 'address'), evidence(1, '走上讲台', 'presence'),
    ] }] });
    return ok({ roles: [{ name: '叶哲泰', status: 'mentioned', evidence: [evidence(2, '叶哲泰', 'name')] }] });
  } });
  await assert.rejects(run(), /HTTP 503/);
  const paused = sceneRoleCheckpoint(work);
  assert.equal(paused.done, 2);
  assert.equal(paused.resumable, true);
  const result = await run();
  const doc = readSceneRoles(work);
  assert.equal(result.waiting, true);
  assert.equal(reviewed, 2);
  assert.equal(extracted, 2);
  assert.deepEqual(doc.scenes.map(scene => [scene.roles[0].roleId, scene.roles[0].status]), [['CH02', 'present'], ['CH02', 'mentioned']]);
  const [person] = doc.people;
  assert.equal(person.identityLinks[0].mention.sentence, 1);
  assert.deepEqual(person.identityLinks[0].proof, { sentence: 2, surface: '物理学教授名叫叶哲泰', start: 0, end: 10, kind: 'identity' });
  assert.deepEqual(person.aliases, []);
  const lines = new Map(sentenceRows(loadBook(work).book).map(row => [row.n, row]));
  validateSceneRoleLayer(doc, lines);
  const forged = structuredClone(doc);
  forged.people[0].identityLinks[0].proof.sentence = 3;
  assert.throws(() => validateSceneRoleLayer(forged, lines), /跨场身份/);
});

test('用十二组人工标注的小场景对照本书身份检索', async () => {
  const { retrieveIdentityCandidates } = await import('../analyzer/analysis/scene-role-retrieval.mjs');
  const cases = [
    { label: '红衣旅客', lines: ['红衣旅客就是林岚。'], match: 2 },
    { label: '那位红衣旅客', lines: ['红衣旅客名叫林岚。'], match: 2 },
    { label: '老先生', lines: ['林岚的绰号是老先生。'], match: 2 },
    { label: '红衣旅客', lines: ['红衣旅客原来是小岚。'], aliases: ['小岚'], match: 2 },
    { label: '红衣旅客', lines: ['红衣旅客就是林岚。'], prior: true, match: 1 },
    { label: '红衣旅客', lines: ['红衣旅客和林岚同行。'], match: 0 },
    { label: '父亲', lines: ['父亲名叫林岚。'], match: 0 },
    { label: '红衣旅客', lines: ['红衣旅客不一定就是林岚。'], match: 0 },
    { label: '红衣旅客', lines: ['听说红衣旅客就是林岚。'], match: 0 },
    { label: '红衣旅客', lines: ['红衣旅客就是林岚。', '红衣旅客就是周元。'], another: true, match: 0 },
    { label: '红衣旅客', lines: ['红衣旅客就是林岚。'], shared: true, match: 0 },
    { label: '红衣旅客', lines: ['红衣旅客就是林岚。'], through: 1, match: 0 },
  ];
  for (const [index, item] of cases.entries()) {
    const presence = item.label + '走进门。';
    const text = item.prior ? [...item.lines, presence] : [presence, ...item.lines];
    const n = item.prior ? 2 : 1;
    const source = { ...evidence(n, item.label, 'address'), start: 0, end: item.label.length };
    const people = [
      { id: 'CH01', name: '', label: item.label, aliases: [], evidence: [source] },
      { id: 'CH02', name: '林岚', aliases: item.aliases || [], evidence: [] },
    ];
    if (item.another) people.push({ id: 'CH03', name: '周元', aliases: [], evidence: [] });
    if (item.shared) people.push({ id: 'CH03', name: '', label: item.label, aliases: [], evidence: [source] });
    const rows = text.map((text, i) => ({ n: i + 1, text }));
    const found = retrieveIdentityCandidates(people, rows, item.through ?? text.length);
    assert.equal(found[0]?.identitySentence || 0, item.match, '场景对照 ' + (index + 1));
    if (item.match) {
      assert.equal(found[0].to, 'CH02');
      assert.deepEqual(retrieveIdentityCandidates(people, rows, text.length, { CH01: found[0].key }), []);
    }
  }
});

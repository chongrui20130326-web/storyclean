import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { test } from 'node:test';
import { createAnalyzerApp } from '../analyzer/server.mjs';
import { createLibrary } from '../analyzer/library.mjs';
import { analyzerModel, input, manuscript } from './fixtures/analyzer.mjs';

test('原版四页 API 在独立书库运行，保留清洗、编号、场景、角色与人称并完成工程回环', async t => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'analyzer-http-parity-'));
  const calls = [];
  const app = createAnalyzerApp({ dataDir: temporary, previousConfig: null, modelFactory: analyzerModel(calls) });
  await new Promise(resolve => app.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    await app.pauseJobs();
    app.closeAllConnections();
    await new Promise(resolve => app.close(resolve));
    fs.rmSync(temporary, { recursive: true, force: true });
  });
  const base = 'http://127.0.0.1:' + app.address().port;
  async function api(endpoint, body, method = body === undefined ? 'GET' : 'POST', expected = 200) {
    const response = await fetch(base + endpoint, {
      method, headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const output = await response.json();
    assert.equal(response.status, expected, output.error);
    return output;
  }
  const configuration = await api('/api/config');
  for (const stage of Object.values(configuration.stages)) stage.model = 'fixture-analyzer';
  await api('/api/config', { ...configuration, mentionMappingModel: 'fixture-mapper', apiKey: 'example-key-that-must-not-export' }, 'PUT');

  const clean = await api('/api/clean/run', input);
  assert.equal(clean.bookName, '星海纪事');
  assert.deepEqual(clean.cleanDoc.目录, ['序章', '《星海纪事》（第1章） 初航', '《星海纪事》（第2章） 归途']);
  assert.equal(clean.cleaningAudit.removedParagraphs[0].text, '最新网址https://example.com/');
  const number = await api('/api/number/run', { name: '星海纪事.txt', cleanDoc: clean.cleanDoc, cleanRunId: clean.runId });
  assert.deepEqual(number.doc.chapters.map(row => [row.id, row.from, row.to]), [['C1', 'S4', 'S5'], ['C2', 'S6', 'S8']]);
  await api('/api/number/import', { numbered: 'D:/external.json' }, 'POST', 404);
  const saved = await api('/api/number/import', { numbered: number.numbered, title: '星海纪事' });
  const query = '?id=' + encodeURIComponent(saved.id);
  const view = await api('/api/book/numbered' + query);
  assert.deepEqual(view.sentences, number.doc.sentences);
  const initial = await api('/api/book/export' + query);
  assert.deepEqual(initial.book.frontMatter.map(row => row.id), ['S1', 'S2', 'S3']);
  assert.equal(initial.scenes, null);
  assert.equal(initial.mentions, null);
  assert.equal(initial.offsets.sentences[0].id, 'S1');
  const startingPronouns = await api('/api/mention/sentence' + query + '&s=5');
  assert.ok(startingPronouns.mentions.some(m => m.text === '他'));
  await api('/api/mentions/mapping', { id: saved.id }, 'POST', 400);

  async function complete(route, progress, id = saved.id) {
    await api(route, { id });
    for (let i = 0; i < 100; i++) {
      const job = await api(progress + '?id=' + encodeURIComponent(id));
      if (!job.running) return job;
      await delay(20);
    }
    throw Error('后台任务未结束');
  }
  const scenesJob = await complete('/api/scenes/segment', '/api/scenes/progress');
  assert.equal(scenesJob.job.code, 0, scenesJob.job.error);
  const scenes = await api('/api/scenes/llm' + query);
  assert.equal(scenes.strategy, 'semantic-rolling');
  assert.deepEqual(scenes.scenes.map(s => [s.sceneId, s.from, s.to]), [['SC001', 'S4', 'S8']]);
  const work = createLibrary(temporary).location(saved.id).work;
  const l2 = path.join(work, 'l2');
  const finalScenes = path.join(l2, 'scenes-llm.json');
  fs.renameSync(finalScenes, finalScenes + '.fixture');
  fs.writeFileSync(path.join(l2, 'scenes.partial.jsonl'), JSON.stringify({ sceneId: 'SC001', from: 'S4', to: 'S5' }) + '\n');
  fs.writeFileSync(path.join(l2, 'scenes.progress.json'), JSON.stringify({ sourceHash: scenes.sourceHash }));
  const modelCalls = calls.length;
  const previewJob = await complete('/api/mentions/table', '/api/characters/progress');
  assert.equal(previewJob.code, 0, previewJob.error);
  assert.equal(calls.length, modelCalls);
  const preview = await api('/api/characters' + query);
  assert.equal(preview.mentionsReady, true);
  assert.equal(preview.mentionsPreview, true);
  assert.equal(preview.rosterReady, false);
  assert.ok(preview.mentions.some(m => m.surface === '他' && m.sceneId === 'SC001' && !m.characterId));
  assert.ok(preview.mentions.every(m => m.sentence <= 5));
  assert.equal((await api('/api/book/export' + query)).mentions, null);
  assert.equal((await api('/api/project/status' + query)).mentions, false);
  fs.renameSync(finalScenes + '.fixture', finalScenes);
  assert.equal((await api('/api/characters' + query)).mentionsReady, false);
  const rolesJob = await complete('/api/characters/table', '/api/characters/progress');
  assert.equal(rolesJob.code, 0, rolesJob.error);
  assert.equal(rolesJob.checkpoint.resumable, false);
  assert.deepEqual(rolesJob.checkpoint.people.map(row => row.name), ['林舟', '沈棠']);
  assert.deepEqual(rolesJob.checkpoint.scenes.map(scene => [scene.sceneId, scene.roles.map(row => row.status)]), [['SC001', ['present', 'present']]]);
  const mentionsJob = await complete('/api/mentions/table', '/api/characters/progress');
  assert.equal(mentionsJob.code, 0, mentionsJob.error);
  const roles = await api('/api/characters' + query);
  assert.equal(roles.mentionsReady, true);
  assert.equal(roles.mentionsPreview, false);
  assert.deepEqual(roles.characters.map(r => r.name), ['林舟', '沈棠']);
  assert.ok(roles.mentions.some(m => m.surface === '他' && m.sceneId === 'SC001' && !m.characterId));
  const mappingJob = await complete('/api/mentions/mapping', '/api/characters/progress');
  assert.equal(mappingJob.code, 0, mappingJob.error);
  assert.equal(mappingJob.mapping.complete, true);
  const mapped = await api('/api/characters' + query);
  assert.equal(mapped.mapping.model, 'fixture-mapper');
  assert.deepEqual(mapped.mentions.find(m => m.surface === '他' && m.sentence === 5).mapping.characterIds, ['CH01']);
  assert.equal((await api('/api/project/status' + query)).mapping, true);
  assert.ok(calls.some(row => row.prompt.includes('【场景 SC001 编号原文】')));
  assert.ok(calls.some(row => row.prompt.startsWith('角色表：')));
  const project = await api('/api/book/export' + query);
  assert.equal(project.version, 2);
  assert.doesNotMatch(JSON.stringify(project), /example-key-that-must-not-export/);
  assert.equal(project.source.base64, input.bytesBase64);
  assert.equal(project.sceneRoles.strategy, 'scene-evidence-v1');
  const proof = project.sceneRoles.scenes[0].roles[0].evidence.find(row => row.kind === 'name');
  assert.equal(proof.surface, '林舟');
  assert.equal(project.numbered.sentences.find(row => row.id === 'S' + proof.sentence).text.slice(proof.start, proof.end), '林舟');
  const files = await api('/api/book/files' + query);
  assert.ok(files.some(file => file.name === 'initial.json'));
  assert.ok(files.some(file => file.name === 'l2/scenes-llm.json' && file.bytes > 0));
  assert.ok(files.some(file => file.name === 'l2/mention-table.json'));
  assert.ok(files.some(file => file.name === 'l2/mention-mapping.json'));
  assert.ok(files.some(file => file.name === 'l2/scene-roles.progress.json'));
  assert.ok(!files.some(file => /config|log/i.test(file.name)));
  const sceneFile = '/api/book/file' + query + '&name=l2%2Fscenes-llm.json';
  const tree = await api(sceneFile + '&view=tree&pointer=%2Fscenes');
  assert.equal(tree.type, 'array');
  assert.equal(tree.total, project.scenes.scenes.length);
  assert.equal(tree.children[0].pointer, '/scenes/0');
  assert.equal(tree.children[0].type, 'object');
  const raw = await api(sceneFile + '&view=text');
  assert.deepEqual(JSON.parse(raw.text), project.scenes);
  const downloaded = await fetch(base + sceneFile + '&view=download');
  assert.equal(downloaded.status, 200);
  assert.match(downloaded.headers.get('content-disposition'), /scenes-llm\.json/);
  assert.equal(await downloaded.text(), raw.text);
  await api('/api/book/file' + query + '&name=..%2Fconfig.json', undefined, 'GET', 404);
  const imported = await api('/api/project/import', project);
  assert.notEqual(imported.id, saved.id);
  assert.deepEqual(await api('/api/book/export?id=' + encodeURIComponent(imported.id)), project);
  assert.equal(project.mentionMapping.phase, 'done');
  const forged = structuredClone(project);
  forged.sceneRoles.scenes[0].roles[0].evidence[0].start += 1;
  await api('/api/project/import', forged, 'POST', 400);
  if (process.env.ANALYZER_WRITE_EXAMPLE === '1') {
    fs.writeFileSync(new URL('../examples/星海纪事.txt', import.meta.url), manuscript);
    fs.writeFileSync(new URL('../examples/星海纪事.原版工程.json', import.meta.url), JSON.stringify(project, null, 2) + '\n');
  }
  project.mentions.mentions[0].start += 1;
  await api('/api/project/import', project, 'POST', 400);

  const longText = ['第一章 连续追踪', ...Array.from({ length: 52 }, (_, i) => ('连续追踪第' + (i + 1) + '步').padEnd(190, '雨') + '。')].join('\n');
  const longNumbered = await api('/api/number/run', { name: '连续追踪.txt', content: longText });
  const longBook = await api('/api/number/import', { numbered: longNumbered.numbered, title: '连续追踪' });
  const longJob = await complete('/api/scenes/segment', '/api/scenes/progress', longBook.id);
  assert.equal(longJob.job.code, 0, longJob.job.error);
  const longProject = await api('/api/book/export?id=' + encodeURIComponent(longBook.id));
  assert.equal(longProject.scenes.scenes.length, 1);
  assert.equal(longProject.scenes.scenes[0].sentences, 53);
  assert.ok(longProject.scenes.scenes[0].chars > 5000);
  const longCopy = await api('/api/project/import', longProject);
  assert.deepEqual((await api('/api/book/export?id=' + encodeURIComponent(longCopy.id))).scenes, longProject.scenes);
  const longQuery = '?id=' + encodeURIComponent(longBook.id);
  const verification = path.join(createLibrary(temporary).location(longBook.id).work, 'l2/segmentation.verify.json');
  const sceneCheck = JSON.parse(fs.readFileSync(verification, 'utf8'));
  fs.writeFileSync(verification, JSON.stringify({ ...sceneCheck, ok: false, errors: ['模型返回了范围外的切点 S999'] }));
  await complete('/api/mentions/table', '/api/characters/progress', longBook.id);
  assert.equal((await api('/api/scenes/progress' + longQuery)).error, '模型返回了范围外的切点 S999');
  assert.equal((await complete('/api/scenes/segment', '/api/scenes/progress', longBook.id)).error, '');
  const largeFile = '/api/book/file?id=' + encodeURIComponent(longBook.id) + '&name=initial.json&view=text';
  const first = await api(largeFile);
  assert.ok(first.pages > 1);
  let completeText = first.text;
  for (let page = 1; page < first.pages; page += 1) completeText += (await api(largeFile + '&page=' + page)).text;
  assert.equal(JSON.parse(completeText).source.text, longText);
});


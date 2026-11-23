import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

const secret = 'fixture-private-key';
const fixture = readFileSync(new URL('../examples/雾港来信.txt', import.meta.url));

async function listen(server) {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return 'http://127.0.0.1:' + server.address().port;
}

async function setup(t, answer, { model = 'fixture-model', configured = true } = {}) {
  const { createApp } = await import('../server.mjs');
  const dir = mkdtempSync(path.join(os.tmpdir(), 'novel-cleaning-'));
  const gateway = createServer(async (req, res) => {
    res.setHeader('content-type', 'application/json');
    if (req.headers.authorization !== 'Bearer ' + secret) {
      res.writeHead(401).end(JSON.stringify({ error: secret }));
      return;
    }
    if (req.url === '/v1/models') {
      res.end(JSON.stringify({ data: [{ id: model }] }));
      return;
    }
    let text = '';
    for await (const chunk of req) text += chunk;
    const request = JSON.parse(text);
    if (req.url !== '/v1/chat/completions' || request.model !== model || request.reasoning_effort !== 'none') {
      res.writeHead(400).end('{}');
      return;
    }
    const response = await answer(request.messages.at(-1).content, req, res);
    if (!response) return;
    res.end(JSON.stringify({
      choices: [{ finish_reason: response.finish || 'stop', message: { content: JSON.stringify(response.data) } }],
      usage: { prompt_tokens: 20, completion_tokens: 10, total_tokens: 30 },
    }));
  });
  const gatewayUrl = await listen(gateway) + '/v1';
  let server = createApp({ dataDir: dir });
  let address = await listen(server);
  const fetchHttp = globalThis.fetch;
  t.mock.method(globalThis, 'fetch', (resource, options) => {
    const origin = new URL(resource).origin;
    if (origin !== address && origin !== new URL(gatewayUrl).origin) throw Error('测试禁止依赖其他服务：' + origin);
    return fetchHttp(resource, options);
  });
  t.after(async () => {
    await server.pauseJobs();
    server.closeAllConnections();
    gateway.closeAllConnections();
    await Promise.all([new Promise(r => server.close(r)), new Promise(r => gateway.close(r))]);
    rmSync(dir, { recursive: true, force: true });
  });
  const request = async (api, method = 'GET', input, status = 200) => {
    const response = await fetch(address + api, {
      method,
      body: Buffer.isBuffer(input) ? input : input === undefined ? undefined : JSON.stringify(input),
      headers: input === undefined ? {} : { 'Content-Type': Buffer.isBuffer(input) ? 'application/octet-stream' : 'application/json' },
    });
    const content = await response.json();
    assert.equal(response.status, status, JSON.stringify(content.error));
    return content;
  };
  const config = await request('/api/config');
  config.gateway = gatewayUrl;
  config.apiKey = secret;
  if (configured) for (const s of Object.values(config.stages)) s.model = model;
  assert.doesNotMatch(JSON.stringify(await request('/api/config', 'PUT', config)), new RegExp(secret));
  assert.deepEqual(await request('/api/models'), [model]);
  const restartApp = async () => {
    await new Promise(resolve => server.close(resolve));
    server = createApp({ dataDir: dir });
    address = await listen(server);
  };
  return { request, dir, restartApp };
}

async function waitJob(request, book, route = 'job') {
  for (let i = 0; i < 250; i += 1) {
    const job = await request(book + '/' + route);
    if (!['running', 'stopping'].includes(job.status)) return job;
    await delay(20);
  }
  throw Error('任务迟迟没有进入终止状态');
}

test('一键保存草稿并完成工程，未配置时选用已验证的本地模型，完成后重复点击复用结果', async (t) => {
  let inference = 0;
  const { request } = await setup(t, async prompt => {
    inference += 1;
    if (prompt.includes('【角色真名】')) return { data: { characters: [{ name: '林舟', aliases: [] }, { name: '沈棠', aliases: [] }] } };
    return { data: { starts: [6] } };
  }, { model: 'qwen3.5:4b', configured: false });
  const entry = await request('/api/books?name=一键.txt', 'POST', fixture, 201);
  const book = '/api/books/' + entry.id;
  await request(book + '/process', 'POST', { revision: entry.revision, edits: { ...entry.edits, merges: [10] } }, 202);
  const done = await waitJob(request, book, 'process');
  assert.equal(done.status, 'complete', done.error);
  assert.equal(done.download, book + '/export');
  const project = await request(done.download);
  assert.equal(project.numbered.sentences.length, 8);
  assert.equal(project.scenes.provenance.model, 'qwen3.5:4b');
  assert.equal(project.characters.rows.length, 2);
  assert.equal(project.mentions.rows.length, 11);
  assert.equal((await request('/api/config')).stages.scenes.model, '');
  await request(book + '/process', 'POST', {}, 202);
  assert.equal((await waitJob(request, book, 'process')).status, 'complete');
  assert.equal(inference, 2);
});

test('一键流程暂停后重启应用，保留场景批次且不会继续跑角色', async (t) => {
  const starts = [];
  let block = true;
  let notify;
  const blocked = new Promise(resolve => { notify = resolve; });
  const { request, restartApp } = await setup(t, async prompt => {
    if (prompt.includes('【角色真名】')) return { data: { characters: [] } };
    const start = Number(prompt.match(/【本批待判句子：完整原文】\n(\d+)\./)?.[1]);
    starts.push(start);
    if (start > 1 && block) { notify(); return; }
    return { data: { starts: [] } };
  });
  const line = '雨'.repeat(1599) + '。';
  const entry = await request('/api/books?name=暂停.txt', 'POST', Buffer.from([line, line, line, line].join('\n')), 201);
  const book = '/api/books/' + entry.id;
  const start = await request(book + '/process', 'POST', {}, 202);
  await Promise.race([blocked, delay(3000, null, { ref: false }).then(() => { throw Error('第二批没有开始'); })]);
  await request(book + '/job', 'POST', { stage: 'characters' }, 409);
  await request(book + '/stop', 'POST', {}, 202);
  assert.equal((await waitJob(request, book, 'process')).status, 'paused');
  assert.equal((await request(book + '/job?stage=scenes')).cursor, 3);
  assert.equal((await request(book + '/export')).characters, null);
  block = false;
  await restartApp();
  assert.equal((await request(book + '/process', 'POST', {}, 202)).id, start.id);
  assert.equal((await waitJob(request, book, 'process')).status, 'complete');
  assert.deepEqual(starts, [1, 4, 4]);
});

test('独立 HTTP 全链路、截断重试、高亮资料和初始工程再导入', async (t) => {
  let sceneAttempts = 0;
  const { request } = await setup(t, async prompt => {
    if (prompt.includes('【目录校对】')) return { data: { title: { line: 1, title: '雾港来信' }, headings: [{ line: 6, title: '第一章 堤岸' }], bodyLines: [] } };
    if (prompt.includes('【正文复核】')) return { data: { remove: [], merge: [10] } };
    if (prompt.includes('【角色真名】')) return { data: { characters: [{ name: '沈棠', aliases: ['她'] }, { name: '林舟', aliases: ['他'] }] } };
    sceneAttempts += 1;
    if (sceneAttempts === 1) return { finish: 'length', data: { cuts: [] } };
    return { data: { checks: [{ cut: 5, next: 6, newScene: true, change: '时间' }] } };
  });
  let meta = await request('/api/books?name=sample.txt', 'POST', fixture, 201);
  const book = '/api/books/' + meta.id;
  for (const stage of ['structure', 'body']) {
    await request(book + '/job', 'POST', { stage }, 202);
    assert.equal((await waitJob(request, book)).status, 'complete');
  }
  assert.deepEqual((await request(book + '/view?kind=body')).rows, [{ line: 10, kind: 'merge', text: '并入上一正文行' }]);
  meta = await request(book);
  meta = await request(book + '/clean', 'PUT', {
    revision: meta.revision, edits: { ...meta.edits, merges: [10] }, adoptions: [{ stage: 'body', line: 10, kind: 'merge' }],
  });
  meta = await request(book + '/number', 'POST', { revision: meta.revision });
  assert.equal(meta.counts.sentences, 8);
  for (const stage of ['scenes', 'characters']) {
    await request(book + '/job', 'POST', { stage }, 202);
    assert.equal((await waitJob(request, book)).status, 'complete');
  }
  const log = await request(book + '/log');
  assert.equal(log.filter(row => row.stage === 'scenes' && row.finish === 'length').length, 1);
  assert.doesNotMatch(JSON.stringify(log), new RegExp(secret));
  meta = await request(book);
  await request(book + '/mentions', 'POST', { revision: meta.revision });
  const scenes = (await request(book + '/view?kind=scenes')).rows;
  assert.deepEqual(scenes.map(s => [s.sceneId, s.from, s.to]), [['SC001', 'S1', 'S5'], ['SC002', 'S6', 'S8']]);
  const lines = (await request(book + '/view?kind=scene&scene=SC001')).rows;
  assert.ok(lines[1].mentions.some(m => m.surface === '你' && m.characterId === '' && m.inDialog));
  const project = await request(book + '/export');
  const { parseCorpusFile } = await import('./fixtures/upstream-corpus/corpusImport.mjs');
  const bridge = await request(book + '/corpus');
  const oldBook = parseCorpusFile(JSON.stringify(bridge), 'bridge.json');
  assert.equal(oldBook.title, project.clean.title);
  assert.deepEqual(oldBook.chapters.flatMap(c => c.paragraphs.map(p => p.sourceId)), ['P1', 'P2', 'P3', 'P4', 'P5']);
  assert.equal(oldBook.chapters.flatMap(c => c.paragraphs.map(p => p.text)).join('\n'), project.clean.body);
  assert.equal(project.cleanReviews[0].line, 10);
  assert.equal(project.cleanReviews[0].provenance.model, 'fixture-model');
  assert.doesNotMatch(JSON.stringify(project), new RegExp(secret));
  const copy = await request('/api/books?name=project.json', 'POST', Buffer.from(JSON.stringify(project)), 201);
  assert.notEqual(copy.id, meta.id);
  assert.deepEqual(await request('/api/books/' + copy.id + '/export'), project);
  const corrupt = structuredClone(project);
  corrupt.mentions.rows[0].start += 1;
  await request('/api/books?name=invalid.json', 'POST', Buffer.from(JSON.stringify(corrupt)), 400);
  if (process.env.NOVEL_WRITE_EXAMPLE === '1') {
    writeFileSync(new URL('../examples/雾港来信.project.json', import.meta.url), JSON.stringify(project, null, 2) + '\n');
  }
  meta = await request(book);
  const updated = await request(book + '/clean', 'PUT', { revision: meta.revision, edits: { ...meta.edits, title: '改题' } });
  assert.equal(updated.counts.sentences, null);
  assert.equal(updated.counts.scenes, null);
  assert.ok(updated.backups >= 1);
  const backups = await request(book + '/backups');
  assert.deepEqual(await request(book + '/backup?revision=' + backups[0]), project);
  await request(book + '/number', 'POST', { revision: meta.revision }, 409);
});

test('故障后重启并从已提交批次续跑，场景连续且不会被输入批边界切开', async (t) => {
  let failures = true;
  const seen = [];
  const { request, restartApp } = await setup(t, async (prompt, _req, res) => {
    const start = Number(prompt.match(/【本批待判句子：完整原文】\n(\d+)\./)?.[1]);
    seen.push(start);
    if (start > 1 && failures) {
      res.writeHead(503).end(JSON.stringify({ error: secret }));
      return;
    }
    return { data: { checks: [] } };
  });
  const a = '雨'.repeat(1599) + '。';
  const manuscript = Buffer.from([a, a, a, '潮'.repeat(799) + '。', '船靠岸了。'].join('\n'));
  let meta = await request('/api/books?name=长场.txt', 'POST', manuscript, 201);
  const book = '/api/books/' + meta.id;
  await request(book + '/number', 'POST', { revision: meta.revision });
  await request(book + '/job', 'POST', { stage: 'scenes' }, 202);
  const failed = await waitJob(request, book);
  assert.equal(failed.status, 'failed');
  assert.equal(failed.cursor, 3);
  assert.match(failed.error, /503/);
  assert.equal((await request(book + '/export')).scenes, null);
  assert.equal((await request(book + '/view?kind=partial')).rows[0].to, 'S3');
  failures = false;
  await restartApp();
  await request(book + '/job', 'POST', { stage: 'scenes' }, 202);
  assert.equal((await waitJob(request, book)).status, 'complete');
  assert.equal(seen.filter(n => n === 1).length, 1);
  const project = await request(book + '/export');
  assert.deepEqual(project.scenes.cuts, []);
  assert.deepEqual(project.scenes.rows.map(s => [s.from, s.to, s.boundary]), [
    ['S1', 'S2', 'length-limit'], ['S3', 'S5', 'end'],
  ]);
});

test('停止请求关闭在途模型调用，另一本书可编辑，同书拒绝并发写入', async (t) => {
  let accept = false;
  let called;
  const pending = new Promise(r => { called = r; });
  const { request } = await setup(t, async () => {
    if (accept) return { data: { checks: [] } };
    called();
  });
  const meta = await request('/api/books?name=停止.txt', 'POST', fixture, 201);
  const book = '/api/books/' + meta.id;
  const numbered = await request(book + '/number', 'POST', { revision: meta.revision });
  await request(book + '/job', 'POST', { stage: 'scenes' }, 202);
  await pending;
  await request(book + '/number', 'POST', { revision: numbered.revision }, 409);
  await request('/api/books?name=另一本.txt', 'POST', fixture, 201);
  await request(book + '/stop', 'POST', {}, 202);
  assert.equal((await waitJob(request, book)).status, 'paused');
  accept = true;
  await request(book + '/job', 'POST', { stage: 'scenes' }, 202);
  assert.equal((await waitJob(request, book)).status, 'complete');
});


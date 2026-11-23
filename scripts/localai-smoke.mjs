import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';
import os from 'node:os';
import path from 'node:path';
import { createApp } from '../server.mjs';

const model = process.argv[2];
if (!model) {
  console.error('用法：node scripts/localai-smoke.mjs <本地模型 ID>');
  process.exit(1);
}
const dir = mkdtempSync(path.join(os.tmpdir(), 'novel-localai-smoke-'));
const server = createApp({ dataDir: dir });
await new Promise((resolve, reject) => server.once('error', reject).listen(0, '127.0.0.1', resolve));
const url = 'http://127.0.0.1:' + server.address().port;
const realFetch = globalThis.fetch;
const fixture = readFileSync(new URL('../examples/雾港来信.txt', import.meta.url));
let modelRequests = 0;
let book;
const stopAt = Date.now() + 75_000;
const limit = process.argv.includes('--diagnostic') ? 1 : 4;

// This opt-in smoke test sends only the frozen sample and allows at most four inference requests.
globalThis.fetch = (input, options) => {
  const target = String(input);
  if (target === 'http://127.0.0.1:8090/v1/chat/completions') {
    if (Date.now() >= stopAt || modelRequests >= limit) throw Error('冒烟测试请求达到上限');
    modelRequests += 1;
    if (limit === 1) return realFetch(input, options).then(async response => {
      const data = await response.clone().json();
      const choice = data.choices?.[0];
      console.log('网关诊断', JSON.stringify({ status: response.status, finish: choice?.finish_reason,
        content: String(choice?.message?.content || '').slice(0, 600), usage: data.usage }));
      return response;
    });
  }
  return realFetch(input, options);
};

async function api(endpoint, method = 'GET', value) {
  const binary = Buffer.isBuffer(value);
  const res = await realFetch(url + endpoint, {
    method, headers: { 'Content-Type': binary ? 'application/octet-stream' : 'application/json' },
    body: value === undefined ? undefined : binary ? value : JSON.stringify(value),
  });
  const data = await res.json();
  if (!res.ok) throw Error(data.error);
  return data;
}

async function run(stage, book) {
  await api(book + '/job', 'POST', { stage });
  while (Date.now() < stopAt) {
    const job = await api(book + '/job');
    if (job.status === 'complete') {
      console.log(stage, JSON.stringify({ checked: job.cursor, requests: job.requests, usage: job.usage, elapsedMs: job.elapsedMs }));
      return;
    }
    if (job.status === 'failed') throw Error(stage + '：' + job.error);
    await delay(180);
  }
  throw Error('真实网关冒烟测试达到 75 秒总时限');
}

try {
  const config = await api('/api/config');
  config.timeoutMs = 32000;
  config.maxTokens = 2500;
  config.stages.scenes.model = model;
  config.stages.characters.model = model;
  await api('/api/config', 'PUT', config);
  assert.ok((await api('/api/models')).includes(model), '网关模型列表中没有指定模型');
  const entry = await api('/api/books?name=fixture.txt', 'POST', fixture);
  book = '/api/books/' + entry.id;
  const meta = await api(book + '/clean', 'PUT', { revision: entry.revision, edits: { ...entry.edits, merges: [10] } });
  await api(book + '/number', 'POST', { revision: meta.revision });
  await run('scenes', book);
  await run('characters', book);
  const ready = await api(book);
  await api(book + '/mentions', 'POST', { revision: ready.revision });
  const document = await api(book + '/export');
  assert.equal(document.numbered.sentences.length, 8);
  assert.deepEqual(document.characters.rows.map(r => r.name).sort(), ['林舟', '沈棠']);
  assert.deepEqual(document.scenes.cuts, [5]);
  assert.equal(document.scenes.rows.at(-1).to, 'S8');
  const copy = await api('/api/books?name=roundtrip.json', 'POST', Buffer.from(JSON.stringify(document)));
  assert.deepEqual(document, await api('/api/books/' + copy.id + '/export'));
  console.log(JSON.stringify({ model, modelRequests, counts: { sentences: 8, scenes: document.scenes.rows.length,
    characters: document.characters.rows.length, mentions: document.mentions.rows.length }, roundTrip: true }));
} catch (error) {
  console.error(error.message + '（真实推理请求 ' + modelRequests + ' 次）');
  if (book) {
    const log = await api(book + '/log').catch(() => []);
    console.error(JSON.stringify(log.map(({ stage, finish, error, usage }) => ({ stage, finish, error, usage }))));
  }
  process.exitCode = 1;
} finally {
  globalThis.fetch = realFetch;
  await server.pauseJobs();
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
  rmSync(dir, { recursive: true, force: true });
}


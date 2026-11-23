import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import { createServer } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createCleanNumberTool } from '../analyzer/tools/clean-number/service.mjs';
import { runSceneSegmentation, runCharacterTable, runMentions } from '../analyzer/analysis/index.mjs';
import { analyzerModel, input } from '../test/fixtures/analyzer.mjs';

const originalRoot = path.resolve(process.argv[2] || path.join('..', 'corpus-kit-1.8.1-20261117213259'));
const originalService = await import(pathToFileURL(path.join(originalRoot, 'tools/clean-number/service.mjs')));
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'novel-analyzer-comparison-'));
const read = file => JSON.parse(fs.readFileSync(file, 'utf8'));
const model = 'fixture-analyzer';
const originalCalls = [];
const currentCalls = [];
const originalMock = analyzerModel(originalCalls)({ model });
const currentMock = analyzerModel(currentCalls)({ model });

const consoleStub = createServer(async (req, res) => {
  try {
    assert.equal(req.url, '/api/console/chat');
    let text = '';
    for await (const chunk of req) text += chunk;
    const request = JSON.parse(text);
    if (request.source === 'lib-llm') request.source = 'build-character-table.mjs';
    const response = await originalMock.chat(request);
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify(response));
  } catch (error) {
    res.writeHead(400).end(JSON.stringify({ ok: false, error: error.message }));
  }
});

async function runOriginal(file, args) {
  const root = 'http://127.0.0.1:' + consoleStub.address().port;
  await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(originalRoot, 'tools', file), ...args], {
      cwd: temp, env: { ...process.env, CORPUS_ROOT: path.join(temp, 'isolated-original-config'), CONSOLE_URL: root, CORPUS_MODEL: model, STORAGE: 'json' },
      stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
    });
    let output = '';
    child.stdout.on('data', chunk => { output += chunk; });
    child.stderr.on('data', chunk => { output += chunk; });
    const timer = setTimeout(() => child.kill(), 10000);
    child.on('error', error => { clearTimeout(timer); reject(error); });
    child.on('exit', code => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else reject(Error(file + '：' + output.slice(-600)));
    });
  });
}

try {
  await new Promise(resolve => consoleStub.listen(0, '127.0.0.1', resolve));
  const legacy = originalService.createCleanNumberTool({ root: path.join(temp, 'original'), modelConsole: originalMock });
  const current = createCleanNumberTool({ root: path.join(temp, 'standalone'), modelConsole: currentMock });
  const [before, after] = await Promise.all([legacy.clean({ ...input, model }), current.clean({ ...input, model })]);
  const comparable = ({ summary, ...result }) => ({ ...result, stats: summary.stats });
  assert.deepEqual(comparable(after), comparable(before));
  const a = legacy.number({ name: '星海纪事.txt', cleanDoc: before.cleanDoc });
  const b = current.number({ name: '星海纪事.txt', cleanDoc: after.cleanDoc });
  const stableNumbered = file => { const { generatedAt, ...doc } = read(file); return doc; };
  assert.deepEqual(stableNumbered(b.numbered), stableNumbered(a.numbered));
  const original = legacy.importNumbered({ numbered: a.numbered, title: '星海纪事' }).work;
  const standalone = current.importNumbered({ numbered: b.numbered, title: '星海纪事' }).work;
  assert.deepEqual(read(path.join(standalone, 'book.json')), read(path.join(original, 'book.json')));
  assert.deepEqual(read(path.join(standalone, 'l2/mention-table.json')), read(path.join(original, 'l2/mention-table.json')));

  await runOriginal('segment-scenes-llm.mjs', [path.join(original, 'book.json'), path.join(original, 'l2/scenes-llm.json')]);
  const scenes = await runSceneSegmentation({ work: standalone, model, chat: currentMock.chat });
  const originalScenes = read(path.join(original, 'l2/scenes-llm.json')).scenes;
  assert.deepEqual(originalScenes.map(s => [s.from, s.to]), [['S4', 'S5'], ['S6', 'S8']]);
  assert.deepEqual(scenes.scenes.map(s => [s.from, s.to]), [['S4', 'S8']]);
  // Hold the scene input constant for the lexical scanner comparison.
  fs.writeFileSync(path.join(original, 'l2/scenes-llm.json'), JSON.stringify(scenes));

  await runOriginal('build-character-table.mjs', [original]);
  const names = await runCharacterTable({ work: standalone, model, chat: currentMock.chat });
  assert.deepEqual(names.characters.map(({ evidence, ...role }) => role), read(path.join(original, 'l2/characters.json')).characters);
  assert.deepEqual(read(path.join(standalone, 'l2/relations.json')).relations, read(path.join(original, 'l2/relations.json')).relations);
  await runOriginal('build-mention-table.mjs', [original]);
  const mentions = runMentions({ work: standalone });
  const originalMentions = read(path.join(original, 'l2/mention-table.json'));
  assert.deepEqual(mentions.mentions, originalMentions.mentions);
  assert.deepEqual(mentions.totals, originalMentions.totals);
  console.log(JSON.stringify({ cleaning: 'equal', numbering: 'equal', originalBook: 'equal', originalScenes: originalScenes.length,
    rollingScenes: scenes.scenes.length, characters: names.characters.length, mentions: mentions.mentions.length }));
} finally {
  consoleStub.closeAllConnections();
  await new Promise(resolve => consoleStub.close(resolve));
  fs.rmSync(temp, { recursive: true, force: true });
}


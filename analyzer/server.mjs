import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createServer } from 'node:http';
import { defaultConfig, publicConfig, updateConfig } from '../lib/gateway.mjs';
import { importProject as previousImport } from '../lib/project.mjs';
import { HttpError } from '../lib/storage.mjs';
import { writeJsonAtomic } from './core/atomic-json.mjs';
import { getTemplate, originalPrompts, withTemplates } from './core/prompt-templates.mjs';
import { createCleanNumberTool } from './tools/clean-number/service.mjs';
import { runSceneSegmentation, runMentions } from './analysis/index.mjs';
import { mentionPreviewFile } from './analysis/mentions.mjs';
import { mappingSummary, readMentionMapping, runMentionMappings } from './analysis/mention-mappings.mjs';
import { characterCheckpoint } from './analysis/characters.mjs';
import { readRoleSceneRanges, readSceneRoles, repairSceneRoleFiles, runSceneRoles, sceneRoleCheckpoint } from './analysis/scene-roles.mjs';
import { SCENE_ROLE_STRATEGY } from './analysis/scene-role-evidence.mjs';
import { MIN_SCENE_SENTENCES, ROLLING_SCENE_STRATEGY } from './analysis/scene-boundaries.mjs';
import { createModelConsole, fallbackModel, inheritedCleanModel, listModels, resolveModel } from './model.mjs';
import { createFileViewer } from './file-view.mjs';
import { bookId, createLibrary, fileName, nestedSentences, projectCap, readJson, readProject, readSource, sentenceNumber, sha256, validateProject } from './library.mjs';

const here = fileURLToPath(new URL('./', import.meta.url));
const defaultData = path.resolve(here, '../data/analyzer');
const MiB = 1024 * 1024;
const assets = new Map([
  ['/', ['ui/index.html', 'text/html']],
  ['/app.js', ['ui/app.js', 'text/javascript']],
  ['/controls.js', ['ui/controls.js', 'text/javascript']],
  ['/file-view.js', ['ui/file-view.js', 'text/javascript']],
  ['/style.css', ['ui/style.css', 'text/css']],
  ['/novel-encoding.js', ['tools/clean-number/clean-core/encoding.mjs', 'text/javascript']],
]);
const taskRoutes = new Map([
  ['/api/scenes/segment', 'scenes'], ['/api/characters/table', 'table'], ['/api/mentions/table', 'mentions'],
  ['/api/mentions/mapping', 'mapping'],
]);
const layers = { scenes: 'scenes-llm.json', characters: 'characters.json', mentions: 'mention-table.json', relations: 'relations.json' };
const layer = (work, name, initial = null) => readJson(path.join(work, 'l2', layers[name] || name), initial);
const dictionary = document => JSON.stringify(document?.characters.map(({ id, name, aliases }) => [id, name, [...aliases].sort()]));

function modelSetting(value, label) {
  if (typeof value !== 'string' || value.length > 250 || /[\x00-\x1f]/.test(value)) throw new HttpError(400, label + ' ID 无效');
  return value.trim();
}

function roleRetrieval(config, signal) {
  if (!config.roleEmbeddingModel) return undefined;
  return {
    model: config.roleEmbeddingModel,
    key: sha256(JSON.stringify([config.gateway, config.roleEmbeddingModel])),
    async load() {
      const { createRoleEmbeddings } = await import('./analysis/role-hybrid-search.mjs');
      return createRoleEmbeddings(config, signal);
    },
  };
}

function send(res, value, status = 200) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' }).end(JSON.stringify(value));
}

async function inputBytes(req, limit) {
  if (Number(req.headers['content-length']) > limit) throw new HttpError(413, '文件超过大小上限');
  const chunks = [];
  let size = 0;
  for await (const chunk of req.iterator({ destroyOnReturn: false })) {
    size += chunk.length;
    if (size > limit) {
      req.resume();
      throw new HttpError(413, '文件超过大小上限');
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks, size);
}

function json(raw) {
  let value;
  try { value = raw.length ? JSON.parse(raw.toString('utf8').replace(/^\uFEFF/, '')) : {}; }
  catch { throw new HttpError(400, '输入不是有效的 JSON'); }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new HttpError(400, '输入须为 JSON 对象');
  return value;
}

function download(res, name, document) {
  const text = JSON.stringify(document);
  if (Buffer.byteLength(text) > projectCap) throw new HttpError(413, '工程超过大小上限');
  const encoded = encodeURIComponent(name).replace(/['()]/g, ch => '%' + ch.charCodeAt(0).toString(16));
  res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8',
    'Content-Disposition': "attachment; filename*=UTF-8''" + encoded }).end(text);
}

function attachSceneText(book, scenes, forRoles) {
  const bySentence = new Map(nestedSentences(book).map(s => [sentenceNumber(s), s.text]));
  return scenes.map(scene => {
    const lines = [];
    for (let i = Number(scene.from.slice(1)); i <= Number(scene.to.slice(1)); i += 1) {
      if (bySentence.has(i)) lines.push({ n: i, text: bySentence.get(i) });
    }
    if (forRoles) return { ...scene, text: lines };
    const text = lines.map(line => line.text).join('\n');
    return { ...scene, text, lines, preview: text.slice(0, 60) };
  });
}

function roleData(work) {
  const ranges = readRoleSceneRanges(work);
  const checkpoint = sceneRoleCheckpoint(work, ranges);
  const existing = layer(work, 'characters');
  const rosterReady = Boolean(existing && (!checkpoint.started || (!checkpoint.stale && ranges.complete
    && checkpoint.rosterReady && existing.strategy === SCENE_ROLE_STRATEGY)));
  if (rosterReady && ranges.complete) return { ranges, existing, rosterReady, preview: null };
  const characters = checkpoint.stale ? [] : checkpoint.people.filter(row => row.name);
  const key = sha256(JSON.stringify([ranges.sourceHash, ranges.complete,
    ranges.scenes.map(({ sceneId, from, to }) => [sceneId, from, to]), dictionary({ characters })]));
  const preview = { sourceHash: ranges.sourceHash, scenes: ranges.scenes, characters, key };
  return { ranges, existing, rosterReady, preview };
}

function mappingLayers(work, data = roleData(work), table = layer(work, 'mentions')) {
  const ready = data.rosterReady && data.ranges.complete && table?.method;
  return { scenes: data.ranges.complete ? { scenes: data.ranges.scenes, sourceHash: data.ranges.sourceHash } : null,
    characters: ready ? data.existing : null, mentions: ready ? table : null, sceneRoles: ready ? readSceneRoles(work) : null };
}

function attachCharacters({ work, book }) {
  const data = roleData(work);
  const { ranges, existing, rosterReady, preview } = data;
  const characters = rosterReady ? existing.characters : [];
  const relations = rosterReady ? layer(work, 'relations')?.relations ?? [] : [];
  const sourceScenes = ranges.scenes;
  const table = layer(work, preview ? mentionPreviewFile : 'mentions');
  const mentionsReady = Boolean(table?.method && (!preview || (preview.scenes.length && table.previewKey === preview.key)));
  const { document, stale } = readMentionMapping(work, mappingLayers(work, data, table));
  const mapped = new Map((document?.scenes || []).flatMap(scene => scene.results.map(result => [result.mentionId, result])));
  const nameOf = new Map((preview?.characters || characters).map(row => [row.id, row.name]));
  const sceneOf = new Map();
  for (const s of sourceScenes) {
    for (let i = Number(s.from.slice(1)); i <= Number(s.to.slice(1)); i += 1) sceneOf.set(i, s.sceneId);
  }
  const mentions = (mentionsReady ? table.mentions : []).map(m => ({
    ...m, sceneId: sceneOf.get(m.sentence) || '', characterId: nameOf.has(m.characterId) ? m.characterId : '',
    name: nameOf.get(m.characterId) || '', inDialog: Boolean(m.inDialog),
    ...(mapped.has(m.id) && { mapping: mapped.get(m.id) }),
  }));
  const resolved = mentions.filter(m => m.characterId).length;
  return {
    characters, relations, mentions, mentionsReady, mentionsPreview: mentionsReady && Boolean(preview), rosterReady,
    scenes: attachSceneText(book, sourceScenes, true), scenesTotal: sourceScenes.length,
    scenesPartial: !ranges.complete && sourceScenes.length > 0,
    mapping: mappingSummary(document, sourceScenes.length, stale),
    doneScenes: [], totals: { characters: characters.length, mentions: mentions.length, resolved, unresolved: mentions.length - resolved },
  };
}

function partialScenes(work) {
  const file = path.join(work, 'l2', 'scenes.partial.jsonl');
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8').split('\n').filter(line => line.trim()).map(line => JSON.parse(line));
}

function assignMentionsToScenes(work) {
  const table = layer(work, 'mentions');
  if (!table?.method) return;
  const scenes = layer(work, 'scenes')?.scenes ?? [];
  const bySentence = new Map();
  for (const s of scenes) {
    for (let i = Number(s.from.slice(1)); i <= Number(s.to.slice(1)); i += 1) bySentence.set(i, s.sceneId);
  }
  const mentions = table.mentions.map(m => ({ ...m, sceneId: bySentence.get(m.sentence) || '' }));
  writeJsonAtomic(path.join(work, 'l2', layers.mentions), { ...table, mentions }, 0);
}

export function createAnalyzerApp({ dataDir = defaultData, previousConfig = path.resolve(here, '../data/config.json'),
  modelFactory = createModelConsole } = {}) {
  const library = createLibrary(dataDir);
  for (const record of library.list()) repairSceneRoleFiles(library.location(record.id).work);
  const viewer = createFileViewer();
  const configPath = path.join(library.root, 'config.json');
  const readConfig = () => readJson(configPath) || (previousConfig ? readJson(previousConfig) : null) || defaultConfig();
  const settings = () => {
    const config = readConfig();
    return { ...publicConfig(config), automaticModel: fallbackModel, inheritedCleanModel: inheritedCleanModel(config),
      roleEmbeddingModel: config.roleEmbeddingModel || '', mentionMappingModel: config.mentionMappingModel || '',
      templates: { ...originalPrompts(), ...config.templates } };
  };
  const active = new Map();
  const last = new Map();
  const cleanJobs = new Set();
  const creationLog = path.join(library.root, 'model.log.jsonl');
  const lockFor = id => active.get(id.toLowerCase());
  const assertIdle = id => {
    if (lockFor(id)) throw new HttpError(409, '这本书正在处理，请等待或先停止任务');
  };
  const context = (stage, config, signal) => resolveModel(config, stage, signal)
    .then(model => ({ model, console: modelFactory({ config, model, signal, logFile: creationLog }) }));

  function begin(entry, step, options = {}) {
    const { id, work } = entry;
    assertIdle(id);
    if (step === 'table' && !readRoleSceneRanges(work).scenes.length) throw new HttpError(400, '请先到第 3 步切分出至少一个场景');
    const mentionInputs = step === 'mentions' ? roleData(work) : null;
    if (mentionInputs && !mentionInputs.ranges.scenes.length) throw new HttpError(400, '请先到第 3 步切分出至少一个场景');
    const mappingInputs = step === 'mapping' ? mappingLayers(work) : null;
    if (mappingInputs && (!mappingInputs.mentions || !mappingInputs.characters?.characters.length)) {
      throw new HttpError(400, '请先生成角色真名表和正式的场景内人称表');
    }
    const sentenceCount = step === 'scenes' ? nestedSentences(entry.book).length : null;
    if (sentenceCount === 0) {
      throw new HttpError(400, '原版编号没有识别到章节正文。请先从「小说清洗」识别目录后再保存并编号。');
    }
    const group = step === 'scenes' ? 'scenes' : 'roles';
    if ([...active.values()].some(task => task.group === group)) throw new HttpError(409, '已有同类任务正在运行');
    const config = readConfig();
    const reviewOnly = step === 'table' && options.reviewOnly === true;
    if (reviewOnly && !config.roleEmbeddingModel) throw new HttpError(400, '请在模型设置中填写向量模型 ID');
    const controller = new AbortController();
    const { signal } = controller;
    const job = { bookId: id, running: true, step, reviewOnly, phase: step === 'scenes' ? 'segment' : step, startedAt: new Date().toISOString(), code: null };
    const task = { controller, job, group, done: null };
    active.set(id.toLowerCase(), task);
    last.set(id, job);
    task.done = Promise.resolve().then(async () => {
      try {
        if (step === 'mentions') {
          const table = runMentions({ work, preview: mentionInputs.preview });
          job.totals = table.totals;
        } else if (step === 'mapping') {
          const model = config.mentionMappingModel || await resolveModel(config, 'characters', signal);
          const client = modelFactory({ config, model, signal, logFile: creationLog });
          await runMentionMappings({ work, layers: mappingInputs, model, chat: client.chat, signal, retrieval: roleRetrieval(config, signal),
            guidance: config.templates?.mentionMapping || getTemplate('mentionMapping'), restart: options.restart === true,
            onProgress: progress => { job.mapping = progress; } });
        } else {
          const needsModel = step !== 'scenes' || sentenceCount >= 2 * MIN_SCENE_SENTENCES;
          const { model, console: client } = needsModel
            ? await context(step === 'scenes' ? 'scenes' : 'characters', config, signal)
            : { model: '', console: null };
          await withTemplates(config.templates, async () => {
            const onProgress = progress => {
              const elapsedSeconds = Math.round(progress.elapsedMs / 1000);
              const averageSeconds = progress.done ? Math.round(elapsedSeconds / progress.done * 10) / 10 : null;
              Object.assign(job, { done: progress.done, total: progress.total, elapsedSeconds, averageSeconds,
                etaSeconds: averageSeconds === null ? null : Math.round((progress.total - progress.done) * averageSeconds) });
            };
            if (step === 'scenes') {
              try {
                await runSceneSegmentation({ work, model, chat: client?.chat, signal, template: getTemplate('segment'), resume: options.resume !== false, onProgress });
              } finally {
                assignMentionsToScenes(work);
              }
            } else {
              const previous = layer(work, 'characters');
              try {
                const result = await runSceneRoles({ work, model, chat: client.chat, signal, resume: options.resume !== false, reviewOnly,
                  retrieval: roleRetrieval(config, signal), onProgress });
                job.waiting = result.waiting;
              } finally {
                // The scanner's role IDs describe the name table it read when it ran.
                const changed = dictionary(previous) !== dictionary(layer(work, 'characters'));
                const file = path.join(work, 'l2', layers.mentions);
                if (changed && layer(work, 'mentions')?.method) {
                  fs.copyFileSync(file, file + '.bak-' + Date.now());
                  const pronouns = readJson(path.join(work, 'number-mentions.json'));
                  if (pronouns) writeJsonAtomic(file, pronouns, 0);
                  else fs.rmSync(file, { force: true });
                }
              }
            }
          });
        }
        job.phase = job.waiting ? 'waiting-scenes' : 'done';
        job.code = 0;
      } catch (error) {
        job.phase = signal.aborted ? 'stopped' : 'failed';
        job.error = signal.aborted ? '已停止，先前保存的批次可续跑' : error.message;
        job.code = 1;
        if (step === 'scenes' && !signal.aborted) {
          try {
            const file = 'segmentation.verify.json';
            const report = layer(work, file);
            if (report?.ok !== false || report.checkedAt < job.startedAt || report.errors?.[0] !== job.error) {
              writeJsonAtomic(path.join(work, 'l2', file), { ok: false, checkedAt: new Date().toISOString(), errors: [job.error] });
            }
          } catch { /* Keep the live job error available even when diagnostics cannot be saved. */ }
        }
      } finally {
        job.running = false;
        job.endedAt = new Date().toISOString();
        active.delete(id.toLowerCase());
      }
    });
    return { ok: true, started: true, bookId: id, step };
  }

  function sceneStats(entry) {
    const progress = layer(entry.work, 'scenes.progress.json', {});
    const finished = layer(entry.work, 'scenes');
    const job = last.get(entry.id)?.step === 'scenes' ? last.get(entry.id) : null;
    const check = job ? null : layer(entry.work, 'segmentation.verify.json');
    const savedError = check?.ok === false && !check.stopped ? check.errors?.[0] : '';
    const error = job?.phase === 'failed' ? job.error : savedError === '已停止' ? '' : savedError || '';
    const sentences = nestedSentences(entry.book);
    const total = sentences.length;
    const done = finished ? total : Number(progress.cursor || 0);
    return { done, total, percent: total ? Math.round(100 * done / total) : 0,
      chaptersDone: (progress.chapters || []).length, chaptersTotal: entry.book.chapters.length,
      nextSentence: !finished && sentences[progress.nextAt] ? 'S' + sentenceNumber(sentences[progress.nextAt]) : null,
      running: Boolean(job?.running), job, error, doneFile: Boolean(finished) };
  }

  const server = createServer(async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; object-src 'none'");
    try {
      const host = req.headers.host || '';
      if (!/^(?:localhost|127\.0\.0\.1)(?::\d+)?$/i.test(host) || (req.headers.origin && req.headers.origin !== 'http://' + host)) {
        throw new HttpError(403, '服务只接受本机同源访问');
      }
      const url = new URL(req.url, 'http://' + host);
      const route = url.pathname;
      const method = req.method;
      const id = url.searchParams.get('id') || '';
      if (method === 'GET' && assets.has(route)) {
        const [file, type] = assets.get(route);
        res.writeHead(200, { 'Content-Type': type + '; charset=utf-8' }).end(fs.readFileSync(path.join(here, file)));
        return;
      }
      if (method === 'GET' && route === '/api/books') return send(res, library.list());
      if (method === 'GET' && route === '/api/config') return send(res, settings());
      if (method === 'GET' && route === '/api/models') return send(res, await listModels(readConfig()));
      if (method === 'POST' && route === '/api/models/embedding-test') {
        const input = json(await inputBytes(req, MiB));
        const stored = readConfig();
        const model = modelSetting(input.model ?? stored.roleEmbeddingModel ?? '', '向量模型');
        if (!model) throw new HttpError(400, '请先填写向量模型 ID');
        try {
          const { checkRoleEmbeddings } = await import('./analysis/role-hybrid-search.mjs');
          const embedding = await roleRetrieval({ ...stored, roleEmbeddingModel: model }, AbortSignal.timeout(25000)).load();
          return send(res, { ok: true, ...await checkRoleEmbeddings(embedding) });
        } catch (error) {
          const suffix = Number.isInteger(error.status) ? '（HTTP ' + error.status + '）' : '';
          throw new HttpError(400, '向量测试失败' + suffix + '。请检查已保存的网关地址和模型是否支持 embeddings');
        }
      }
      if (method === 'PUT' && route === '/api/config') {
        const input = json(await inputBytes(req, 2 * MiB));
        const existing = readConfig();
        const config = updateConfig(existing, input);
        const roleEmbeddingModel = modelSetting(input.roleEmbeddingModel ?? existing.roleEmbeddingModel ?? '', '向量模型');
        const mentionMappingModel = modelSetting(input.mentionMappingModel ?? existing.mentionMappingModel ?? '', '人称映射模型');
        const defaults = originalPrompts();
        const templates = {};
        for (const [key, value] of Object.entries(input.templates || existing.templates || {})) {
          if (!Object.hasOwn(defaults, key) || typeof value !== 'string' || value.length > 20000) throw Error('原版提示词设置无效');
          if (value.trim() && value !== defaults[key]) templates[key] = value;
        }
        writeJsonAtomic(configPath, { ...config, roleEmbeddingModel, mentionMappingModel, templates }, 2);
        return send(res, settings());
      }
      if (method === 'POST' && route === '/api/clean/run') {
        const input = json(await inputBytes(req, 95 * MiB));
        const source = readSource(input);
        const config = readConfig();
        const controller = new AbortController();
        const aborted = () => { if (!res.writableEnded) controller.abort(Error('清洗已停止')); };
        const draft = library.draft();
        const cleanTask = { controller, done: null };
        req.once('aborted', aborted);
        res.once('close', aborted);
        cleanJobs.add(cleanTask);
        try {
          cleanTask.done = (async () => {
            const { model, console: client } = await context('structure', config, controller.signal);
            const tool = createCleanNumberTool({ root: draft.dir, modelConsole: client });
            return withTemplates(config.templates, () => tool.clean({ name: source.file, content: source.text,
              bookName: String(input.bookName || ''), strategy: String(input.strategy || 'auto'),
              ai: input.ai === true, model, bodyModel: config.stages.body?.model }));
          })();
          const result = await cleanTask.done;
          writeJsonAtomic(path.join(draft.dir, 'clean.json'), { source, clean: result }, 0);
          return send(res, { ...result, runId: draft.token, cleanRunId: draft.token });
        } finally {
          cleanJobs.delete(cleanTask);
          req.off('aborted', aborted);
          res.off('close', aborted);
        }
      }
      if (method === 'POST' && route === '/api/number/run') {
        const input = json(await inputBytes(req, 95 * MiB));
        const cleanToken = input.cleanRunId || null;
        const cleanEntry = cleanToken ? readJson(path.join(library.draft(cleanToken).dir, 'clean.json')) : null;
        if (cleanToken && !cleanEntry) throw new HttpError(404, '清洗记录已失效，请重新运行清洗');
        const source = cleanEntry?.source || readSource(input);
        const name = fileName(input.name || source.file);
        const draft = library.draft();
        const tool = createCleanNumberTool({ root: draft.dir });
        const cleaned = cleanEntry?.clean.cleanDoc;
        const cleanDoc = cleaned ? { ...cleaned, 书名: String(input.cleanDoc?.['书名'] || cleaned['书名']) } : null;
        const result = tool.number({ name, cleanDoc, content: source.text, examples: input.examples });
        const numbered = readJson(result.numbered);
        writeJsonAtomic(path.join(draft.dir, 'number.json'), { file: path.basename(result.numbered), source: cleanEntry ? null : source, cleanToken }, 0);
        return send(res, { ...result, numbered: draft.token, runId: draft.token, numberRunId: draft.token, doc: { ...result.doc, bookName: name.replace(/\.[^.]+$/, '') }, coverage: numbered.coverage });
      }
      if (method === 'POST' && route === '/api/number/import') {
        const body = json(await inputBytes(req, MiB));
        const draft = library.draft(body.numberRunId || body.numbered);
        const record = readJson(path.join(draft.dir, 'number.json'));
        if (!record) throw new HttpError(404, '找不到编号记录');
        const numberPath = path.join(draft.dir, '.numbered', record.file);
        const numbered = readJson(numberPath);
        const title = bookId(body.title || numbered.source.file.replace(/\.[^.]+$/, ''));
        assertIdle(title);
        const cleanEntry = record.cleanToken ? readJson(path.join(library.draft(record.cleanToken).dir, 'clean.json')) : null;
        const compiled = createCleanNumberTool({ root: draft.dir }).importNumbered({ numbered: numberPath, title });
        const book = readJson(path.join(compiled.work, 'book.json'));
        const pronouns = layer(compiled.work, 'mentions');
        const project = validateProject({ format: 'novel-cleaning-project', version: 2, source: cleanEntry?.source || record.source,
          clean: cleanEntry?.clean || null, book, numbered, pronouns, scenes: null, characters: null, mentions: null, relations: null });
        library.publish(title, project);
        last.delete(title);
        return send(res, { ...compiled, id: title, work: title });
      }
      if (method === 'POST' && route === '/api/project/import') {
        const raw = await inputBytes(req, projectCap);
        const doc = json(raw);
        if (doc.format !== 'novel-cleaning-project' || doc.version !== 2) {
          const { source } = previousImport(raw, url.searchParams.get('name') || '导入工程.json');
          const text = source.origin ? source.text : null;
          return send(res, { ok: true, needsCleaning: true, source: {
            file: text ? fileName((doc.book?.title || doc.name || '导入书籍') + '.txt') : source.file,
            base64: text ? Buffer.from(text, 'utf8').toString('base64') : source.base64,
          } });
        }
        const entry = library.importProject(doc);
        repairSceneRoleFiles(entry.work);
        return send(res, { ok: true, id: entry.id, title: entry.title });
      }
      if (method === 'POST' && taskRoutes.has(route)) {
        const body = json(await inputBytes(req, MiB));
        return send(res, begin(library.get(body.id), taskRoutes.get(route), body));
      }
      if (method === 'POST' && route === '/api/scenes/stop') {
        const body = json(await inputBytes(req, MiB));
        const requestId = body.id || id;
        const task = requestId ? lockFor(requestId) : [...active.values()].find(item => item.group === 'scenes');
        if (task?.group === 'scenes') task.controller.abort(Error('已停止'));
        return send(res, { ok: true, stopped: Boolean(task?.group === 'scenes') });
      }
      if (method === 'POST' && route === '/api/mentions/mapping/stop') {
        const body = json(await inputBytes(req, MiB));
        const task = lockFor(library.location(body.id).id);
        const stopped = task?.job.step === 'mapping';
        if (stopped) task.controller.abort(Error('映射已停止'));
        return send(res, { ok: true, stopped });
      }
      if (method === 'GET' && route === '/api/active') return send(res, { books: active.size, clean: cleanJobs.size });
      if (method === 'GET' && route === '/api/book/files') return send(res, viewer.list(library.location(id).work));
      if (method === 'GET' && route === '/api/book/file') {
        const document = await viewer.open(library.location(id).work, url.searchParams, res);
        if (document !== null) send(res, document);
        return;
      }
      if (method === 'GET' && ['/api/book/export', '/api/book/numbered', '/api/project/status', '/api/mention/sentence', '/api/scenes/progress',
        '/api/scenes/partial', '/api/scenes/llm', '/api/characters', '/api/characters/progress'].includes(route)) {
        const entry = library.get(id);
        const { book, work } = entry;
        if (route === '/api/book/export') return download(res, entry.id + '.project.json', validateProject(readProject(work)));
        if (route === '/api/project/status') {
          const roles = layer(work, 'characters');
          const roleJob = sceneRoleCheckpoint(work);
          const characters = Boolean(roles && roleJob.complete);
          return send(res, { scenes: layer(work, 'scenes')?.strategy === ROLLING_SCENE_STRATEGY, characters,
            mentions: characters && Boolean(layer(work, 'mentions')?.method),
            mapping: readMentionMapping(work, mappingLayers(work)).document?.phase === 'done' });
        }
        if (route === '/api/book/numbered') {
          const doc = readJson(path.join(work, 'initial.json')).numbered;
          return send(res, { bookName: entry.title, chapters: doc.chapters, paragraphs: doc.paragraphs, sentences: doc.sentences, schema: doc.schema });
        }
        if (route === '/api/mention/sentence') {
          const s = Number(url.searchParams.get('s'));
          const row = nestedSentences(book).find(sentence => sentenceNumber(sentence) === s);
          const table = readJson(path.join(work, 'number-mentions.json'));
          const mentions = row && table ? table.mentions.filter(m => m.sentence === (row.sentenceNo ?? s)) : [];
          return send(res, { sentence: s, text: row?.text || '', mentions, total: table?.total || 0, missing: !table });
        }
        if (route === '/api/scenes/progress') return send(res, sceneStats(entry));
        if (route === '/api/scenes/partial') {
          const saved = layer(work, 'scenes.progress.json', {});
          const chapters = saved.chapters || [];
          return send(res, { done: chapters.length, total: book.chapters.length, partialScenes: partialScenes(work).length,
            missing: book.chapters.map(c => c.id).filter(value => !chapters.includes(value)), finished: Boolean(layer(work, 'scenes')) });
        }
        if (route === '/api/scenes/llm') {
          const doc = layer(work, 'scenes');
          if (doc) return send(res, { ...doc, scenes: attachSceneText(book, doc.scenes) });
          if (!layer(work, 'scenes.progress.json')) throw new HttpError(404, '这本书还没有场景切分结果');
          const stats = sceneStats(entry);
          const scenes = partialScenes(work);
          return send(res, { partial: true, progress: stats,
            totals: { scenes: scenes.length }, scenes: attachSceneText(book, scenes) });
        }
        if (route === '/api/characters') return send(res, attachCharacters(entry));
        const job = last.get(entry.id);
        const roles = job && job.step !== 'scenes' ? job : null;
        const checkpoint = sceneRoleCheckpoint(work);
        const older = !checkpoint.started ? characterCheckpoint(work) : null;
        const legacy = older && { done: older.done, names: older.candidates.length };
        const table = layer(work, 'mentions');
        const totals = table?.method ? table.totals : { characters: layer(work, 'characters')?.characters?.length ?? 0,
          mentions: 0, resolved: 0, unresolved: 0 };
        return send(res, { ...roles, running: Boolean(roles?.running), step: roles?.step || '', code: roles?.code ?? null,
          totals: roles?.totals || totals, checkpoint, legacy,
          embeddingConfigured: Boolean(readConfig().roleEmbeddingModel) });
      }
      throw new HttpError(404, '地址不存在');
    } catch (error) {
      if (res.destroyed || res.writableEnded) return;
      const status = error.status || (error.code ? 500 : 400);
      if (!res.headersSent) send(res, { ok: false, error: status === 500 ? '本地数据读写失败，请检查项目目录' : error.message }, status);
      else res.end();
    }
  });
  server.pauseJobs = async () => {
    const tasks = [...active.values(), ...cleanJobs];
    for (const task of tasks) task.controller.abort(Error('应用已关闭'));
    await Promise.allSettled(tasks.map(task => task.done));
  };
  return server;
}

function lock(directory) {
  fs.mkdirSync(directory, { recursive: true });
  const file = path.join(directory, 'server.lock');
  try {
    fs.writeFileSync(file, String(process.pid), { flag: 'wx' });
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
    const owner = fs.readFileSync(file, 'utf8');
    const pid = Number(owner);
    if (!Number.isSafeInteger(pid) || pid < 1) throw Error('数据目录存在无效启动锁');
    try { process.kill(pid, 0); }
    catch (state) {
      if (state.code !== 'ESRCH') throw state;
      if (fs.readFileSync(file, 'utf8') !== owner) throw Error('已有进程正在启动');
      fs.unlinkSync(file);
      fs.writeFileSync(file, String(process.pid), { flag: 'wx' });
      return file;
    }
    throw Error('独立分析器已在运行，进程 ' + pid);
  }
  return file;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const port = Number(process.argv[2] || process.env.NOVEL_CLEANING_PORT || 4186);
    if (!Number.isInteger(port) || port < 1024 || port > 65535) throw Error('端口须为 1024–65535 的整数');
    const lockFile = lock(defaultData);
    process.on('exit', () => {
      if (fs.existsSync(lockFile) && fs.readFileSync(lockFile, 'utf8') === String(process.pid)) fs.unlinkSync(lockFile);
    });
    const service = createAnalyzerApp();
    service.once('error', error => {
      console.error(error.code === 'EADDRINUSE' ? '端口 ' + port + ' 已占用' : error.message);
      process.exitCode = 1;
    });
    service.listen(port, '127.0.0.1', () => console.log('小说清洗软件（原版四步）http://127.0.0.1:' + port + '/'));
    for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, async () => {
      service.close();
      await service.pauseJobs();
    });
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}


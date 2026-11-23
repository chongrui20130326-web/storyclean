import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createServer } from 'node:http';
import { defaultConfig, listModels, publicConfig, updateConfig } from './lib/gateway.mjs';
import { checkRevision, createJobs, STAGES } from './lib/jobs.mjs';
import { compatibleCorpus, fromTxt, importProject, saveCleaning, saveNumbering, validateProject } from './lib/project.mjs';
import { HttpError, MAX_PROJECT_BYTES, openStorage } from './lib/storage.mjs';
import { bookView, describeBook } from './lib/views.mjs';
import { createWorkflow, saveMentions, updateCleaning } from './lib/workflow.mjs';

const root = fileURLToPath(new URL('./', import.meta.url));
const MiB = 1024 * 1024;
const staticFiles = new Map([
  ['/', ['index.html', 'text/html']],
  ['/app.js', ['app.js', 'text/javascript']],
  ['/styles.css', ['styles.css', 'text/css']],
]);

function reply(response, result, status = 200) {
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' }).end(JSON.stringify(result));
}

async function bytes(request, max) {
  if (Number(request.headers['content-length']) > max) throw new HttpError(413, '输入文件超过大小上限');
  let size = 0;
  const chunks = [];
  for await (const chunk of request.iterator({ destroyOnReturn: false })) {
    size += chunk.length;
    if (size > max) {
      request.resume();
      throw new HttpError(413, '输入文件超过大小上限');
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks, size);
}

async function json(request) {
  const input = await bytes(request, 8 * MiB);
  if (!input.length) return {};
  try {
    const value = JSON.parse(input.toString('utf8'));
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw Error();
    return value;
  } catch { throw new HttpError(400, '提交内容须为 JSON 对象'); }
}

function attachment(response, filename, type, data) {
  const encoded = encodeURIComponent(filename).replace(/['()]/g, c => '%' + c.charCodeAt(0).toString(16));
  response.writeHead(200, {
    'Content-Type': type,
    'Content-Disposition': "attachment; filename*=UTF-8''" + encoded,
  }).end(data);
}

export function createApp({ dataDir = path.join(root, 'data') } = {}) {
  const storage = openStorage(dataDir);
  const configOf = () => storage.getConfig(defaultConfig());
  const jobs = createJobs(storage, configOf);
  const workflow = createWorkflow(storage, jobs, configOf);
  const meta = entry => describeBook(entry, storage);

  const server = createServer(async (request, response) => {
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'");
    try {
      const host = request.headers.host || '';
      if (!/^(?:localhost|127\.0\.0\.1)(?::\d+)?$/i.test(host)) throw new HttpError(403, '服务只接受本机访问');
      const origin = request.headers.origin;
      if (origin && origin !== 'http://' + host) throw new HttpError(403, '浏览器来源与工作台地址不一致');
      const url = new URL(request.url, 'http://' + host);
      if (url.host !== host.toLowerCase() && url.hostname !== host.split(':')[0].toLowerCase()) {
        throw new HttpError(400, '地址无效');
      }
      const { pathname, searchParams: query } = url;
      const method = request.method;
      if (method === 'GET' && staticFiles.has(pathname)) {
        const [file, type] = staticFiles.get(pathname);
        response.writeHead(200, { 'Content-Type': type + '; charset=utf-8' })
          .end(fs.readFileSync(path.join(root, 'ui', file)));
        return;
      }
      if (pathname === '/api/config') {
        if (method === 'GET') return reply(response, publicConfig(configOf()));
        if (method === 'PUT') {
          const input = await json(request);
          const config = updateConfig(configOf(), input);
          storage.saveConfig(config);
          return reply(response, publicConfig(config));
        }
      }
      if (pathname === '/api/models' && method === 'GET') {
        try { return reply(response, await listModels(configOf())); }
        catch (error) { throw new HttpError(502, error.message); }
      }
      if (pathname === '/api/books') {
        if (method === 'GET') return reply(response, storage.list());
        if (method === 'POST') {
          const name = query.get('name') || '未命名.txt';
          const isProject = /\.json$/i.test(name);
          if (!isProject && !/\.txt$/i.test(name)) throw new HttpError(400, '请选择 TXT 小说或 JSON 工程');
          const content = await bytes(request, isProject ? MAX_PROJECT_BYTES : 20 * MiB);
          if (!content.length) throw new HttpError(400, '输入文件为空');
          const project = isProject ? importProject(content, name) : fromTxt(content, name);
          return reply(response, meta(storage.add(project)), 201);
        }
      }
      const match = pathname.match(/^\/api\/books\/([a-f0-9-]{36})(?:\/([a-z]+))?$/);
      if (!match) throw new HttpError(404, '地址不存在');
      const [, id, action] = match;
      if (method === 'GET' && action === 'job') {
        const stage = query.get('stage');
        if (stage && !STAGES.includes(stage)) throw new HttpError(400, '未知处理阶段');
        const job = jobs.read(id, stage);
        const process = stage ? null : workflow.read(id);
        if (process && (workflow.running(id) || !job || process.updatedAt >= job.updatedAt)) {
          return reply(response, workflow.present(id, process));
        }
        return reply(response, jobs.present(job));
      }
      if (method === 'GET' && action === 'process') return reply(response, workflow.present(id));
      if (method === 'POST' && action === 'stop') return reply(response, workflow.running(id) ? workflow.stop(id) : jobs.stop(id), 202);
      const input = ['POST', 'PUT'].includes(method) ? await json(request) : null;
      const entry = storage.get(id);
      if (method === 'GET') {
        if (!action) return reply(response, meta(entry));
        if (action === 'view') return reply(response, bookView(entry, query, storage));
        if (action === 'log') return reply(response, storage.readLog(id));
        if (action === 'backups') return reply(response, storage.backups(id));
        if (action === 'backup') {
          const revision = Number(query.get('revision'));
          const project = validateProject(storage.readBackup(id, revision));
          return attachment(response, project.clean.title + '.r' + revision + '.project.json', 'application/json; charset=utf-8', JSON.stringify(project));
        }
        if (action === 'export') {
          const data = validateProject(entry.project);
          return attachment(response, data.clean.title + '.project.json', 'application/json; charset=utf-8', JSON.stringify(data));
        }
        if (action === 'corpus') {
          const data = compatibleCorpus(entry.project);
          return attachment(response, data.name + '.corpus.json', 'application/json; charset=utf-8', JSON.stringify(data));
        }
        if (action === 'raw') {
          const { file, base64 } = entry.project.source;
          return attachment(response, file, 'application/octet-stream', Buffer.from(base64, 'base64'));
        }
        if (action === 'report') {
          const { clean, source } = entry.project;
          return attachment(response, clean.title + '.清洗记录.json', 'application/json; charset=utf-8', JSON.stringify({
            source: source.file, sha256: source.sha256, encoding: source.encoding, notes: source.notes, edits: clean.edits, audit: clean.audit,
            modelReviews: entry.project.cleanReviews,
          }, null, 2));
        }
        if (action === 'cleaned') {
          const { clean } = entry.project;
          const text = clean.chapters.map(c => [c.headingLine === null ? '' : c.title, ...c.paragraphs.map(p => p.text)].filter(Boolean).join('\n')).join('\n\n');
          return attachment(response, clean.title + '.清洗.txt', 'text/plain; charset=utf-8', text);
        }
      }
      if (method === 'POST' && action === 'process') return reply(response, workflow.start(entry, input), 202);
      if (method === 'POST' && action === 'job') {
        workflow.assertIdle(id);
        return reply(response, jobs.start(entry, input), 202);
      }
      if (method === 'PUT' && ['clean', 'preview'].includes(action)) {
        checkRevision(entry, input.revision);
        if (action === 'preview') {
          saveCleaning(entry.project, input.edits);
          const { clean } = entry.project;
          const changes = clean.audit.filter(row => row.action !== 'normalize' && row.action !== 'blank');
          return reply(response, { title: clean.title, chapters: clean.chapters.map(c => ({ title: c.title, line: c.headingLine, paragraphs: c.paragraphs.length })),
            sample: clean.body.slice(0, 2400), audit: changes.slice(0, 30), changes: changes.length, warnings: clean.warnings });
        }
        workflow.assertIdle(id);
        jobs.assertIdle(id);
        return reply(response, meta(updateCleaning(storage, entry, input)));
      }
      if (method === 'POST' && ['number', 'mentions'].includes(action)) {
        workflow.assertIdle(id);
        jobs.assertIdle(id);
        checkRevision(entry, input.revision);
        const { project } = entry;
        if (action === 'number') {
          if (project.numbered) return reply(response, meta(entry));
          saveNumbering(project);
        } else {
          if (project.mentions) return reply(response, meta(entry));
          saveMentions(project);
        }
        return reply(response, meta(storage.save(entry)));
      }
      throw new HttpError(404, '地址不存在');
    } catch (error) {
      const invalid = error instanceof TypeError ? '输入字段格式无效' : error.message;
      const code = error.status || (error.code ? 500 : 400);
      const message = code === 500 ? '本地数据读写失败，请检查数据目录和磁盘空间' : invalid;
      if (!response.headersSent) reply(response, { error: message }, code);
      else response.end();
    }
  });
  server.pauseJobs = async () => {
    await workflow.shutdown();
    await jobs.shutdown();
  };
  return server;
}

function acquireLock(dir) {
  fs.mkdirSync(dir, { recursive: true });
  const lock = path.join(dir, 'server.lock');
  const stamp = process.pid + '\n';
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      fs.writeFileSync(lock, stamp, { flag: 'wx' });
      return () => {
        if (fs.existsSync(lock) && fs.readFileSync(lock, 'utf8') === stamp) fs.unlinkSync(lock);
      };
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      const owner = fs.readFileSync(lock, 'utf8');
      const pid = Number(owner);
      if (!Number.isInteger(pid) || pid <= 0) throw Error('数据目录启动锁无效，请确认没有工作台进程后处理 data/server.lock');
      try { process.kill(pid, 0); }
      catch (signalError) {
        if (signalError.code === 'ESRCH') {
          if (fs.readFileSync(lock, 'utf8') === owner) fs.unlinkSync(lock);
          continue;
        }
        throw signalError;
      }
      throw Error('小说清洗软件已在运行，进程号 ' + pid);
    }
  }
  throw Error('另一个进程正在启动，请稍后再试');
}

async function main() {
  const port = Number(process.argv[2] || process.env.NOVEL_CLEANING_PORT || 4186);
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw Error('端口须为 1024–65535 的整数');
  const dataDir = path.join(root, 'data');
  const releaseLock = acquireLock(dataDir);
  process.on('exit', releaseLock);
  const server = createApp({ dataDir });
  server.once('error', error => {
    console.error(error.code === 'EADDRINUSE' ? '端口 ' + port + ' 已占用。可用 start.cmd 4187 指定可用端口。' : error.message);
    process.exitCode = 1;
  });
  server.listen(port, '127.0.0.1', () => console.log('小说清洗软件已启动  http://127.0.0.1:' + port + '/'));
  const close = async () => {
    server.close();
    await server.pauseJobs();
  };
  process.once('SIGINT', close);
  process.once('SIGTERM', close);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}


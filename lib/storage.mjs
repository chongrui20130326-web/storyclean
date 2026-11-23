import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

export const MAX_PROJECT_BYTES = 512 * 1024 * 1024;

function atomicJson(file, content, max = Infinity) {
  let encoded;
  try { encoded = JSON.stringify(content); }
  catch (error) {
    if (error instanceof RangeError && max < Infinity) throw new HttpError(413, '当前结果过大，已保留以前保存的工程');
    throw error;
  }
  if (Buffer.byteLength(encoded) > max) throw new HttpError(413, '当前结果过大，已保留以前保存的工程');
  const temporary = file + '.' + randomUUID() + '.tmp';
  let fd;
  try {
    fd = fs.openSync(temporary, 'wx', 0o600);
    fs.writeFileSync(fd, encoded);
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = undefined;
    fs.renameSync(temporary, file);
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
    fs.rmSync(temporary, { force: true });
  }
}

function read(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    return fallback;
  }
}

export class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

export function openStorage(root) {
  const bookRoot = path.join(root, 'books');
  fs.mkdirSync(bookRoot, { recursive: true });
  const configFile = path.join(root, 'config.json');
  const dir = (id) => {
    if (!/^[a-f0-9-]{36}$/.test(id)) throw new HttpError(404, '书籍不存在');
    return path.join(bookRoot, id);
  };
  const bookPath = (id) => path.join(dir(id), 'book.json');
  const metaPath = (id) => path.join(dir(id), 'summary.json');
  const stages = ['structure', 'body', 'scenes', 'characters'];
  const checkpointPath = (id, stage) => path.join(dir(id), 'job-' + stage + '.json');
  const bookSummary = (entry) => ({
    id: entry.id, revision: entry.revision, updatedAt: entry.updatedAt, title: entry.project.clean.title, file: entry.project.source.file,
  });
  const write = (entry) => {
    const snapshot = { ...entry, updatedAt: new Date().toISOString() };
    atomicJson(bookPath(entry.id), snapshot, MAX_PROJECT_BYTES);
    // 摘要只是书架缓存。正文成功落盘后，缓存失败不能把提交报道为失败。
    try { atomicJson(metaPath(entry.id), bookSummary(snapshot)); } catch { /* 可从 book.json 重建 */ }
    return snapshot;
  };
  return {
    list() {
      return fs.readdirSync(bookRoot, { withFileTypes: true })
        .filter(item => item.isDirectory() && /^[a-f0-9-]{36}$/.test(item.name))
        .map(({ name }) => {
          const file = bookPath(name);
          if (!fs.existsSync(file)) return null;
          const meta = metaPath(name);
          if (fs.existsSync(meta) && fs.statSync(meta).mtimeMs >= fs.statSync(file).mtimeMs) return read(meta, null);
          return bookSummary(read(file, null));
        })
        .filter(Boolean)
        .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    },
    add(project) {
      const id = randomUUID();
      fs.mkdirSync(dir(id));
      return write({ id, revision: 1, project });
    },
    get(id) {
      const entry = read(bookPath(id), null);
      if (!entry) throw new HttpError(404, '书籍不存在');
      return entry;
    },
    save(entry) {
      return write({ ...entry, revision: entry.revision + 1 });
    },
    backup(entry) {
      const backup = path.join(dir(entry.id), 'backups');
      fs.mkdirSync(backup, { recursive: true });
      const file = path.join(backup, 'r' + entry.revision + '.project.json');
      if (!fs.existsSync(file)) atomicJson(file, entry.project);
    },
    backupCount(id) {
      const backup = path.join(dir(id), 'backups');
      return fs.existsSync(backup) ? fs.readdirSync(backup).filter(name => name.endsWith('.project.json')).length : 0;
    },
    backups(id) {
      const backup = path.join(dir(id), 'backups');
      if (!fs.existsSync(backup)) return [];
      return fs.readdirSync(backup).flatMap(name => {
        const revision = name.match(/^r(\d+)\.project\.json$/)?.[1];
        return revision ? [Number(revision)] : [];
      }).sort((a, b) => b - a);
    },
    readBackup(id, revision) {
      if (!Number.isSafeInteger(revision) || revision < 1) throw new HttpError(400, '备份版本号无效');
      const project = read(path.join(dir(id), 'backups', 'r' + revision + '.project.json'), null);
      if (!project) throw new HttpError(404, '备份不存在');
      return project;
    },
    getJob(id, stage) {
      if (stage) return read(checkpointPath(id, stage), null);
      return stages.map(key => read(checkpointPath(id, key), null)).filter(Boolean)
        .sort((a, b) => b.updatedAt - a.updatedAt)[0] || null;
    },
    saveJob(id, job) { atomicJson(checkpointPath(id, job.stage), job); },
    getConfig(fallback) { return read(configFile, fallback); },
    saveConfig(config) { atomicJson(configFile, config); },
    log(id, event) {
      fs.appendFileSync(path.join(dir(id), 'model.jsonl'), JSON.stringify({ at: new Date().toISOString(), ...event }) + '\n', { mode: 0o600 });
    },
    readLog(id) {
      const file = path.join(dir(id), 'model.jsonl');
      if (!fs.existsSync(file)) return [];
      const fd = fs.openSync(file, 'r');
      try {
        const size = fs.fstatSync(fd).size;
        const start = Math.max(0, size - 64 * 1024);
        const tail = Buffer.alloc(size - start);
        fs.readSync(fd, tail, 0, tail.length, start);
        const lines = tail.toString('utf8').trimEnd().split('\n');
        if (start) lines.shift();
        return lines.slice(-60).filter(Boolean).flatMap(line => {
          try { return [JSON.parse(line)]; } catch { return []; }
        });
      } finally { fs.closeSync(fd); }
    },
  };
}


import fs from 'node:fs';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { HttpError } from '../lib/storage.mjs';

const generatedFiles = new Map([
  ['initial.json', '原稿、清洗结果和编号'],
  ['book.json', '书籍章、段、句结构'],
  ['number-mentions.json', '编号阶段的全文代词'],
  ['l2/scenes-llm.json', '场景切分结果'],
  ['l2/scenes.progress.json', '场景切分断点'],
  ['l2/scenes.done.json', '场景切分完成记录'],
  ['l2/segmentation.verify.json', '场景覆盖校验报告'],
  ['l2/characters.json', '角色真名表'],
  ['l2/scene-roles.json', '导入的逐场角色与证据'],
  ['l2/scene-roles.progress.json', '逐场角色进度与证据'],
  ['l2/characters.progress.json', '角色识别断点'],
  ['l2/mention-table.json', '人称表'],
  ['l2/mention-mapping.json', '人称与真名映射'],
  ['l2/scene-mentions.preview.json', '场景人称预览'],
  ['l2/relations.json', '角色关系附表'],
  ['l2/relations.progress.json', '角色关系断点'],
  ['l2/truncation-report.json', '模型输出检查报告'],
]);

const pageBytes = 64 * 1024;
const maxTreeBytes = 192 * 1024 * 1024;

function findFile(root, name) {
  if (!generatedFiles.has(name)) throw new HttpError(404, '没有这个书籍 JSON 文件');
  try {
    const file = fs.realpathSync(path.join(root, name));
    const relative = path.relative(root, file);
    if (!relative || path.isAbsolute(relative) || relative === '..' || relative.startsWith('..' + path.sep)) {
      throw new HttpError(404, '没有这个书籍 JSON 文件');
    }
    const stat = fs.statSync(file);
    if (!stat.isFile()) throw new HttpError(404, '这份 JSON 文件尚未生成');
    return { file, stat };
  } catch (error) {
    if (error.code === 'ENOENT') throw new HttpError(404, '这份 JSON 文件尚未生成');
    throw error;
  }
}

function index(query, key) {
  const value = Number(query.get(key) || 0);
  if (!Number.isSafeInteger(value) || value < 0) throw new HttpError(400, '查看位置无效');
  return value;
}

function valueAt(value, pointer) {
  if (pointer === '') return value;
  if (!pointer.startsWith('/') || pointer.length > 16384) throw new HttpError(400, 'JSON 路径无效');
  for (const part of pointer.slice(1).split('/')) {
    if (/~(?![01])/.test(part)) throw new HttpError(400, 'JSON 路径无效');
    const key = part.replaceAll('~1', '/').replaceAll('~0', '~');
    if (value === null || typeof value !== 'object' || (Array.isArray(value) && !/^(0|[1-9]\d*)$/.test(key))
      || !Object.hasOwn(value, key)) throw new HttpError(404, 'JSON 路径不存在');
    value = value[key];
  }
  return value;
}

function describe(value) {
  if (value === null) return { type: 'null', preview: 'null' };
  if (Array.isArray(value)) return { type: 'array', total: value.length };
  const type = typeof value;
  if (type === 'object') return { type, total: Object.keys(value).length };
  if (type === 'string') {
    const sample = Array.from(value.slice(0, 161)).slice(0, 160).join('');
    return { type, length: value.length, preview: JSON.stringify(sample) + (sample.length < value.length ? '…' : '') };
  }
  return { type, preview: String(value) };
}

function tree(value, query) {
  const pointer = query.get('pointer') || '';
  const selected = valueAt(value, pointer);
  const details = describe(selected);
  const offset = index(query, 'offset');
  const total = details.total ?? 0;
  const end = Math.min(offset + 80, total);
  const keys = Array.isArray(selected) ? null : details.type === 'object' ? Object.keys(selected) : [];
  const children = [];
  for (let i = offset; i < end; i += 1) {
    const key = keys ? keys[i] : String(i);
    const escaped = key.replaceAll('~', '~0').replaceAll('/', '~1');
    children.push({ key, pointer: pointer + '/' + escaped, ...describe(selected[key]) });
  }
  return { ...details, pointer, children, next: end < total ? end : null };
}

const isContinuation = byte => (byte & 0xc0) === 0x80;

function page(file, query) {
  const pageIndex = index(query, 'page');
  const fd = fs.openSync(file, 'r');
  try {
    const { size } = fs.fstatSync(fd);
    const pages = Math.max(1, Math.ceil(size / pageBytes));
    if (pageIndex >= pages) throw new HttpError(400, 'JSON 页码超出范围');
    const start = pageIndex * pageBytes;
    const data = Buffer.alloc(Math.min(size - start, pageBytes + 3));
    const read = fs.readSync(fd, data, 0, data.length, start);
    let begin = 0;
    let end = Math.min(read, pageBytes);
    while (begin < read && isContinuation(data[begin])) begin += 1;
    while (end < read && isContinuation(data[end])) end += 1;
    return { page: pageIndex, pages, text: data.toString('utf8', begin, end) };
  } finally {
    fs.closeSync(fd);
  }
}

export function createFileViewer() {
  // Retain only the most recently explored tree. Each new version of a generated file
  // is identified independently so an atomic replacement cannot leave a stale view.
  let cached;
  return {
    list(work) {
      const root = fs.realpathSync(work);
      return [...generatedFiles].flatMap(([name, label]) => {
        try {
          const { stat } = findFile(root, name);
          return [{ name, label, bytes: stat.size, updatedAt: stat.mtime.toISOString() }];
        } catch (error) {
          if (error.status === 404) return [];
          throw error;
        }
      });
    },
    async open(work, query, response) {
      const name = query.get('name');
      const { file, stat } = findFile(fs.realpathSync(work), name);
      const view = query.get('view') || 'tree';
      if (view === 'download') {
        const filename = encodeURIComponent(path.basename(name));
        response.writeHead(200, {
          'Content-Type': 'application/json; charset=utf-8',
          'Content-Disposition': "attachment; filename*=UTF-8''" + filename,
        });
        await pipeline(fs.createReadStream(file), response);
        return null;
      }
      if (view === 'text') return page(file, query);
      if (view !== 'tree') throw new HttpError(400, '查看方式无效');
      if (stat.size > maxTreeBytes) throw new HttpError(413, '此文件太大，仍可逐页阅读内容或下载 JSON');
      const signature = [file, stat.ino, stat.size, stat.mtimeMs, stat.ctimeMs].join('|');
      if (cached?.signature !== signature) {
        cached = undefined;
        try { cached = { signature, data: JSON.parse(fs.readFileSync(file, 'utf8')) }; }
        catch (error) { if (error instanceof SyntaxError) throw new HttpError(422, '此文件暂时无法解析为 JSON'); throw error; }
      }
      return tree(cached.data, query);
    },
  };
}


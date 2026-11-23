import { isDeepStrictEqual } from 'node:util';
import { randomUUID } from 'node:crypto';
import { modelClient } from './gateway.mjs';
import { bookBasis, sha256, stamp } from './project.mjs';
import { sourceLines } from './text.mjs';
import { characterCandidates, makeCharacters, makeScenes, MAX_SCENE_CHARS } from './tables.mjs';
import { modelSceneCuts } from './vendor/scene-boundaries.mjs';
import { HttpError } from './storage.mjs';

const LIMIT = 5000;
export const STAGES = ['structure', 'body', 'scenes', 'characters'];
const numberedStage = stage => stage === 'scenes' || stage === 'characters';

function selectedRows(project, stage) {
  if (numberedStage(stage)) return project.numbered.sentences;
  const { source, clean } = project;
  if (stage === 'body') {
    return clean.chapters.flatMap(chapter => chapter.paragraphs.flatMap(p => p.pieces.map(piece => ({
      line: piece.line,
      text: clean.body.slice(piece.start, piece.end),
    }))));
  }
  const heading = new Set(clean.edits.headings.map(row => row.line));
  // Include short possible headings and the first few lines even when they contain punctuation.
  return sourceLines(source.text).flatMap(({ line, raw }) => {
    const text = raw.trim();
    if (!text || !(heading.has(line) || (text.length <= 100 && (line <= 8 || !/[。！？!?]/.test(text))))) return [];
    return [{ line, text, currentHeading: heading.has(line), titleCandidate: line <= 12 }];
  });
}

const contracts = {
  structure: '【目录校对】仅引用资料中的行号。书名可返回 null，或 {"line":1,"title":"原文书名"}。headings 只列正文的章标题。bodyLines 只列被规则误判为章标题、实际上属于正文的行。输出 {"title":null,"headings":[{"line":2,"title":"第一章"}],"bodyLines":[]}。',
  body: '【正文复核】remove 仅列高置信的非正文整行并解释原因。merge 用当前行号表示并入它紧邻的上一正文行。输出 {"remove":[{"line":21,"reason":"站点广告"}],"merge":[25]}。无建议则两个数组均为空。',
  characters: '【角色真名】用原文中的拼写，逐一返回人名和独有别名。不要把“我”“他”“她”“母亲”“大家”等泛称作为姓名或别名。没有可辨认的姓名时返回空数组。输出 {"characters":[{"name":"林舟","aliases":[]}]}。',
};

function parseModelJson(content) {
  const text = content.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  try { return JSON.parse(text); } catch { throw Error('模型输出不是完整 JSON'); }
}

const textLabel = value => typeof value === 'string' && value.trim() && value.length <= 250 && !/[\r\n\x00]/.test(value);

function makeSuggestions(stage, value, batch, previousLine) {
  const byLine = new Map(batch.map(row => [row.line, row]));
  const lineOk = n => Number.isInteger(n) && byLine.has(n);
  const entries = [];
  if (stage === 'structure') {
    if (!Array.isArray(value?.headings) || !Array.isArray(value.bodyLines) || !Object.hasOwn(value, 'title')) throw Error('目录校对 JSON 结构无效');
    if (value.title !== null) {
      if (!lineOk(value.title?.line) || !byLine.get(value.title.line).titleCandidate || !textLabel(value.title.title)) throw Error('建议书名缺少有效原文行号或标题');
      entries.push({ line: value.title.line, kind: 'title', text: value.title.title.trim() });
    }
    for (const { line, title } of value.headings) {
      if (!lineOk(line) || !textLabel(title)) throw Error('建议章节缺少有效原文行号或标题');
      entries.push({ line, kind: 'heading', text: title.trim() });
    }
    for (const line of value.bodyLines) {
      if (!lineOk(line) || !byLine.get(line).currentHeading) throw Error('只可将当前标题建议恢复为正文');
      entries.push({ line, kind: 'body', text: '恢复为正文' });
    }
  } else {
    if (!Array.isArray(value?.remove) || !Array.isArray(value.merge)) throw Error('正文复核 JSON 结构无效');
    for (const { line, reason } of value.remove) {
      if (!lineOk(line) || !textLabel(reason)) throw Error('移除建议缺少有效正文行号或原因');
      entries.push({ line, kind: 'remove', text: reason.trim() });
    }
    for (const line of value.merge) {
      if (!lineOk(line) || (!byLine.has(line - 1) && previousLine !== line - 1)) throw Error('合并建议未紧邻上一正文行');
      entries.push({ line, kind: 'merge', text: '并入上一正文行' });
    }
  }
  if (new Set(entries.map(row => row.line)).size !== entries.length) throw Error('同一行有多个互相冲突的建议');
  return entries;
}

async function runBatches(stage, rows, job, model, save, note) {
  const data = [...job.data];
  let cursor = job.cursor;
  while (cursor < rows.length) {
    let count = 0;
    let size = 0;
    while (cursor + count < rows.length) {
      const row = rows[cursor + count];
      if (row.text.length > LIMIT) throw Error('单行超过5000字，请先检查原文第 ' + row.line + ' 行');
      const next = row.text.length + 22;
      if (count && size + next > LIMIT) break;
      size += next;
      count += 1;
    }
    let attempts = 0;
    let result;
    let feedback = '';
    while (result === undefined) {
      const batch = rows.slice(cursor, cursor + count);
      const previousLine = rows[cursor - 1]?.line ?? null;
      const task = [model.prompt, contracts[stage], feedback, '【待分析资料 JSON】', JSON.stringify({
        previousLine,
        rows: stage === 'characters' ? batch.map(({ id, text }) => ({ id, text })) : batch,
      })].join('\n');
      const response = await model.chat(task);
      try {
        if (response.truncated) throw Error('模型输出达到 token 上限');
        const json = parseModelJson(response.content);
        result = stage === 'characters' ? characterCandidates(json, batch) : makeSuggestions(stage, json, batch, previousLine);
      } catch (error) {
        const reason = error instanceof TypeError ? '模型条目格式无效' : error.message;
        note(reason);
        feedback = '上次响应校验失败：' + reason;
        attempts += 1;
        if (attempts % 2 === 0) {
          if (count === 1 || attempts >= 8) throw Error(reason);
          count = Math.ceil(count / 2);
        }
      }
    }
    data.push(...result);
    cursor += count;
    save(cursor, data);
  }
  return data;
}

export function checkRevision(entry, revision) {
  if (revision != null && revision !== entry.revision) throw new HttpError(409, '书籍已经更新，请刷新后重试');
}

export function createJobs(storage, configOf) {
  const active = new Map();
  const last = new Map();

  function assertIdle(id) {
    if (active.has(id)) throw new HttpError(409, '这本书还有任务在运行，请等待或暂停');
  }

  function present(job, now = Date.now()) {
    if (!job) return { status: 'idle' };
    const { id, stage, status, cursor, total, elapsedMs, requests, usage, error, sessionAt, basis } = job;
    const elapsed = elapsedMs + (sessionAt ? now - sessionAt : 0);
    const averageMs = cursor ? elapsed / cursor : null;
    const etaMs = averageMs !== null && status === 'running' ? Math.max(0, (total - cursor) * averageMs) : null;
    return { id, stage, status, cursor, total, elapsedMs: elapsed, averageMs, etaMs, requests, usage, error, basis };
  }

  function read(id, stage) {
    const live = active.get(id)?.job;
    if (live && (!stage || live.stage === stage)) return live;
    const job = stage ? storage.getJob(id, stage) : last.get(id) || storage.getJob(id);
    if (job && ['running', 'stopping'].includes(job.status)) {
      if (storage.get(id).completedJobs?.[job.stage] === job.id) {
        return { ...job, status: 'complete', sessionAt: null };
      }
      // A fresh process never owns the old in-flight request.
      return { ...job, status: 'paused', sessionAt: null, error: '应用已重启，可从最近一次保存的批次续跑' };
    }
    return job;
  }

  function start(entry, { stage, restart, revision }, config = configOf(), restartChanged = false) {
    const { id, project } = entry;
    assertIdle(id);
    checkRevision(entry, revision);
    if (!STAGES.includes(stage)) throw new HttpError(400, '未知处理阶段');
    if (numberedStage(stage) && !project.numbered) throw new HttpError(400, '请先保存内容编号');
    const stageConfig = config.stages[stage];
    if (!stageConfig.model) throw new HttpError(400, '请先在设置中选择本阶段模型');
    const rows = selectedRows(project, stage);
    if (numberedStage(stage)) {
      const overlong = rows.find(row => row.text.length > MAX_SCENE_CHARS);
      if (overlong) throw new HttpError(400, '单句超过5000字，请先检查句子编号：' + overlong.id);
    }
    const basis = bookBasis(project);
    const fingerprint = sha256(JSON.stringify([config.gateway, stageConfig.model, stageConfig.prompt, config.temperature,
      config.disableReasoning !== false]));
    const old = read(id, stage);
    const checkpoint = !restart && old && ['paused', 'failed'].includes(old.status) && old.basis === basis;
    const resumable = checkpoint && !(restartChanged && old.fingerprint !== fingerprint);
    if (!restart && old?.basis === basis && old.status === 'complete') throw new HttpError(409, '阶段已完成。选择重新运行可生成新版本');
    if (resumable && old.fingerprint !== fingerprint) throw new HttpError(409, '模型或提示词已变更，恢复原配置或选择重新运行');
    const now = Date.now();
    const job = {
      id: resumable ? old.id : randomUUID(), stage, basis, fingerprint, status: 'running',
      cursor: resumable ? old.cursor : 0, total: rows.length, data: resumable ? old.data : [],
      elapsedMs: resumable ? old.elapsedMs : 0, sessionAt: now, updatedAt: now,
      requests: resumable ? old.requests : 0, usage: resumable ? old.usage : { input: 0, output: 0 }, error: '',
    };
    const controller = new AbortController();
    storage.saveJob(id, job);
    const handle = { controller, job, done: null };
    active.set(id, handle);
    handle.done = Promise.resolve().then(async () => {
      const signal = controller.signal;
      const write = () => {
        job.updatedAt = Date.now();
        storage.saveJob(id, job);
      };
      const elapsed = () => {
        const time = Date.now();
        job.elapsedMs += time - job.sessionAt;
        job.sessionAt = time;
      };
      const save = (cursor, data) => {
        signal.throwIfAborted();
        job.cursor = cursor;
        job.data = [...data];
        elapsed();
        write();
      };
      const log = (record) => {
        storage.log(id, { stage, job: job.id, cursor: job.cursor, ...record });
      };
      const model = modelClient(config, stage, signal, (record) => {
        job.requests += 1;
        job.usage.input += record.usage?.input ?? 0;
        job.usage.output += record.usage?.output ?? 0;
        log(record);
      });
      const note = (error) => log({ ok: false, finish: 'retry', error });
      try {
        let data;
        if (stage === 'scenes') {
          data = await modelSceneCuts(rows, {
            chat: async (prompt) => {
              const response = await model.chat(prompt);
              return response.truncated
                ? { ok: false, error: '模型输出达到 token 上限', content: response.content || '{}' }
                : { ok: true, content: response.content };
            },
            template: model.prompt, maxChars: MAX_SCENE_CHARS, startAt: job.cursor, initialCuts: job.data,
            onBatch: ({ done, cuts }) => save(done, cuts), onRetry: note,
          });
        } else {
          data = await runBatches(stage, rows, job, model, save, note);
        }
        signal.throwIfAborted();
        const fresh = storage.get(id);
        checkRevision(fresh, entry.revision);
        const provenance = { ...model.provenance, at: stamp() };
        if (numberedStage(stage)) {
          const prior = fresh.project[stage];
          const result = stage === 'scenes' ? { basis, provenance, rows: makeScenes(rows, data), cuts: data }
            : { basis, provenance, rows: makeCharacters(rows, data) };
          if (prior) storage.backup(fresh);
          if (!isDeepStrictEqual(prior?.rows, result.rows)) fresh.project.mentions = null;
          fresh.project[stage] = result;
        } else {
          fresh.suggestions = { ...fresh.suggestions, [stage]: { basis, rows: data, provenance } };
        }
        fresh.completedJobs = { ...fresh.completedJobs, [stage]: job.id };
        storage.save(fresh);
        job.status = 'complete';
      } catch (error) {
        job.status = signal.aborted ? 'paused' : 'failed';
        job.error = signal.aborted ? '已在最近一次保存的批次暂停' :
          error.code ? '阶段未保存，请检查磁盘或网关，再续跑' : error.message;
        try { log({ ok: false, finish: job.status, error: job.error }); } catch { /* 检查点仍可用于重试 */ }
      } finally {
        elapsed();
        job.sessionAt = null;
        last.set(id, job);
        active.delete(id);
        write();
      }
    }).catch(() => { /* 检查点文件中的运行中状态会在重启后作为暂停恢复 */ });
    return present(job);
  }

  function stop(id) {
    const running = active.get(id);
    if (!running) throw new HttpError(409, '没有正在运行的任务');
    running.job.status = 'stopping';
    running.controller.abort(Error('已暂停'));
    return present(running.job);
  }

  return {
    start, stop, assertIdle, present, read, wait: id => active.get(id)?.done,
    async shutdown() {
      const pending = [...active.values()];
      for (const job of pending) job.controller.abort(Error('应用已关闭'));
      await Promise.all(pending.map(job => job.done));
    },
  };
}


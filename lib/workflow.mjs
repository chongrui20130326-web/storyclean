import { randomUUID } from 'node:crypto';
import { listModels } from './gateway.mjs';
import { checkRevision } from './jobs.mjs';
import { bookBasis, saveCleaning, saveNumbering, saveReviewSources, validateProject } from './project.mjs';
import { makeMentions } from './tables.mjs';
import { HttpError } from './storage.mjs';

export function updateCleaning(storage, entry, input) {
  const before = { ...entry, project: { ...entry.project } };
  const basis = bookBasis(entry.project);
  const changed = saveCleaning(entry.project, input.edits);
  const reviewed = saveReviewSources(entry.project, entry.suggestions, input.adoptions, basis);
  if (!changed && !reviewed) return entry;
  storage.backup(before);
  return storage.save(entry);
}

export function saveMentions(project) {
  if (!project.numbered || !project.scenes || !project.characters) {
    throw new HttpError(400, '请先生成场景与角色真名表');
  }
  project.mentions = {
    basis: bookBasis(project), method: 'lexicon/v1',
    rows: makeMentions(project.numbered.sentences, project.scenes.rows, project.characters.rows),
  };
}

const modelStages = ['scenes', 'characters'];
const localModel = 'qwen3.5:4b';
const busy = status => status === 'running' || status === 'stopping';

async function resolveModels(config, pending, signal) {
  const unconfigured = pending.filter(stage => !config.stages[stage].model);
  if (!unconfigured.length) return config;
  const host = new URL(config.gateway).hostname;
  if (!['127.0.0.1', 'localhost', '[::1]'].includes(host)
    || !(await listModels(config, signal)).includes(localModel)) {
    throw Error('请在「模型与提示词」为场景和角色阶段选择模型。保存后可一键续跑。');
  }
  const stages = { ...config.stages };
  for (const stage of unconfigured) stages[stage] = { ...stages[stage], model: localModel };
  return { ...config, stages };
}

export function createWorkflow(storage, jobs, configOf) {
  const running = new Map();

  function read(id) {
    const live = running.get(id)?.status;
    if (live) return live;
    const status = storage.getJob(id, 'process');
    if (!status || !busy(status.status)) return status;
    return { ...status, status: 'paused', error: '应用已重启，可一键续跑。' };
  }

  function present(id, status = read(id)) {
    if (!status) return { status: 'idle' };
    const child = running.has(id) && modelStages.includes(status.phase) ? jobs.read(id, status.phase) : null;
    const detail = child && child.id === status.childId ? jobs.present(child) : null;
    return {
      ...status,
      total: 4,
      elapsedMs: status.elapsedMs + (running.has(id) ? Date.now() - running.get(id).started : 0),
      detail,
      download: status.status === 'complete' ? '/api/books/' + id + '/export' : null,
    };
  }

  function assertIdle(id) {
    if (running.has(id)) throw new HttpError(409, '一键处理正在运行，请等待或暂停');
  }

  function start(entry, input) {
    const { id } = entry;
    assertIdle(id);
    jobs.assertIdle(id);
    checkRevision(entry, input.revision);
    const current = input.edits ? updateCleaning(storage, entry, input) : entry;
    const basis = bookBasis(current.project);
    const prior = read(id);
    const resume = prior?.basis === basis && ['paused', 'failed'].includes(prior.status);
    const status = {
      stage: 'process', phase: 'number', status: 'running', id: resume ? prior.id : randomUUID(),
      cursor: 0, basis, updatedAt: Date.now(), elapsedMs: resume ? prior.elapsedMs : 0, error: '',
    };
    storage.saveJob(id, status);
    const controller = new AbortController();
    const task = { controller, status, started: Date.now(), done: null };
    running.set(id, task);

    const save = (phase, cursor) => {
      controller.signal.throwIfAborted();
      Object.assign(status, { phase, cursor, updatedAt: Date.now(), childId: null });
      storage.saveJob(id, status);
    };

    task.done = Promise.resolve().then(async () => {
      let working = current;
      try {
        if (!working.project.numbered) {
          saveNumbering(working.project);
          working = storage.save(working);
        }
        const pending = modelStages.filter(stage => !working.project[stage]);
        if (pending.length) save('prepare', 1);
        const config = pending.length ? await resolveModels(configOf(), pending, controller.signal) : null;
        for (const [index, stage] of modelStages.entries()) {
          save(stage, index + 1);
          if (working.project[stage]) continue;
          status.childId = jobs.start(working, { stage }, config, true).id;
          await jobs.wait(id);
          controller.signal.throwIfAborted();
          const completed = jobs.read(id, stage);
          if (completed.status !== 'complete') throw Error(completed.error || '模型阶段未完成，可一键续跑。');
          working = storage.get(id);
        }
        save('mentions', 3);
        if (!working.project.mentions) {
          saveMentions(working.project);
          working = storage.save(working);
        }
        validateProject(working.project);
        Object.assign(status, { status: 'complete', phase: 'export', cursor: 4 });
      } catch (error) {
        status.status = controller.signal.aborted ? 'paused' : 'failed';
        status.error = controller.signal.aborted ? '已保存当前进度，可一键续跑。'
          : error.code ? '工程读写失败，请检查数据目录后续跑。' : error.message;
      } finally {
        status.elapsedMs += Date.now() - task.started;
        status.updatedAt = Date.now();
        running.delete(id);
        storage.saveJob(id, status);
      }
    }).catch(error => console.error('一键处理状态写入失败', error.code || error.name));
    return present(id, status);
  }

  function stop(id) {
    const task = running.get(id);
    if (!task) throw new HttpError(409, '没有正在运行的一键任务');
    task.status.status = 'stopping';
    task.controller.abort(Error('已暂停'));
    if (jobs.wait(id)) jobs.stop(id);
    return present(id, task.status);
  }

  return {
    start, read, present, stop, assertIdle, running: id => running.has(id),
    async shutdown() {
      const tasks = [...running];
      for (const [id] of tasks) stop(id);
      await Promise.all(tasks.map(([, task]) => task.done));
    },
  };
}


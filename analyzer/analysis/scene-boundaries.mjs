export const SCENE_BATCH_CHARS = 5000;
export const MIN_SCENE_SENTENCES = 20;
export const ROLLING_SCENE_STRATEGY = 'semantic-rolling';

const transitions = new Set(['时间', '地点', '独立行动线', '同地新事件']);

export function validateSceneCuts(value, allowed) {
  if (value && Object.hasOwn(value, 'checks')) {
    if (!Array.isArray(value.checks)) throw Error('边界 checks 必须是数组');
    const candidates = [];
    for (const row of value.checks) {
      if (!row || typeof row.newScene !== 'boolean') throw Error('边界 newScene 必须是布尔值');
      if (!Number.isInteger(row.cut) || !Number.isInteger(row.next) || row.next !== row.cut + 1) {
        throw Error('cut 和 next 必须是相邻的原文整数句号');
      }
      if (row.newScene ? !transitions.has(row.change) : row.change !== '连续') throw Error('边界类型与切分判定矛盾');
      candidates.push(row.cut);
    }
    validateSceneCuts({ cuts: candidates }, allowed);
    return value.checks.filter(row => row.newScene).map(row => row.cut);
  }
  if (!Array.isArray(value?.cuts)) throw Error('切点 cuts 必须是数组');
  let previous = -Infinity;
  for (const cut of value.cuts) {
    if (!Number.isInteger(cut)) throw Error('切点必须是原文整数句号');
    if (!allowed.has(cut)) throw Error('切点 S' + cut + ' 超出本批允许的范围');
    if (cut <= previous) throw Error('切点必须严格递增且不能重复');
    previous = cut;
  }
  return value.cuts;
}

function takeBatch(sentences, start, maxChars) {
  const batch = [];
  let chars = 0;
  for (let i = start; i < sentences.length; i += 1) {
    const row = sentences[i];
    if (chars + row.text.length > maxChars) break;
    batch.push(row);
    chars += row.text.length;
  }
  return batch;
}

function buildPrompt(template, sentences, start, batch, pendingStart, allowed) {
  const previous = sentences.slice(Math.max(0, start - 2), start)
    .map(row => '[前文参考 S' + row.n + '] ' + row.text.slice(-1000)).join('\n');
  const afterward = sentences.slice(start + batch.length, start + batch.length + 2)
    .map(row => '[后文参考 S' + row.n + '，禁止作为切点] ' + row.text.slice(0, 1000)).join('\n');
  const allowedText = '【允许切点编号】' + (allowed.size ? [...allowed].join(', ') : '无');
  const output = '只返回 JSON 的 checks 数组。每项包含 cut（前场最后一句）、next（cut + 1）、change 和 newScene。没有可分界时返回 {"checks":[]}。';
  return [
    template,
    '【当前批次约束】若上方模板与此处冲突，以此处为准。一批约 5000 字完整句，按情节转场。每个成场至少 ' + MIN_SCENE_SENTENCES + ' 个编号句。',
    '当前尚未成场的第一句是 S' + sentences[pendingStart].n + '。同一场可以跨输入批次或章节。连续时保留为同一场。',
    '优先核对有明确时空或独立行动线变化的边界。保留完整的开场、问答、动作与后续反应。不要按字数、章末、批末或场数配额强行切。',
    start > pendingStart ? '本批第一句如果真正开启下一场，可把上一句作为切点。'
      : start > 0 ? '上一场已在 S' + sentences[start - 1].n + ' 结束，本批第一句已是新场的起点。请勿再报告上一场的切点。'
        : '本批第一句是待切段的起始句。',
    '本批末句与后文之间的边界留待下一批，用完整后文判断。正文结束由程序处理。',
    allowedText, output,
    '【上批末尾参考】', previous || '（无）',
    '【本批待判句子：完整原文】', batch.map(row => row.n + '. ' + row.text).join('\n'),
    '【后续参考】', afterward || '（全文末尾）', allowedText, output,
  ].join('\n');
}

async function inspectBatch(sentences, start, initialBatch, pendingStart, template, chat) {
  let batch = initialBatch;
  let feedback = '';
  let lastError;
  const committed = start === pendingStart && start > 0 ? sentences[start - 1].n : null;
  for (let rounds = 0; rounds < 4; rounds += 1) {
    const allowed = new Set(batch.slice(0, -1).map(row => row.n));
    if (start > pendingStart) allowed.add(sentences[start - 1].n);
    // A model can repeat the immediately preceding boundary even when it is already saved.
    const validationRange = committed === null ? allowed : new Set([committed, ...allowed]);
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const response = await chat(buildPrompt(template, sentences, start, batch, pendingStart, allowed) + feedback);
      const raw = String(response?.content ?? response?.text ?? '');
      if (response?.ok === false && !response.truncated && !raw.trim()) throw Error(response.error || '场景模型调用失败');
      try {
        if (response?.ok === false) throw Error(response.error || '场景模型输出无效');
        const value = JSON.parse(raw.slice(raw.indexOf('{'), raw.lastIndexOf('}') + 1));
        return { cuts: validateSceneCuts(value, validationRange).filter(cut => cut !== committed), end: start + batch.length };
      } catch (error) {
        lastError = error instanceof SyntaxError ? '模型未返回完整的 JSON' : error.message;
        feedback = '\n上次输出校验失败：' + lastError + '。只输出符合上方编号范围的 JSON。';
      }
    }
    if (batch.length < 2) break;
    batch = batch.slice(0, Math.ceil(batch.length / 2));
    feedback = '';
  }
  throw Error('场景切点校验失败（本批从 S' + initialBatch[0].n + ' 开始）：' + lastError);
}

function acceptCuts(candidates, cuts, positions, total, pending) {
  for (const cut of candidates) {
    const end = positions.get(cut) + 1;
    if (end - pending < MIN_SCENE_SENTENCES || total - end < MIN_SCENE_SENTENCES) continue;
    cuts.push(cut);
    pending = end;
  }
  return pending;
}

export async function modelSceneCuts(sentences, {
  chat, template = '', maxChars = SCENE_BATCH_CHARS, onBatch = () => {}, startAt = 0, reviewedTo = startAt, initialCuts = [],
} = {}) {
  if (!Number.isSafeInteger(maxChars) || maxChars < 1) throw Error('场景批次字数上限无效');
  const total = sentences.length;
  if (![startAt, reviewedTo].every(Number.isSafeInteger) || startAt < 0 || startAt > reviewedTo || reviewedTo > total) {
    throw Error('场景批次续跑位置无效');
  }
  const positions = new Map(sentences.map((row, index) => [row.n, index]));
  for (const row of sentences) {
    if (row.text.length > maxChars) throw Error('单句超过 ' + maxChars + ' 字，请先检查句子编号：S' + row.n);
  }
  const saved = validateSceneCuts({ cuts: initialCuts }, new Set(sentences.slice(0, startAt).map(row => row.n)));
  const cuts = [];
  let pending = acceptCuts(saved, cuts, positions, total, 0);
  if (cuts.length !== saved.length) throw Error('场景检查点不符合最少句数');
  if (total < 2 * MIN_SCENE_SENTENCES) {
    onBatch({ done: total, nextAt: total, total, cuts });
    return cuts;
  }
  let start = startAt;
  let reviewed = reviewedTo;
  while (start < total) {
    const batch = takeBatch(sentences, start, maxChars);
    const answer = await inspectBatch(sentences, start, batch, pending, template, chat);
    const accepted = acceptCuts(answer.cuts, cuts, positions, total, pending);
    // With a cut, re-pack the retained tail from its first sentence. With no cut the
    // open scene stays intact while we look farther ahead, avoiding the identical window.
    start = answer.end === total ? total : accepted > pending ? accepted : answer.end;
    pending = accepted;
    reviewed = Math.max(reviewed, answer.end);
    onBatch({ done: reviewed, nextAt: start, total, cuts: [...cuts] });
  }
  return cuts;
}

export function toSceneRanges(chapter, sentences, cuts, source = 'model') {
  if (!sentences.length) return [];
  const positions = new Map(sentences.map((row, index) => [row.n, index]));
  if (positions.size !== sentences.length) throw Error('原文句号重复');
  for (let i = 1; i < sentences.length; i += 1) {
    if (sentences[i].n !== sentences[i - 1].n + 1) throw Error('原文句号不连续，请先检查内容编号');
  }
  validateSceneCuts({ cuts }, new Set(positions.keys()));
  const ranges = [];
  let start = 0;
  for (const cut of cuts) {
    const end = positions.get(cut);
    ranges.push([start, end]);
    start = end + 1;
  }
  if (start < sentences.length) ranges.push([start, sentences.length - 1]);
  return ranges.map(([from, to], index) => {
    const rows = sentences.slice(from, to + 1);
    const sources = new Map(rows.map(row => [row.chapterId ?? chapter.id, row.chapterTitle ?? chapter.title ?? '']));
    const chapterIds = [...sources.keys()];
    const chapterTitles = [...sources.values()];
    return {
      chapterId: chapterIds[0], endChapterId: chapterIds.at(-1), chapterIds, chapterTitles,
      chapterTitle: chapterTitles.length === 1 ? chapterTitles[0] : chapterTitles[0] + ' ～ ' + chapterTitles.at(-1),
      from: 'S' + sentences[from].n, to: 'S' + sentences[to].n, sentences: to - from + 1,
      chars: rows.reduce((sum, row) => sum + row.text.length, 0), source, order: index + 1,
    };
  });
}


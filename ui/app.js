const $ = selector => document.querySelector(selector);
const stageLabels = { structure: '目录校对', body: '正文复核', scenes: '场景切分', characters: '角色真名' };
const defaultLocalModel = 'qwen3.5:4b';
const processLabels = { number: '内容编号', prepare: '检查模型', scenes: '场景切分', characters: '角色真名', mentions: '人称扫描', export: '工程已就绪' };
const statuses = { idle: '待运行', running: '运行中', stopping: '暂停中', paused: '已暂停', failed: '失败', complete: '已完成' };
const categories = { name: '姓名／别名', pronoun: '代词', kinship: '亲属称谓', role: '身份称谓', collective: '集体称呼' };
const workflow = [
  { key: 'clean', title: '小说清洗', description: '校对书名、目录和正文，按原文行号保留修改记录。', views: [['clean', '清洗正文'], ['source', '原稿'], ['audit', '清洗记录'], ['structure', '目录建议'], ['body', '正文建议']] },
  { key: 'sentences', title: '内容编号', description: '保存稳定的章、段、句号，逐句核对正文覆盖与原文行号。', views: [['numbered', '句子视图'], ['chapters', '章节目录']] },
  { key: 'scenes', title: '场景切分', description: '按完整句提交场景判断，跨章和跨批的连续叙事可以保留在同一场。', views: [['scenes', '场景总览'], ['partial', '批次检查点']] },
  { key: 'characters', title: '角色真名表', description: '从正文抽取名字和别名，按首次出现顺序编号并显示原句。', views: [['characters', '角色与证据']] },
  { key: 'mentions', title: '场景内人称', description: '词表扫描后按场景高亮。代词与称谓保留词类，共用别名显示候选。', views: [['scenes', '按场景高亮'], ['mentions', '人称表']] },
];

const state = {
  books: [], book: null, step: 0, view: 'clean', offset: 0, selectedScene: '', chapter: '', category: '',
  job: { status: 'idle' }, jobs: {}, rows: [], config: null, drafts: new Map(), adoptions: new Map(), downloads: new Map(),
  nav: 0, viewId: 0, pending: false, modelIds: [], modelScan: 0, configScan: 0,
};
const number = value => new Intl.NumberFormat('zh-CN').format(value);
const active = job => ['running', 'stopping'].includes(job.status);
const bookUrl = (id = state.book.id) => '/api/books/' + id;
const selection = () => ({ id: state.book.id, nav: state.nav, step: state.step, revision: state.book.revision });
const selected = ({ id, nav }) => state.book?.id === id && state.nav === nav;

function el(name, className, ...children) {
  const node = document.createElement(name);
  if (className) node.className = className;
  node.append(...children.filter(value => value !== null && value !== undefined));
  return node;
}

function button(title, action, value, options = {}) {
  const node = el('button', options.className || 'button', title);
  node.type = 'button';
  node.dataset.action = action;
  if (value != null) node.dataset.value = value;
  node.disabled = Boolean(options.disabled);
  return node;
}

function link(title, href) {
  const a = el('a', '', title);
  a.href = href;
  return a;
}

function notice(message, bad = false, id = '#notice') {
  const node = $(id);
  node.hidden = !message;
  node.textContent = message;
  node.classList.toggle('error', bad);
}

async function api(url, method = 'GET', data) {
  const binary = data instanceof Blob;
  const response = await fetch(url, {
    method,
    headers: data === undefined ? {} : { 'Content-Type': binary ? 'application/octet-stream' : 'application/json' },
    body: data === undefined ? undefined : binary ? data : JSON.stringify(data),
  });
  const value = await response.json();
  if (!response.ok) throw Error(value.error || '操作失败');
  return value;
}

function paintLibrary() {
  $('#book-count').textContent = state.books.length + ' 本';
  $('#library').replaceChildren(...state.books.map(item => {
    const row = button('', 'book', item.id);
    row.replaceChildren(el('strong', '', item.title), el('small', '', item.file));
    if (item.id === state.book?.id) row.setAttribute('aria-current', 'true');
    return row;
  }));
}

async function refreshLibrary() {
  state.books = await api('/api/books');
  paintLibrary();
}

async function openBook(id) {
  const nav = ++state.nav;
  const url = '/api/books/' + id;
  const [job, ...byStage] = await Promise.all([
    api(url + '/job'), ...Object.keys(stageLabels).map(stage => api(url + '/job?stage=' + stage)),
  ]);
  if (nav !== state.nav) return;
  const book = await api(url);
  if (nav !== state.nav) return;
  state.book = book;
  state.job = job;
  state.jobs = Object.fromEntries(Object.keys(stageLabels).map((stage, index) => [stage, byStage[index]]));
  $('#job-panel').replaceChildren();
  $('#welcome').hidden = true;
  $('#book').hidden = false;
  notice('');
  paintLibrary();
  paintBook();
  await setStep(0);
}

function paintBook() {
  const { title, file, encoding, counts, coverage, backups, notes, legacy, sourceHash } = state.book;
  document.title = title + ' · 小说清洗工作台';
  $('#book-title').textContent = title;
  $('#breadcrumb').textContent = title;
  $('#source-meta').textContent = file + '  ·  ' + encoding + '  ·  ' + number(state.book.lineCount) + ' 行原稿';
  $('#export').href = bookUrl() + '/export';
  const metrics = [['章', counts.chapters], ['段', counts.paragraphs], ['句', counts.sentences], ['场景', counts.scenes], ['角色', counts.characters], ['人称', counts.mentions]];
  $('#metrics').replaceChildren(...metrics.map(([name, count]) => el('div', '', el('dt', '', name), el('dd', '', count == null ? '—' : number(count)))));
  const detail = el('dl', 'detail-list');
  for (const [key, value] of [
    ['正文范围', number(counts.chars) + ' 个 UTF-16 单元'], ['编号覆盖', coverage ? (coverage.ratio * 100) + '%' : '待编号'],
    ['清洗记录', counts.audit + ' 条'], ['备份', backups + ' 份'], ...(legacy ? [['原工程', legacy]] : []),
  ]) detail.append(el('dt', '', key), el('dd', '', value));
  const checks = el('details', '', el('summary', '', '源文件 SHA-256'), el('small', 'muted', sourceHash));
  const backupView = backups ? button('查看备份', 'backups', null, { className: 'button quiet' }) : null;
  const backupLinks = el('div', 'actions');
  backupLinks.id = 'backup-links';
  $('#book-info').replaceChildren(...[detail, checks,
    el('div', 'actions', link('原始文件', bookUrl() + '/raw'), link('清洗 TXT', bookUrl() + '/cleaned'),
      link('清洗记录', bookUrl() + '/report'), link('兼容语料 JSON', bookUrl() + '/corpus')),
    backupView, backupLinks, ...[...notes, ...state.book.warnings].map(value => el('small', 'muted', value))].filter(Boolean));
}

function paintSteps() {
  const counts = state.book.counts;
  $('#steps').replaceChildren(...workflow.map(({ title, key }, index) => {
    const node = button('', 'step', index, { className: 'step' });
    node.append(el('span', 'step-number', String(index + 1)),
      el('span', '', el('span', 'step-name', title), el('span', 'step-state', key === 'clean' ? '已保存' : counts[key] === null ? '待处理' : '已保存')));
    if (index === state.step) node.setAttribute('aria-current', 'step');
    return node;
  }));
}

function actionForStage(stage, ready, title) {
  const prior = state.jobs[stage];
  const job = prior?.basis === state.book.basis ? prior : null;
  const resumable = ['failed', 'paused'].includes(job?.status);
  const restart = job?.status === 'complete' || (ready && !resumable);
  const disabled = active(state.job);
  const first = button(resumable ? '续跑' + title : restart ? '重新运行' + title : title, restart ? 'restart' : 'start', stage,
    { className: 'button primary', disabled });
  return resumable ? [first, button('从头重跑', 'restart', stage, { disabled })] : [first];
}

function paintActions() {
  const { key } = workflow[state.step];
  const { counts } = state.book;
  const busy = active(state.job);
  const process = $('#process');
  const draft = state.drafts.has(state.book.id);
  const resumable = state.job.stage === 'process' && state.job.basis === state.book.basis && ['paused', 'failed'].includes(state.job.status);
  process.disabled = busy;
  process.textContent = busy && state.job.stage === 'process' ? '一键处理中…'
    : !draft && counts.mentions !== null ? '下载完整工程'
      : resumable ? '一键续跑并导出' : '一键处理并导出';
  const actions = [];
  if (key === 'clean') {
    actions.push(button('校验预览', 'preview'), button('保存清洗', 'save-clean', null, { className: 'button primary', disabled: busy }));
  } else if (key === 'sentences') {
    actions.push(button(counts.sentences == null ? '保存编号' : '编号已保存', 'number', null, { className: 'button primary', disabled: busy || counts.sentences !== null }));
  } else if (key === 'mentions') {
    actions.push(button(counts.mentions == null ? '生成人称表' : '人称表已保存', 'mentions', null, {
      className: 'button primary', disabled: busy || counts.scenes === null || counts.characters === null || counts.mentions !== null,
    }));
  } else {
    actions.push(...(counts.sentences === null
      ? [button('先保存内容编号', 'step', 1)]
      : actionForStage(key, counts[key] !== null, key === 'scenes' ? '切分场景' : '生成角色真名')));
  }
  $('#stage-actions').replaceChildren(...actions);
  if (key === 'clean') {
    $('#suggestion-actions')?.replaceChildren(...actionForStage('structure', false, '模型校对目录'), ...actionForStage('body', false, '模型复核正文'));
  }
}

function editsToFields(edits) {
  return { title: edits.title, titleLine: edits.titleLine ?? '', headings: edits.headings.map(row => row.line + ' ' + row.title).join('\n'),
    removed: edits.removed.map(row => row.line + ' ' + row.reason).join('\n'), merges: edits.merges.join('\n') };
}

function readEdits(values) {
  const lines = (value, field) => value.split(/\r?\n/).filter(x => x.trim()).map(row => {
    const match = row.trim().match(/^(\d+)\s+(.+)$/);
    if (!match) throw Error('“' + field + '”每行须输入原文行号和内容，例如“12 第二章”。');
    return match.slice(1);
  });
  const merges = values.merges.trim() ? values.merges.trim().split(/[\s、，,]+/).map(value => {
    if (!/^\d+$/.test(value)) throw Error('合并行请填写原文行号。');
    return Number(value);
  }) : [];
  return {
    title: values.title, titleLine: values.titleLine === '' ? null : Number(values.titleLine),
    headings: lines(values.headings, '章节标题').map(([line, title]) => ({ line: Number(line), title })),
    removed: lines(values.removed, '移除行').map(([line, reason]) => ({ line: Number(line), reason })), merges,
  };
}

const fieldsToEdits = form => readEdits(Object.fromEntries(new FormData(form)));

function paintEditor() {
  const root = $('#stage-editor');
  root.replaceChildren();
  if (state.step !== 0) return;
  const fields = state.drafts.get(state.book.id) || editsToFields(state.book.edits);
  const makeField = (name, label, multiline = false, placeholder = '') => {
    const field = el(multiline ? 'textarea' : 'input');
    if (multiline) field.rows = 3;
    if (name === 'titleLine') {
      field.type = 'number';
      field.min = 1;
      field.step = 1;
    }
    field.name = name;
    field.value = fields[name];
    field.placeholder = placeholder;
    return el('label', '', label, field);
  };
  const form = el('form', 'form-grid edit-grid', makeField('title', '书名'), makeField('titleLine', '原稿书名行', false, '可留空'),
    makeField('headings', '章节标题 · 行号 + 标题', true, '例如 12 第二章 灯塔'),
    makeField('removed', '移除行 · 行号 + 原因', true, '例如 2 重复目录'),
    makeField('merges', '并入上一正文行 · 行号', true, '例如 10'));
  form.id = 'clean-form';
  form.addEventListener('submit', event => event.preventDefault());
  form.addEventListener('input', () => {
    state.drafts.set(state.book.id, Object.fromEntries(new FormData(form)));
    if (!active(state.job) && $('#process').textContent === '下载完整工程') $('#process').textContent = '一键处理并导出';
  });
  const details = el('details', '', el('summary', '', '调整书名、章节、移除行和断行'),
    el('p', 'editor-help', '行号以“原稿”显示为准。删掉清单里的一行即可恢复对应原文。章节、移除和合并各自独占一个原文行号。'), form);
  details.open = true;
  const tools = el('div', 'actions');
  tools.id = 'suggestion-actions';
  const preview = el('div', 'preview-note');
  preview.id = 'clean-preview';
  preview.hidden = true;
  root.append(el('div', 'editor', details, el('p', 'editor-help', '可选模型复核。采纳建议后可校验预览，再保存改动。'), tools, preview));
}

async function setStep(index) {
  state.step = index;
  state.chapter = '';
  state.category = '';
  const step = workflow[index];
  $('#stage-title').textContent = step.title;
  $('#stage-description').textContent = step.description;
  paintSteps();
  paintEditor();
  paintActions();
  paintJob();
  await changeView(step.views[0][0]);
}

function paintToolbar() {
  const toolbar = $('#view-toolbar');
  const step = workflow[state.step];
  const tabs = step.views.map(([key, title]) => {
    const node = button(title, 'view', key, { className: 'subtab' });
    node.setAttribute('aria-pressed', String(state.view === key));
    return node;
  });
  toolbar.replaceChildren(...tabs);
  if (state.view === 'scene') {
    toolbar.append(el('strong', 'muted', state.selectedScene), button('返回场景', 'view', 'scenes', { className: 'button quiet' }));
  }
  if (state.view === 'source') {
    const input = el('input');
    input.type = 'number';
    input.min = 1;
    input.max = state.book.lineCount;
    input.placeholder = '行号';
    input.setAttribute('aria-label', '跳至原文行号');
    const form = el('form', 'jump', input, button('跳转', 'jump', null, { className: 'button quiet' }));
    form.addEventListener('submit', event => {
      event.preventDefault();
      perform(() => jumpToLine(Number(input.value)));
    });
    toolbar.append(form);
  }
  if (state.view === 'mentions') {
    const select = el('select', 'filter');
    select.setAttribute('aria-label', '按词类筛选');
    for (const [key, label] of [['', '所有人称'], ...Object.entries(categories)]) {
      const option = el('option', '', label);
      option.value = key;
      option.selected = state.category === key;
      select.append(option);
    }
    select.addEventListener('change', () => perform(() => {
      state.category = select.value;
      return loadView(0);
    }));
    toolbar.append(select);
  }
  if (state.view === 'numbered' && state.chapter) {
    toolbar.append(el('span', 'pill', state.chapter), button('清除章筛选', 'clear-chapter', null, { className: 'button quiet' }));
  }
}

async function changeView(view, offset = 0) {
  state.view = view;
  paintToolbar();
  await loadView(offset);
}

function rowHtml(ref, ...contents) {
  return el('article', 'record', el('span', 'ref', ref), el('div', '', ...contents));
}

const hint = text => el('p', 'hint', text);
const line = text => el('p', 'line', text);
const sourceLink = n => button('原稿第 ' + n + ' 行', 'line', n, { className: 'button quiet' });
const actionLabels = { normalize: '规范文本', blank: '空白行', title: '识别书名', heading: '章标题', remove: '移除行', merge: '合并断行', body: '恢复正文' };
const boundaryLabels = { model: '模型切点', 'length-limit': '完整句限长', end: '正文结束' };

function highlighted(row) {
  const node = el('p', 'line');
  let start = 0;
  for (const m of row.mentions || []) {
    const mark = el('mark', 'mark ' + m.cls, m.surface);
    mark.title = m.id + ' · ' + categories[m.cls] + (m.characterId ? ' · ' + m.characterId
      : m.candidateIds.length ? ' · 候选 ' + m.candidateIds.join(' / ') : '');
    node.append(row.text.slice(start, m.start), mark);
    start = m.end;
  }
  node.append(row.text.slice(start));
  return node;
}

function displayRow(kind, row, index) {
  switch (kind) {
    case 'source':
      return Object.assign(rowHtml('L' + row.line, line(row.raw || '　')), { id: 'source-line-' + row.line });
    case 'clean':
      return rowHtml('L' + row.pieces[0].line, line(row.text), hint(row.chapter + (row.pieces.length > 1 ? ' · 已合并 ' + row.pieces.length + ' 行' : '')));
    case 'audit': {
      const tail = row.reason || (row.intoLine ? '并入原文第 ' + row.intoLine + ' 行' : row.after);
      return rowHtml('L' + row.line, el('strong', '', actionLabels[row.action]), line(row.before ?? ''), tail ? hint(tail) : null,
        row.model ? hint('采用模型建议 · ' + row.model) : null);
    }
    case 'structure':
    case 'body':
      return rowHtml('L' + row.line, line(row.text), hint(actionLabels[row.kind]),
        el('div', 'actions', button('采纳', 'suggestion', index, { className: 'button quiet' }), sourceLink(row.line)));
    case 'chapters':
      return rowHtml(row.id, button(row.title, 'chapter', row.id, { className: 'link-button', disabled: !row.from }),
        hint((row.from ? row.from + ' – ' + row.to : '无正文') + '  ·  ' + row.paragraphIds.length + ' 段'));
    case 'numbered':
    case 'scene':
      return rowHtml(row.id, kind === 'scene' ? highlighted(row) : line(row.text),
        hint(row.chapterId + '  ·  ' + row.paragraphId + '  ·  原稿 ' + row.source.map(r => 'L' + r.line).join('、')));
    case 'scenes':
    case 'partial':
      return rowHtml(row.sceneId,
        kind === 'scenes' ? button(row.from + ' – ' + row.to, 'scene', row.sceneId, { className: 'link-button' }) : el('strong', '', row.from + ' – ' + row.to),
        line(row.excerpt), hint(row.chapterTitle + '  ·  ' + row.sentences + ' 句  ·  ' + number(row.chars) + ' 字  ·  ' + (row.provisional ? '末场待续跑确认' : boundaryLabels[row.boundary])));
    case 'characters':
      return rowHtml(row.id, el('strong', '', row.name), hint('首见 ' + row.firstSeen + (row.aliases.length ? '  ·  别名 ' + row.aliases.join('、') : '')),
        ...row.evidence.map(e => el('div', 'evidence', hint(e.sentenceId + ' · ' + e.surface), line(e.text))));
    case 'mentions': {
      const reference = row.characterId || (row.candidateIds.length ? '候选 ' + row.candidateIds.join(' / ') : '');
      return rowHtml(row.id, el('strong', '', row.surface), hint([categories[row.cls], row.sceneId, row.sentenceId,
        '[' + row.start + ', ' + row.end + ')', row.inDialog ? '对白' : '叙述', reference].filter(Boolean).join(' · ')));
    }
  }
}

const emptyCopy = {
  clean: '暂无清洗正文。', audit: '这一版没有清洗记录。', structure: '当前清洗版本暂无目录建议。', body: '当前清洗版本暂无正文建议。',
  numbered: '保存内容编号后可逐句查看。', chapters: '保存内容编号后可查看章节目录。', scenes: '生成场景后可查看句号范围和正文。',
  partial: '暂无可展示的场景检查点。', characters: '当前没有可展示的角色姓名。', mentions: '当前没有可展示的人称。',
};

async function loadView(offset = state.offset) {
  const context = selection();
  const viewId = ++state.viewId;
  const kind = state.view;
  const query = new URLSearchParams({ kind, offset, limit: 40, scene: kind === 'scene' ? state.selectedScene : '', chapter: state.chapter, class: state.category });
  const result = await api(bookUrl(context.id) + '/view?' + query);
  if (!selected(context) || viewId !== state.viewId) return;
  state.offset = result.offset;
  state.rows = result.rows;
  $('#view-result').replaceChildren(...(result.rows.length ? result.rows.map((row, index) => displayRow(kind, row, index))
    : [el('p', 'empty', emptyCopy[kind] || '这一页没有记录。')]));
  const pager = $('#pager');
  pager.hidden = result.total <= result.limit;
  pager.replaceChildren(el('span', '', result.rows.length ? (result.offset + 1) + '–' + (result.offset + result.rows.length) + ' / ' + result.total : '共 ' + result.total + ' 条'),
    el('div', 'actions',
      button('上一页', 'page', Math.max(0, result.offset - result.limit), { className: 'button quiet', disabled: result.offset === 0 }),
      button('下一页', 'page', result.offset + result.limit, { className: 'button quiet', disabled: result.offset + result.limit >= result.total })));
}

function duration(ms) {
  if (ms == null) return '—';
  if (ms < 1000) return Math.round(ms) + ' 毫秒';
  const seconds = Math.round(ms / 1000);
  return seconds < 60 ? seconds + ' 秒' : Math.floor(seconds / 60) + ' 分 ' + seconds % 60 + ' 秒';
}

function paintJob() {
  const { stage, status, cursor, total, error, elapsedMs, phase, detail } = state.job;
  const automatic = stage === 'process';
  const model = automatic ? detail : state.job;
  const target = $('#job-panel');
  if (stage == null) {
    target.replaceChildren(el('p', 'muted', '暂无模型任务。'));
    return;
  }
  const progress = el('progress');
  progress.max = total || 1;
  const fraction = automatic && model?.total ? model.cursor / model.total : 0;
  progress.value = total ? cursor + fraction : (status === 'complete' ? 1 : 0);
  progress.setAttribute('aria-label', '已处理比例');
  const details = el('dl', 'detail-list');
  const items = [['已完成', cursor + ' / ' + total + (automatic ? ' 步' : '')], ['用时', duration(elapsedMs)]];
  if (automatic && phase) items.unshift(['当前阶段', processLabels[phase]]);
  if (model) items.push(
    ...(automatic ? [['当前批进度', model.cursor + ' / ' + model.total]] : []),
    ['平均每条', duration(model.averageMs)], ['预计剩余', duration(model.etaMs)],
    ['请求', String(model.requests)], ['输入 / 输出', number(model.usage.input) + ' / ' + number(model.usage.output) + ' token'],
  );
  for (const [key, value] of items) details.append(el('dt', '', key), el('dd', '', value));
  // Preserve an opened log across the live progress refreshes.
  const log = target.querySelector('details') || el('details', '', el('summary', '', '请求记录'),
    button('刷新记录', 'logs', null, { className: 'button quiet' }), el('ol', 'log-list'));
  if (!log.dataset.bound) {
    log.dataset.bound = 'true';
    log.addEventListener('toggle', () => { if (log.open) perform(fetchLogs); });
  }
  target.replaceChildren(...[el('div', 'job-row', el('strong', '', automatic ? '一键处理' : stageLabels[stage]), el('span', 'pill ' + status, statuses[status])),
    progress, details, error ? el('p', 'job-error', error) : null,
    active(state.job) ? button(status === 'stopping' ? '正在暂停…' : '暂停任务', 'stop', null, { disabled: status === 'stopping' }) : null, log].filter(Boolean));
}

async function fetchLogs() {
  const id = state.book.id;
  const rows = await api(bookUrl() + '/log');
  if (state.book.id !== id) return;
  const list = $('#job-panel .log-list');
  list?.replaceChildren(...rows.reverse().map(row => el('li', '',
    [new Date(row.at).toLocaleTimeString('zh-CN'), stageLabels[row.stage], row.error || row.finish, row.durationMs == null ? '' : duration(row.durationMs),
      row.usage ? row.usage.input + ' / ' + row.usage.output + ' token' : ''].filter(Boolean).join(' · '))));
}

async function fetchBackups() {
  const id = state.book.id;
  const base = bookUrl();
  const revisions = await api(base + '/backups');
  if (state.book.id === id) $('#backup-links').replaceChildren(...revisions.map(revision => link('版本 ' + revision, base + '/backup?revision=' + revision)));
}

async function reloadMeta(context) {
  const next = await api(bookUrl(context.id));
  if (!selected(context)) return false;
  state.book = next;
  paintBook();
  paintSteps();
  paintActions();
  await refreshLibrary();
  return selected(context);
}

async function poll() {
  if (!state.book || state.pending) return;
  state.pending = true;
  const context = selection();
  try {
    const before = state.job;
    const current = await api(bookUrl(context.id) + '/job');
    if (!selected(context)) return;
    finishDownload(context.id, current);
    for (const id of state.downloads.keys()) {
      if (id !== context.id || current.stage !== 'process') {
        void api(bookUrl(id) + '/process').then(job => finishDownload(id, job)).catch(() => {});
      }
    }
    if (current.status === 'idle' || current.status === before.status && !active(current) && current.id === before.id) return;
    state.job = current;
    if (current.stage !== 'process') state.jobs[current.stage] = current;
    paintJob();
    if (current.status !== before.status || current.id !== before.id) {
      paintActions();
      if (!active(current)) {
        if (!(await reloadMeta(context))) return;
        if (current.stage === 'scenes' && current.status === 'complete' && state.view === 'partial') await changeView('scenes');
        else await loadView(0);
        if (selected(context) && current.status === 'complete') {
          notice(current.stage === 'process' ? '一键处理已完成，可下载完整工程。' : stageLabels[current.stage] + '已完成。');
        }
      }
    } else if (state.view === 'partial' && (before.cursor !== current.cursor || before.detail?.cursor !== current.detail?.cursor)) await loadView(state.offset);
  } catch (error) {
    if (selected(context)) notice(error.message, true);
  } finally {
    state.pending = false;
  }
}

function downloadProject(url) {
  const anchor = link('', url);
  anchor.download = '';
  anchor.hidden = true;
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
}

function finishDownload(id, job) {
  if (!state.downloads.has(id) || state.downloads.get(id) !== job.id || active(job)) return;
  state.downloads.delete(id);
  if (job.status === 'complete' && job.download) downloadProject(job.download);
}

async function startProcess() {
  const context = selection();
  const draft = state.drafts.get(context.id);
  const adopted = state.adoptions.get(context.id);
  if (!draft && state.book.counts.mentions !== null) {
    downloadProject(bookUrl(context.id) + '/export');
    return;
  }
  $('#process').disabled = true;
  try {
    const input = { revision: context.revision };
    if (draft) Object.assign(input, { edits: readEdits(draft), adoptions: [...(adopted?.values() || [])] });
    const job = await api(bookUrl(context.id) + '/process', 'POST', input);
    state.downloads.set(context.id, job.id);
    if (state.drafts.get(context.id) === draft) state.drafts.delete(context.id);
    if (state.adoptions.get(context.id) === adopted) state.adoptions.delete(context.id);
    if (!selected(context)) return;
    state.job = job;
    paintJob();
    notice('正在一键处理，完成后将自动下载工程。');
  } finally {
    if (selected(context)) paintActions();
  }
}

async function jumpToLine(n) {
  if (!Number.isInteger(n) || n < 1 || n > state.book.lineCount) throw Error('请输入有效原文行号。');
  if (state.step !== 0) await setStep(0);
  await changeView('source', Math.floor((n - 1) / 40) * 40);
  const target = $('#source-line-' + n);
  target?.classList.add('line-target');
  target?.scrollIntoView({ block: 'nearest' });
}

function adopt(row) {
  const form = $('#clean-form');
  const edits = fieldsToEdits(form);
  const n = row.line;
  edits.headings = edits.headings.filter(x => x.line !== n);
  edits.removed = edits.removed.filter(x => x.line !== n);
  edits.merges = edits.merges.filter(x => x !== n);
  if (edits.titleLine === n) edits.titleLine = null;
  if (row.kind === 'title') Object.assign(edits, { title: row.text, titleLine: n });
  if (row.kind === 'heading') edits.headings.push({ line: n, title: row.text });
  if (row.kind === 'remove') edits.removed.push({ line: n, reason: row.text });
  if (row.kind === 'merge') edits.merges.push(n);
  state.drafts.set(state.book.id, editsToFields(edits));
  const adoptions = new Map(state.adoptions.get(state.book.id));
  adoptions.set(n, { stage: state.view, line: n, kind: row.kind });
  state.adoptions.set(state.book.id, adoptions);
  paintEditor();
  paintActions();
  notice('已将第 ' + n + ' 行建议加入草稿。');
}

async function saveEdits(preview) {
  const context = selection();
  const form = $('#clean-form');
  const edits = fieldsToEdits(form);
  const draft = state.drafts.get(context.id);
  const adopted = state.adoptions.get(context.id);
  const adoptions = [...(adopted?.values() || [])];
  const result = await api(bookUrl(context.id) + (preview ? '/preview' : '/clean'), 'PUT', { revision: context.revision, edits, adoptions });
  if (preview) {
    if (!selected(context) || !form.isConnected) return;
    const panel = $('#clean-preview');
    panel.hidden = false;
    panel.replaceChildren(el('strong', '', result.title), hint('共 ' + result.chapters.length + ' 章  ·  ' + result.changes + ' 条结构处理'),
      ...result.chapters.slice(0, 12).map(chapter => hint(chapter.title + '  ·  ' + chapter.paragraphs + ' 段')),
      ...result.warnings.map(hint), el('pre', '', result.sample));
    return;
  }
  const changed = context.revision !== result.revision;
  if (state.drafts.get(context.id) === draft) state.drafts.delete(context.id);
  if (state.adoptions.get(context.id) === adopted) state.adoptions.delete(context.id);
  if (!selected(context)) return refreshLibrary();
  if (!(await reloadMeta(context))) return;
  if (changed) state.jobs = {};
  if (state.step === 0) {
    paintEditor();
    paintActions();
    await changeView('clean');
  } else await loadView(0);
  if (selected(context)) {
    notice(changed ? '清洗已保存。编辑前的工程已备份。' : '清洗已保存。');
  }
}

async function startJob(stage, restart) {
  const context = selection();
  const job = await api(bookUrl(context.id) + '/job', 'POST', { stage, restart, revision: context.revision });
  if (!selected(context)) return;
  state.job = job;
  state.jobs[stage] = state.job;
  paintActions();
  paintJob();
  if (stage === 'scenes' && state.step === 2) await changeView('partial');
  if (state.step === 0 && (stage === 'body' || stage === 'structure')) await changeView(stage);
  if (selected(context)) notice('');
}

function rememberConfig(config) {
  state.config = config;
  state.configScan += 1;
  const stages = ['scenes', 'characters', ...['structure', 'body'].filter(stage => config.stages[stage].model)];
  const local = ['127.0.0.1', 'localhost', '[::1]'].includes(new URL(config.gateway).hostname);
  const fallback = local ? '自动选择 ' + defaultLocalModel + '（可用时）' : '未配置';
  $('#configured-models').replaceChildren(...stages.map(stage => {
    const model = config.stages[stage].model;
    const row = el('div', '', el('dt', '', stageLabels[stage]), el('dd', model ? '' : 'muted', model || fallback));
    row.dataset.stage = stage;
    return row;
  }));
}

async function refreshModelSummary() {
  if ($('#settings').open) return;
  const scan = ++state.configScan;
  try {
    const config = await api('/api/config');
    if (scan === state.configScan) rememberConfig(config);
  } catch {
    if (scan === state.configScan && !state.config) {
      $('#configured-models').replaceChildren(el('div', '', el('dt', '', '模型配置'), el('dd', 'muted', '读取失败')));
    }
  }
}

function paintModelPicker() {
  const form = $('#config');
  const scenes = form.elements['scenes-model'].value.trim();
  const characters = form.elements['characters-model'].value.trim();
  const select = $('#workflow-model');
  const option = (value, label) => Object.assign(el('option', '', label), { value });
  const automatic = option('', '自动使用本机 ' + defaultLocalModel + '（可用时）');
  const ids = [...new Set([...state.modelIds, ...(scenes && scenes === characters ? [scenes] : [])])];
  const choices = ids.map(id => option(id, state.modelIds.includes(id) ? id : id + '（当前设置）'));
  const mixed = scenes !== characters
    ? [Object.assign(option('', '沿用分阶段设置'), { disabled: true })]
    : [];
  select.replaceChildren(automatic, ...mixed, ...choices);
  if (mixed.length) select.selectedIndex = 1;
  else select.value = scenes;
  $('#workflow-model-hint').textContent = mixed.length
    ? '场景切分：' + (scenes || '自动') + '　角色真名：' + (characters || '自动')
    : '用于场景切分和角色真名。';
}

function paintConfig(config) {
  const form = $('#config');
  form.elements.gateway.value = config.gateway;
  form.elements.apiKey.value = '';
  form.elements.apiKey.placeholder = config.hasKey ? '已设置，留空保留当前密钥' : '网关无需认证时留空';
  form.elements.clearKey.checked = false;
  form.elements.maxTokens.value = config.maxTokens;
  form.elements.temperature.value = config.temperature;
  form.elements.timeout.value = config.timeoutMs / 1000;
  form.elements.disableReasoning.checked = config.disableReasoning !== false;
  $('#stage-config').replaceChildren(...Object.entries(config.stages).map(([key, value]) => {
    const model = el('input');
    model.name = key + '-model';
    model.setAttribute('list', 'models');
    model.placeholder = '输入模型 ID，或从模型列表选取';
    model.value = value.model;
    const prompt = el('textarea');
    prompt.name = key + '-prompt';
    prompt.rows = 3;
    prompt.required = true;
    prompt.value = value.prompt;
    return el('fieldset', 'settings-stage', el('legend', '', stageLabels[key]), el('label', '', '模型', model),
      el('label', '', '提示词 · v' + value.promptVersion, prompt));
  }));
  paintModelPicker();
}

async function refreshModels() {
  const scan = ++state.modelScan;
  const count = $('#model-count');
  count.textContent = '正在读取 LocalAI 模型…';
  try {
    const models = await api('/api/models');
    if (scan !== state.modelScan || !$('#settings').open) return;
    state.modelIds = models;
    $('#models').replaceChildren(...models.map(model => Object.assign(el('option'), { value: model })));
    paintModelPicker();
    count.textContent = models.length ? models.length + ' 个可用模型' : '网关未返回可用模型';
  } catch (error) {
    if (scan !== state.modelScan || !$('#settings').open) return;
    state.modelIds = [];
    $('#models').replaceChildren();
    paintModelPicker();
    count.textContent = '读取失败。' + error.message + '。可在下方检查 LocalAI 地址。';
  }
}

async function saveConfig(refresh) {
  const form = $('#config');
  if (!form.reportValidity()) return;
  const input = Object.fromEntries(new FormData(form));
  const stages = Object.fromEntries(Object.keys(stageLabels).map(key => [key, { model: input[key + '-model'], prompt: input[key + '-prompt'] }]));
  const next = await api('/api/config', 'PUT', {
    gateway: input.gateway, apiKey: input.apiKey, clearKey: form.elements.clearKey.checked,
    maxTokens: Number(input.maxTokens), temperature: Number(input.temperature), timeoutMs: Number(input.timeout) * 1000, stages,
    disableReasoning: form.elements.disableReasoning.checked,
  });
  if (state.config?.gateway !== next.gateway) {
    state.modelIds = [];
    $('#models').replaceChildren();
  }
  rememberConfig(next);
  paintConfig(state.config);
  if (refresh) {
    notice('网关设置已保存。', false, '#config-notice');
    await refreshModels();
  } else {
    $('#settings').close();
    notice('LocalAI 模型设置已保存。');
  }
}

async function perform(task, config = false) {
  try { await task(); }
  catch (error) { notice(error.message, true, config ? '#config-notice' : '#notice'); }
}

$('#import').addEventListener('change', event => perform(async () => {
  const file = event.target.files[0];
  if (!file) return;
  event.target.value = '';
  notice('正在导入 ' + file.name + '…');
  const book = await api('/api/books?name=' + encodeURIComponent(file.name), 'POST', file);
  await refreshLibrary();
  await openBook(book.id);
  notice('已导入 ' + book.title + '。');
}));
$('#open-settings').addEventListener('click', () => perform(async () => {
  const open = $('#open-settings');
  open.disabled = true;
  try {
    rememberConfig(await api('/api/config'));
    state.modelIds = [];
    $('#models').replaceChildren();
    notice('', false, '#config-notice');
    paintConfig(state.config);
    $('#settings').showModal();
    void refreshModels();
  } finally {
    open.disabled = false;
  }
}));
$('#settings').addEventListener('close', () => { state.modelScan += 1; });
$('#workflow-model').addEventListener('change', event => {
  const form = $('#config');
  form.elements['scenes-model'].value = event.target.value;
  form.elements['characters-model'].value = event.target.value;
  paintModelPicker();
});
$('#stage-config').addEventListener('input', event => {
  if (['scenes-model', 'characters-model'].includes(event.target.name)) paintModelPicker();
});
$('#config').addEventListener('submit', event => {
  event.preventDefault();
  perform(() => saveConfig(false), true);
});

const handlers = {
  book: id => openBook(id),
  step: value => setStep(Number(value)),
  view: kind => changeView(kind),
  page: offset => loadView(Number(offset)),
  line: value => jumpToLine(Number(value)),
  jump: (_, node) => jumpToLine(Number(node.form.querySelector('input').value)),
  chapter: id => { state.chapter = id; return changeView('numbered'); },
  'clear-chapter': () => { state.chapter = ''; return changeView('numbered'); },
  scene: id => { state.selectedScene = id; return changeView('scene'); },
  preview: () => saveEdits(true),
  'save-clean': () => saveEdits(false),
  suggestion: index => adopt(state.rows[Number(index)]),
  start: stage => startJob(stage, false),
  restart: stage => startJob(stage, true),
  stop: async () => {
    const context = selection();
    const job = await api(bookUrl(context.id) + '/stop', 'POST', {});
    if (!selected(context)) return;
    state.job = job;
    paintActions();
    paintJob();
  },
  logs: fetchLogs,
  backups: fetchBackups,
  process: startProcess,
  number: () => saveLocalStage('number', '内容编号已保存。', 'numbered'),
  mentions: () => saveLocalStage('mentions', '场景内人称已保存。点击场景查看高亮。', 'scenes'),
  'close-settings': () => $('#settings').close(),
  models: () => saveConfig(true),
  'refresh-models': refreshModels,
};

async function saveLocalStage(action, message, view) {
  const context = selection();
  const book = await api(bookUrl(context.id) + '/' + action, 'POST', { revision: context.revision });
  if (!selected(context)) return;
  state.book = book;
  paintBook();
  paintSteps();
  paintActions();
  if (state.step === context.step) await changeView(view);
  if (selected(context)) notice(message);
}

document.addEventListener('click', event => {
  const node = event.target.closest('button[data-action]');
  if (node && !node.disabled) {
    const task = handlers[node.dataset.action];
    if (task) perform(() => task(node.dataset.value, node), Boolean(node.closest('dialog')));
  }
});

void refreshModelSummary();
document.addEventListener('visibilitychange', () => {
  if (!document.hidden) void refreshModelSummary();
});
await perform(async () => {
  await refreshLibrary();
  if (state.books.length) await openBook(state.books[0].id);
  else $('#welcome').hidden = false;
});
setInterval(poll, 850);


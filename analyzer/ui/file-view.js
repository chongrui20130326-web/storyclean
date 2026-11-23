import './app.js';

const $ = id => document.getElementById(id);
const ui = window.analyzerUI;
const state = { book: '', file: null, files: [], listRequest: 0, version: 0, rawRequest: 0, tab: 'readable', page: 0, pages: 1, loaded: new Set() };
const formatter = new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 1 });

const purposes = {
  'initial.json': '保存导入的原稿、清洗后的书名和目录、编号结果及位置索引。导出初始工程时会用到。',
  'book.json': '按章、段、句保存可阅读的正文和编号。场景切分、角色识别和人称扫描都使用这份正文。',
  'number-mentions.json': '记录编号阶段扫出的代词和称谓，以及它们在哪一句、句中的位置。',
  'l2/scenes-llm.json': '保存最终场景，每条包含场景编号、章节、句号范围和字数。',
  'l2/scenes.progress.json': '记录已经核对的正文、确认的切点和下一批起点，供场景切分中断后继续。',
  'l2/scenes.done.json': '记录场景切分完成的时间和全书统计。',
  'l2/segmentation.verify.json': '检查场景是否覆盖正文，有无缺句、重复或处理错误。',
  'l2/characters.json': '保存已确认的角色编号、真名、稳定别名和姓名证据，供后续人称扫描使用。',
  'l2/scene-roles.json': '保存从工程导入的逐场角色、出场状态、本场称呼和原文证据。',
  'l2/scene-roles.progress.json': '保存已核对场景的角色、出场状态和证据，也记录继续处理的位置。',
  'l2/characters.progress.json': '旧版按正文批次累计的人名候选和续跑位置。新版逐场证据另有文件保存。',
  'l2/mention-table.json': '列出正文中命中的姓名、代词和称谓，以及所在场景、句子与已匹配角色。',
  'l2/mention-mapping.json': '保存逐场映射进度、人称编号、对应的角色编号和原句证据。',
  'l2/scene-mentions.preview.json': '记录上次预览时，在已切分场景中命中的姓名、代词和称谓。',
  'l2/relations.json': '保存角色真名表附带的已识别关系和证据句。',
  'l2/relations.progress.json': '保存角色关系附表已完成的章节与已提取关系，供中断后继续。',
  'l2/truncation-report.json': '记录模型处理失败的阶段、原因与时间，用于核对中断情况。',
};
const evidenceKinds = { name: '姓名', presence: '出场', mention: '提及', address: '本场称呼', identity: '身份对应',
  'cross-identity': '跨场身份依据', 'cross-action': '本场动作证据', alias: '别名' };
const mentionKinds = { name: '姓名', pronoun: '代词', kinship: '亲属或关系称谓', role: '身份称谓', collective: '群体称谓' };
const phases = { characters: '逐场识别', 'waiting-scenes': '等待第 3 步继续切分', review: '复核待确认身份', relations: '生成关系附表', done: '已完成' };
const types = { object: '分组', array: '列表', string: '文字', number: '数字', boolean: '状态', null: '空' };
const fieldLabels = {
  source: '原稿', clean: '清洗结果', cleanDoc: '清洗后内容', numbered: '编号结果', offsets: '原文位置索引',
  file: '文件名', encoding: '编码', text: '正文', bookName: '书名', title: '标题', id: '编号', generatedAt: '生成时间', at: '保存时间',
  coverage: '正文覆盖率', summary: '处理概要', warnings: '检查提示', errors: '错误记录', error: '最近错误', ok: '检查通过',
  chapters: '章节', chapterCount: '章节数', paragraphs: '段落', paragraphCount: '段落数', sentences: '句子', sentenceCount: '句数',
  frontMatter: '章前正文', from: '起始句或角色', to: '结束句或角色', chars: '字数', model: '模型',
  totals: '统计', scenes: '场景', sceneId: '场景编号', chapterTitle: '章节标题', chapterId: '章节编号',
  phase: '当前阶段', complete: '是否完成', cursor: '处理进度', cuts: '切点', nextAt: '下一批在正文中的索引',
  characters: '角色真名', candidates: '候选', people: '角色', roles: '本场角色', roleId: '角色编号', name: '姓名', label: '称呼',
  mentionId: '人称编号', characterIds: '对应角色编号', reviewed: '已跨场复核的场景数', results: '映射结果',
  aliases: '别名', evidence: '原文证据', status: '出场状态', kind: '证据类型', surface: '原文写法', sentence: '句号编号',
  mentions: '人称命中', total: '总数', characterId: '对应角色', cls: '人称类型', relations: '角色关系', failures: '失败记录', reason: '原因',
};
const recordPageSize = 20;
const richLimit = 24 * 1024 * 1024;
const purposeOf = name => purposes[name] || '查看这份生成文件中的数据。';

function element(tag, className, label) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (label !== undefined) node.textContent = label;
  return node;
}

function button(label, activate, className = 'ghost') {
  const target = element('button', className, label);
  target.type = 'button';
  target.addEventListener('click', activate);
  return target;
}

function note(text, error = false) {
  return element('p', 'file-empty' + (error ? ' operation-error' : ''), text);
}

const items = value => Array.isArray(value) ? value : [];
const sentence = value => Number.isInteger(value) ? 'S' + value : value;
const range = row => row?.from && row?.to ? row.from + ' ～ ' + row.to : '';
const words = value => items(value).filter(Boolean).join('、');
const stamp = value => typeof value === 'string' && !Number.isNaN(Date.parse(value)) ? new Date(value).toLocaleString('zh-CN') : '';
const facts = value => Object.entries(value).filter(([, entry]) => entry !== undefined && entry !== null && entry !== '');
const report = (metrics, ...groups) => ({ metrics, groups });
const section = (title, rows, describe) => ({ title, rows: items(rows), describe });
const entry = (title, fields, body, children) => ({ title, fields, body, children });
const excerpt = (value, length = 1000) => typeof value === 'string' && value.length > length ? value.slice(0, length) + '…' : value;
const errors = rows => section('错误记录', rows, value => entry(value));
const warnings = rows => section('检查提示', rows, value => entry(value));

function evidenceSection(rows) {
  return section('原文证据', rows, row => entry(
    [evidenceKinds[row.kind] || '原句', sentence(row.sentence), row.surface].filter(Boolean).join(' · '),
    null, row.text && row.text !== row.surface ? excerpt(row.text) : '',
  ));
}

function sceneStats(totals = {}) {
  return { 场景: totals.scenes, 章节: totals.chapters, 正文句数: totals.sentences, 字数: totals.chars, 平均每场句数: totals.avgSentences };
}

function mentionRecord(row) {
  const type = row.cls || row.category;
  return entry(row.surface || row.text || row.id, {
    编号: row.id, 类型: mentionKinds[type] || type, 原句: sentence(row.sentence ?? row.sentenceId),
    场景: row.sceneId, 对应角色: row.characterId, 位置: row.inDialog ? '对白中' : '',
    句中起点: Number.isInteger(row.start ?? row.offset) ? '第 ' + ((row.start ?? row.offset) + 1) + ' 个字符' : '',
  });
}

const mentionSection = rows => section('命中记录', rows, mentionRecord);
const headingSection = rows => section('章节', rows, row => entry(row.title || row.id, {
  编号: row.id, 句号范围: range(row), 段落: items(row.paragraphs).length,
}));
const numberedSection = rows => section('编号原句', rows, row => entry(row.sid || row.id, { 章节: row.chapterTitle, 段落: row.paragraph }, row.text));
const personSection = (title, rows) => section(title, rows, row => entry(row.name || row.label || '姓名待确认', {
  角色编号: row.id, 别名: words(row.aliases), 最早记录: sentence(row.firstSeen),
}, null, evidenceSection(row.evidence)));
const relationSection = rows => section('角色关系', rows, row => entry(
  [row.fromName || row.from, row.type, row.toName || row.to].filter(Boolean).join(' → '),
  { 章节: row.chapter }, null, evidenceSection(row.evidence),
));

function readableData(name, doc) {
  switch (name) {
    case 'initial.json': {
      const numbered = doc.numbered || {};
      const clean = doc.clean?.cleanDoc;
      const encoding = { utf8: 'UTF-8', utf16le: 'UTF-16 LE', utf16be: 'UTF-16 BE', gb18030: 'GB18030' }[doc.source?.encoding];
      return report({
        原稿文件: doc.source?.file, 书名: clean?.书名, 文本编码: encoding || doc.source?.encoding,
        清洗状态: clean ? '已清洗' : '直接编号', 章节: numbered.totals?.chapters, 段落: numbered.totals?.paragraphs,
        编号句数: numbered.totals?.sentences, 正文覆盖率: typeof numbered.coverage?.ratio === 'number'
          ? formatter.format(numbered.coverage.ratio * 100) + '%' : '',
      }, section('清洗目录', clean?.目录, value => entry(value)), headingSection(numbered.chapters),
      numberedSection(numbered.sentences),
      section('清洗记录', doc.clean?.issues, row => entry(row.title, { 状态: row.applied ? '已应用' : '供复核' }, row.reason || row.detail)),
      section('正文节选', [
        { label: '原稿开头', text: doc.source?.text }, { label: '清洗后正文开头', text: clean?.正文 },
      ].filter(row => row.text), row => entry(row.label, null, excerpt(row.text, 1600))),
      warnings(numbered.warnings));
    }
    case 'book.json': {
      const rows = items(doc.chapters).flatMap(chapter => items(chapter.paragraphs).flatMap(paragraph =>
        items(paragraph.sentences).map(row => ({ ...row, chapterTitle: chapter.title, paragraph: paragraph.id }))));
      return report({ 书名: doc.title, 章节: doc.chapterCount, 段落: doc.paragraphCount, 正文句数: doc.sentenceCount, 章前句数: items(doc.frontMatter).length },
        headingSection(doc.chapters), numberedSection(rows),
        section('章前文字', doc.frontMatter, row => entry(row.id, null, row.text)), warnings(doc.warnings));
    }
    case 'l2/scenes-llm.json':
      return report({ ...sceneStats(doc.totals), 使用模型: doc.model, 生成时间: stamp(doc.generatedAt) },
        section('场景列表', doc.scenes, row => entry(row.sceneId, { 章节: row.chapterTitle || row.chapterId,
          句号范围: range(row), 句数: row.sentences, 字数: row.chars })), warnings(doc.warnings));
    case 'l2/scenes.progress.json':
      return report({ 已核对正文句数: doc.cursor, 已确认切点: items(doc.cuts).length,
        下一批在正文中的序位: Number.isInteger(doc.nextAt) ? doc.nextAt + 1 : null,
        已完成章节: items(doc.chapters).length, 使用模型: doc.model, 保存时间: stamp(doc.at) },
      section('已确认的场景结束句', doc.cuts, (value, index) => entry('第 ' + (index + 1) + ' 场', { 结束句: sentence(value) })),
      section('已完成章节', doc.chapters, value => entry(value)));
    case 'l2/scenes.done.json':
      return report({ ...sceneStats(doc.totals), 场景: doc.scenes ?? doc.totals?.scenes, 完成时间: stamp(doc.at) });
    case 'l2/segmentation.verify.json':
      return report({ 校验结果: doc.ok ? '通过' : '未通过', 正文句数: doc.totalSentences, 已覆盖句数: doc.coveredSentences,
        缺失句数: doc.missingSentences, 重复句数: doc.duplicateSentences, 场景: doc.scenes, 检查时间: stamp(doc.checkedAt) },
      errors(doc.errors), warnings(doc.warnings));
    case 'l2/characters.json':
      return report({ 具名角色: items(doc.characters).length, 使用模型: doc.model, 生成时间: stamp(doc.generatedAt) },
        personSection('角色真名表', doc.characters));
    case 'l2/characters.progress.json':
      return report({ 已处理批次: doc.cursor, 总批次: doc.total, 旧版候选: items(doc.candidates).length,
        处理状态: doc.complete ? '已完成' : '断点已保存', 模型: doc.model, 保存时间: stamp(doc.at), 最近错误: doc.error },
      section('旧版人名候选', doc.candidates, row => entry(row.name, { 候选称呼: words(row.aliases) })));
    case 'l2/scene-roles.json':
    case 'l2/scene-roles.progress.json':
      return sceneRolesData(doc);
    case 'l2/mention-mapping.json': {
      const scenes = items(doc.scenes);
      const counts = { mapped: 0, pending: 0, nonperson: 0 };
      for (const scene of scenes) for (const row of items(scene.results)) counts[row.status] += 1;
      return report({ 处理状态: { local: '本场映射', review: '跨场复核', done: '已完成' }[doc.phase],
        已映射: counts.mapped, 待确认: counts.pending, 非人物: counts.nonperson, 跨场复核场数: doc.reviewed,
        使用模型: doc.model, 保存时间: stamp(doc.at), 最近错误: doc.error },
      section('逐场人称映射', scenes, scene => entry(scene.sceneId, { 人称: items(scene.results).length }, null,
        section('人称记录', scene.results, row => entry(row.mentionId, {
          状态: { mapped: '已映射', pending: '待确认', nonperson: '非人物' }[row.status], 角色编号: words(row.characterIds),
          来源: { exact: '真名表匹配', local: '场景原句', retrieval: '跨场检索' }[row.method],
        }, null, evidenceSection(row.evidence))))));
    }
    case 'number-mentions.json':
    case 'l2/mention-table.json':
    case 'l2/scene-mentions.preview.json':
      return report({ 预览场数: doc.previewKey ? doc.scenes : null, 命中次数: doc.totals?.mentions ?? doc.total ?? items(doc.mentions).length,
        姓名: doc.totals?.name, 代词: doc.totals?.pronoun, 称谓: doc.totals?.kinship, 生成时间: stamp(doc.generatedAt),
        数据来源: doc.method || '编号阶段词表扫描' }, mentionSection(doc.mentions));
    case 'l2/relations.json':
    case 'l2/relations.progress.json':
      return report({ 已发现关系: items(doc.relations).length, 已处理章节: doc.totals?.chapters ?? doc.chapters?.length,
        保存时间: stamp(doc.at || doc.generatedAt), 使用模型: doc.model },
      relationSection(doc.relations), section('已处理章节', doc.chapters, value => entry(value)));
    case 'l2/truncation-report.json':
      return report({ 失败次数: items(doc.failures).length, 报告时间: stamp(doc.generatedAt) },
      section('失败详情', doc.failures, row => entry(row.phase || '模型处理', { 时间: stamp(row.at), 处理工具: row.tool }, row.reason)));
    default:
      return report({});
  }
}

function sceneRolesData(doc) {
  const people = new Map(items(doc.people).map(person => [person.id, person]));
  const display = role => {
    const person = people.get(role.roleId);
    return person?.name || items(role.evidence).find(row => row.kind === 'address')?.surface || person?.label || '未具名人物';
  };
  const group = role => !people.get(role.roleId)?.name || role.status === 'uncertain' ? '待确认'
    : role.status === 'present' ? '确认出场' : '仅被提及';
  const roleEvidence = role => {
    const local = items(role.evidence);
    const retrieved = items(people.get(role.roleId)?.identityLinks).filter(({ mention }) =>
      local.some(row => row.kind === 'address' && row.sentence === mention.sentence && row.start === mention.start));
    return evidenceSection([...local, ...retrieved.flatMap(({ proof, bridge }) => [
      ...(bridge ? [{ ...bridge, kind: 'cross-action' }] : []), { ...proof, kind: 'cross-identity' },
    ])]);
  };
  return report({ 已核对场景: items(doc.scenes).length, 具名角色: [...people.values()].filter(person => person.name).length,
    当前阶段: phases[doc.phase] || (doc.complete ? '已完成' : '逐场结果已保存'), 当前场景: doc.draft?.scene?.sceneId,
    身份复核: doc.retrievalVersion === 'book-hybrid-v1' ? '本书混合检索' : doc.retrievalVersion === 'book-quotes-v1' ? '本书原句检索' : '',
    向量模型: doc.retrievalModel,
    使用模型: doc.model, 保存时间: stamp(doc.at), 最近错误: doc.error },
  section('逐场结果', doc.scenes, scene => {
    const roles = items(scene.roles);
    const groups = Object.fromEntries(['确认出场', '仅被提及', '待确认'].map(key => [
      key, roles.filter(role => group(role) === key).map(display).join('、') || '无',
    ]));
    return entry(scene.sceneId, { 句号范围: range(scene), ...groups }, null,
      section('本场人物与证据', roles, role => entry(display(role), {
        角色编号: role.roleId, 状态: group(role),
        本场判断: { present: '实际出场', mentioned: '仅被提及', uncertain: '出场待确认' }[role.status],
        本场称呼: words([...new Set(items(role.evidence).filter(row => row.kind === 'address').map(row => row.surface))]),
      }, null, roleEvidence(role))));
  }), personSection('角色与姓名证据', doc.people));
}

function factList(values, className) {
  const fields = facts(values || {});
  if (!fields.length) return null;
  const list = element('dl', className);
  for (const [label, value] of fields) {
    const formatted = typeof value === 'number' ? formatter.format(value) : String(value);
    const item = element('div');
    item.append(element('dt', '', label), element('dd', '', formatted));
    list.append(item);
  }
  return list;
}

function paintRecord(data) {
  const card = element('article', 'file-record');
  card.append(element('h5', '', data.title));
  const fields = factList(data.fields, 'file-record-facts');
  if (fields) card.append(fields);
  if (data.body) card.append(element('p', 'file-record-body', data.body));
  if (data.children?.rows.length) {
    const details = element('details', 'file-record-expand');
    details.append(element('summary', '', data.children.title + '（' + data.children.rows.length + '）'));
    details.addEventListener('toggle', () => {
      if (details.open && details.childElementCount === 1) details.append(paintRecordGroup(data.children, true));
    });
    card.append(details);
  }
  return card;
}

function paintRecordGroup(group, nested = false) {
  const result = element('section', 'file-record-group' + (nested ? ' nested' : ''));
  if (!nested) result.append(element('h4', '', group.title + '（' + formatter.format(group.rows.length) + '）'));
  const records = element('div', 'file-records');
  result.append(records);
  const pages = Math.max(1, Math.ceil(group.rows.length / recordPageSize));
  let current = 0;
  const paging = element('div', 'file-pages file-record-nav');
  const pageLabel = element('span');
  pageLabel.setAttribute('aria-live', 'polite');
  const previous = button('上一页', () => draw(current - 1));
  const next = button('下一页', () => draw(current + 1));
  paging.append(previous, pageLabel, next);
  if (pages > 1) result.append(paging);
  function draw(page) {
    current = Math.max(0, Math.min(pages - 1, page));
    const start = current * recordPageSize;
    records.replaceChildren(...group.rows.slice(start, start + recordPageSize)
      .map((value, index) => paintRecord(group.describe(value, start + index))));
    pageLabel.textContent = '第 ' + (current + 1) + ' / ' + pages + ' 页';
    previous.disabled = current === 0;
    next.disabled = current === pages - 1;
  }
  draw(0);
  return result;
}

function paintReadable(panel, data) {
  const summary = factList(data.metrics, 'file-metrics');
  const groups = data.groups.filter(group => group.rows.length).map(group => paintRecordGroup(group));
  const entries = summary ? [summary, ...groups] : groups;
  panel.replaceChildren(...(entries.length ? entries : [note('这份文件暂无可解读的记录。可查看数据结构或 JSON 内容。')]));
}

async function showReadable(version) {
  const panel = $('fileReadable');
  panel.replaceChildren(note('正在解析文件…'));
  if (state.file.bytes > richLimit) {
    const list = element('ul', 'json-list file-large-tree');
    panel.replaceChildren(note('大文件按中文字段逐层展开。点击列表查看具体记录。'), list);
    await appendChildren(list, '', 0, version, true);
    return;
  }
  const controller = new AbortController();
  state.readableRequest = controller;
  const name = state.file.name;
  try {
    const response = await fetch(fileUrl({ view: 'download' }), { signal: controller.signal });
    if (!response.ok) throw Error('读取文件失败（HTTP ' + response.status + '）');
    const document = await response.json();
    if (version !== state.version) return;
    paintReadable(panel, readableData(name, document));
  } catch (error) {
    if (version !== state.version || controller.signal.aborted) return;
    panel.replaceChildren(note(error instanceof SyntaxError ? '这份文件暂时无法解析为 JSON。' : error.message, true),
      button('重新解析', () => { void showReadable(version); }));
  }
}

async function api(route, params) {
  const response = await fetch(route + '?' + new URLSearchParams(params));
  const output = await response.json();
  if (!response.ok) throw Error(output.error || '读取失败');
  return output;
}

function fileUrl(query = {}) {
  return '/api/book/file?' + new URLSearchParams({ id: state.book, name: state.file.name, ...query });
}

function readFile(query) {
  return api('/api/book/file', { id: state.book, name: state.file.name, ...query });
}

function displaySize(bytes) {
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return formatter.format(bytes / 1024) + ' KiB';
  return formatter.format(bytes / (1024 * 1024)) + ' MiB';
}

function paintList() {
  const rows = state.files.map(file => {
    const row = button('', () => selectFile(file), 'file-row');
    row.dataset.file = file.name;
    row.setAttribute('aria-pressed', String(file.name === state.file?.name));
    row.append(element('strong', '', file.label), element('small', 'file-row-name', file.name + ' · ' + displaySize(file.bytes)),
      element('small', 'file-row-purpose', purposeOf(file.name)));
    return row;
  });
  $('generatedFiles').replaceChildren(...(rows.length ? rows : [
    note(state.book ? '这本书还没有生成 JSON 文件。' : '请先在上方选择已编号的书籍。'),
  ]));
}

function selectFile(file, tab = 'readable') {
  state.version += 1;
  state.readableRequest?.abort();
  state.file = file;
  state.loaded.clear();
  state.page = 0;
  state.pages = 1;
  paintList();
  $('fileSelected').hidden = !file;
  $('filePlaceholder').hidden = Boolean(file);
  if (!file) return;
  $('fileTitle').textContent = file.label;
  $('filePurpose').textContent = purposeOf(file.name);
  $('fileMeta').textContent = file.name + ' · ' + displaySize(file.bytes) + ' · ' + new Date(file.updatedAt).toLocaleString('zh-CN');
  $('fileDownload').href = fileUrl({ view: 'download' });
  $('fileTree').replaceChildren();
  $('fileReadable').replaceChildren();
  $('fileContent').textContent = '';
  showTab(tab);
}

async function loadList(force = false) {
  if (ui.currentView() !== 'files') return;
  const book = ui.currentBookId();
  const sameBook = book === state.book;
  const version = ++state.listRequest;
  state.book = book;
  if (!sameBook) {
    state.files = [];
    selectFile(null);
  }
  if (!book) {
    paintList();
    return;
  }
  $('generatedFiles').setAttribute('aria-busy', 'true');
  try {
    const files = await api('/api/book/files', { id: book });
    if (version !== state.listRequest || ui.currentView() !== 'files') return;
    const selected = files.find(file => file.name === state.file?.name);
    const unchanged = selected?.bytes === state.file?.bytes && selected?.updatedAt === state.file?.updatedAt;
    state.files = files;
    if (selected && unchanged && !force) paintList();
    else selectFile(selected || files[0] || null, selected ? state.tab : 'readable');
  } catch (error) {
    if (version === state.listRequest) {
      selectFile(null);
      $('generatedFiles').replaceChildren(note(error.message, true));
    }
  } finally {
    if (version === state.listRequest) $('generatedFiles').removeAttribute('aria-busy');
  }
}

function nodeBody(node, key, readable) {
  const row = element('span', 'json-node-value');
  if (key !== undefined) row.append(element('span', 'json-key', readable && Object.hasOwn(fieldLabels, key) ? fieldLabels[key] : key));
  row.append(element('span', 'json-type', readable ? types[node.type] : node.type));
  if (node.type === 'object' || node.type === 'array') {
    row.append(element('span', 'json-size', node.total + (node.type === 'object' ? ' 个字段' : ' 项')));
  } else {
    const label = readable && node.type === 'boolean' ? (node.preview === 'true' ? '是' : '否') : node.preview;
    row.append(element('code', 'json-value', label));
    if (node.type === 'string' && node.preview.endsWith('…')) row.append(element('span', 'json-size', node.length + ' 字符'));
  }
  return row;
}

function nodeItem(node, parentType, version, readable) {
  const item = element('li', 'json-node');
  const key = parentType === 'array' ? (readable ? '第 ' + (Number(node.key) + 1) + ' 项' : '[' + node.key + ']') : node.key === '' ? '""' : node.key;
  if (!node.total) {
    item.append(nodeBody(node, key, readable));
    return item;
  }
  const disclosure = element('details', 'json-disclosure');
  disclosure.dataset.pointer = node.pointer;
  const summary = element('summary');
  summary.append(nodeBody(node, key, readable));
  const children = element('ul', 'json-list');
  disclosure.append(summary, children);
  item.append(disclosure);
  const load = (offset = 0) => appendChildren(children, node.pointer, offset, version, readable);
  disclosure.addEventListener('toggle', () => {
    if (disclosure.open && !children.hasChildNodes()) void load();
  });
  return item;
}

async function appendChildren(list, pointer, offset, version, readable = false) {
  if (version !== state.version) return;
  const loading = note('正在读取结构…');
  list.append(loading);
  try {
    const data = await readFile({ view: 'tree', pointer, offset });
    if (version !== state.version) return;
    loading.remove();
    if (offset === 0 && pointer === '') {
      const root = element('li', 'json-root');
      root.append(nodeBody(data, readable ? '文件字段' : '根节点', readable));
      list.append(root);
    }
    for (const node of data.children) list.append(nodeItem(node, data.type, version, readable));
    if (data.next !== null) {
      const more = element('li', 'json-node');
      const action = button('加载更多字段', () => {
        more.remove();
        void appendChildren(list, pointer, data.next, version, readable);
      });
      more.append(action);
      list.append(more);
    }
  } catch (error) {
    if (version !== state.version) return;
    loading.remove();
    const failed = element('li', 'json-node');
    failed.append(note(error.message, true), button('重试', () => {
      failed.remove();
      void appendChildren(list, pointer, offset, version, readable);
    }));
    list.append(failed);
  }
}

async function showRaw(page) {
  const version = state.version;
  const request = ++state.rawRequest;
  const content = $('fileContent');
  content.textContent = '正在读取 JSON…';
  $('filePrev').disabled = true;
  $('fileNext').disabled = true;
  try {
    const data = await readFile({ view: 'text', page });
    if (request !== state.rawRequest || version !== state.version) return;
    state.page = data.page;
    state.pages = data.pages;
    let text = data.text;
    if (data.pages === 1) {
      try { text = JSON.stringify(JSON.parse(text), null, 2); }
      catch { /* A file mid-write can still be viewed as text. */ }
    }
    content.textContent = text;
    content.scrollTop = 0;
    $('filePages').textContent = '第 ' + (state.page + 1) + ' / ' + state.pages + ' 页';
    $('filePrev').disabled = state.page === 0;
    $('fileNext').disabled = state.page + 1 >= state.pages;
  } catch (error) {
    if (request === state.rawRequest && version === state.version) {
      content.textContent = error.message + '。可点击「刷新文件」重试。';
      $('filePages').textContent = '';
    }
  }
}

function showTab(tab) {
  state.tab = tab;
  $('fileReadableTab').setAttribute('aria-pressed', String(tab === 'readable'));
  $('fileTreeTab').setAttribute('aria-pressed', String(tab === 'tree'));
  $('fileContentTab').setAttribute('aria-pressed', String(tab === 'text'));
  $('fileReadable').hidden = tab !== 'readable';
  $('fileTree').hidden = tab !== 'tree';
  $('fileRawPanel').hidden = tab !== 'text';
  if (!state.file || state.loaded.has(tab)) return;
  state.loaded.add(tab);
  if (tab === 'readable') void showReadable(state.version);
  else if (tab === 'tree') void appendChildren($('fileTree'), '', 0, state.version);
  else void showRaw(0);
}

$('refreshFiles').onclick = () => { void loadList(true); };
$('fileReadableTab').onclick = () => showTab('readable');
$('fileTreeTab').onclick = () => showTab('tree');
$('fileContentTab').onclick = () => showTab('text');
$('filePrev').onclick = () => { if (state.page > 0) void showRaw(state.page - 1); };
$('fileNext').onclick = () => { if (state.page + 1 < state.pages) void showRaw(state.page + 1); };
document.addEventListener('analyzer:viewchange', event => { if (event.detail.view === 'files') void loadList(); });
document.addEventListener('analyzer:bookchange', () => { if (ui.currentView() === 'files') void loadList(); });


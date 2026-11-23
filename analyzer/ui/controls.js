import './app.js';

const $ = id => document.getElementById(id);
const ui = window.analyzerUI;
const stages = { structure: '小说清洗', body: '正文复核', scenes: '场景切分', characters: '角色真名' };
const templateLabels = {
  clean: '清洗 · 章节识别', cleanSupplementary: '清洗 · 补充标题', cleanChapterReview: '清洗 · 章节复核',
  cleanStructureStrategy: '清洗 · 目录结构策略', cleanStructureReview: '清洗 · 结构目录复核',
  cleanStructureConfirm: '清洗 · 剔除确认', cleanStructureRepair: '清洗 · 复合标题修复', segment: '场景切分 · 切点判断',
  mentionMapping: '人称映射 · 补充要求',
};
let saved;
let templates = {};
let models = [];
let loading = 0;

function status(message, error = false, id = 'workspace-status') {
  const node = $(id);
  node.textContent = message;
  node.hidden = !message;
  node.classList.toggle('operation-error', error);
}

async function api(url, options) {
  const response = await fetch(url, options);
  const data = await response.json().catch(() => ({}));
  if (!response.ok || data.ok === false) throw Error(data.error || '请求失败（HTTP ' + response.status + '）');
  return data;
}

const localDefault = () => ['127.0.0.1', 'localhost', '[::1]'].includes(new URL(saved.gateway).hostname)
  ? '自动选择 ' + saved.automaticModel + '（可用时）' : '未配置';

function updateModelSummary(config) {
  saved = config;
  const automatic = localDefault();
  const clean = config.stages.structure.model || config.inheritedCleanModel || automatic;
  $('model-status').replaceChildren(...Object.entries(stages).map(([key, name]) => {
    const row = document.createElement('span');
    row.dataset.stage = key;
    const model = config.stages[key]?.model ||
      (key === 'structure' && config.inheritedCleanModel ? '沿用 ' + config.inheritedCleanModel
        : key === 'body' ? '沿用清洗 · ' + clean : automatic);
    row.append(name + ' ', Object.assign(document.createElement('b'), { textContent: model }));
    return row;
  }));
  const retrieval = document.createElement('span');
  retrieval.dataset.stage = 'role-embedding';
  retrieval.append('身份检索 ', Object.assign(document.createElement('b'), { textContent: config.roleEmbeddingModel || '原句检索' }));
  const mapping = document.createElement('span');
  mapping.dataset.stage = 'mention-mapping';
  mapping.append('人称映射 ', Object.assign(document.createElement('b'), {
    textContent: config.mentionMappingModel || '沿用角色真名 · ' + (config.stages.characters.model || automatic),
  }));
  $('model-status').append(mapping, retrieval);
}

function paintPicker() {
  const values = [...Object.keys(stages), 'mentionMappingModel'].map(key => $('settings-form').elements[key].value.trim());
  const same = values.every(value => value === values[0]);
  const ids = [...new Set([...models, ...values.filter(Boolean)])];
  const options = [new Option('各步骤使用默认配置', ''), ...ids.map(id => new Option(id, id))];
  if (!same) {
    const mixed = new Option('按下方分别配置', '');
    mixed.disabled = true;
    options.splice(1, 0, mixed);
  }
  $('quick-model').replaceChildren(...options);
  if (same) $('quick-model').value = values[0];
  else $('quick-model').selectedIndex = 1;
}

function paintModelList() {
  $('local-models').replaceChildren(...models.map(id => new Option(id, id)));
  paintPicker();
}

function paintSettings() {
  const form = $('settings-form');
  form.elements.gateway.value = saved.gateway;
  form.elements.apiKey.value = '';
  form.elements.apiKey.placeholder = saved.hasKey ? '留空保留当前密钥' : '可留空';
  form.elements.clearKey.checked = false;
  form.elements.maxTokens.value = saved.maxTokens;
  form.elements.temperature.value = saved.temperature;
  form.elements.timeout.value = saved.timeoutMs / 1000;
  form.elements.disableReasoning.checked = saved.disableReasoning !== false;
  for (const key of Object.keys(stages)) form.elements[key].value = saved.stages[key]?.model || '';
  form.elements.roleEmbeddingModel.value = saved.roleEmbeddingModel || '';
  form.elements.mentionMappingModel.value = saved.mentionMappingModel || '';
  status('', false, 'embedding-status');
  templates = { ...saved.templates };
  const pick = $('prompt-key');
  pick.replaceChildren(...Object.entries(templateLabels).map(([key, name]) => new Option(name, key)));
  $('prompt-text').value = templates[pick.value] || '';
  paintModelList();
}

async function readModels() {
  const scan = ++loading;
  status('正在读取 LocalAI 模型…', false, 'settings-status');
  try {
    const result = await api('/api/models');
    if (scan !== loading || !$('settings').open) return;
    models = result;
    paintModelList();
    status(models.length ? models.length + ' 个可用模型' : '网关没有返回模型', !models.length, 'settings-status');
  } catch (error) {
    if (scan !== loading || !$('settings').open) return;
    status(error.message + '。仍可手动输入模型 ID。', true, 'settings-status');
  }
}

async function saveSettings(refresh) {
  const form = $('settings-form');
  if (!form.reportValidity()) return;
  const elements = form.elements;
  const next = { ...saved.stages };
  for (const key of Object.keys(stages)) next[key] = { ...next[key], model: elements[key].value };
  updateModelSummary(await api('/api/config', {
    method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({
      gateway: elements.gateway.value, apiKey: elements.apiKey.value, clearKey: elements.clearKey.checked,
      maxTokens: Number(elements.maxTokens.value), temperature: Number(elements.temperature.value),
      timeoutMs: Number(elements.timeout.value) * 1000, disableReasoning: elements.disableReasoning.checked,
      stages: next, templates, roleEmbeddingModel: elements.roleEmbeddingModel.value, mentionMappingModel: elements.mentionMappingModel.value,
    }),
  }));
  document.dispatchEvent(new CustomEvent('analyzer:modelschange'));
  if (refresh) {
    models = [];
    paintSettings();
    await readModels();
  } else {
    $('settings').close();
    status('LocalAI 模型设置已保存。');
  }
}

function configAction(action) {
  action().catch(error => status(error.message, true, $('settings').open ? 'settings-status' : 'workspace-status'));
}

$('open-settings').onclick = () => configAction(async () => {
  if ($('settings').open) return;
  updateModelSummary(await api('/api/config'));
  models = [];
  paintSettings();
  $('settings').showModal();
  await readModels();
});
$('close-settings').onclick = () => { loading += 1; $('settings').close(); };
$('model-reload').onclick = () => configAction(readModels);
$('save-gateway').onclick = () => configAction(() => saveSettings(true));
$('test-role-embedding').onclick = async () => {
  const field = $('settings-form').elements.roleEmbeddingModel;
  const model = field.value.trim();
  if (!model) { status('请先填写向量模型 ID。', true, 'embedding-status'); return; }
  const control = $('test-role-embedding');
  control.disabled = true;
  status('正在使用已保存的网关测试…', false, 'embedding-status');
  try {
    const result = await api('/api/models/embedding-test', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ model }),
    });
    status('测试通过 · ' + result.dimensions + ' 维。点击「保存模型设置」启用。', false, 'embedding-status');
  } catch (error) {
    status(error.message, true, 'embedding-status');
  } finally {
    control.disabled = false;
  }
};
$('quick-model').onchange = event => {
  for (const key of [...Object.keys(stages), 'mentionMappingModel']) $('settings-form').elements[key].value = event.target.value;
  paintPicker();
};
$('settings-form').addEventListener('change', event => {
  if (Object.hasOwn(stages, event.target.name) || event.target.name === 'mentionMappingModel') paintPicker();
});
$('prompt-key').onchange = event => { $('prompt-text').value = templates[event.target.value] || ''; };
$('prompt-text').oninput = event => { templates[$('prompt-key').value] = event.target.value; };
$('settings-form').onsubmit = event => { event.preventDefault(); configAction(() => saveSettings(false)); };

const urlWithId = (route, id) => route + '?id=' + encodeURIComponent(id);
function downloadBook(id) {
  if (!id) throw Error('请先选中书籍');
  const link = document.createElement('a');
  link.href = urlWithId('/api/book/export', id);
  link.download = '';
  link.hidden = true;
  document.body.append(link);
  link.click();
  link.remove();
}
$('book-export').onclick = () => { if (ui.currentBookId()) downloadBook(ui.currentBookId()); };
$('book-import').onclick = () => $('import-project').click();
$('import-project').onchange = event => configAction(async () => {
  const file = event.target.files[0];
  if (!file) return;
  event.target.value = '';
  status('正在导入工程…');
  const result = await api('/api/project/import?name=' + encodeURIComponent(file.name), {
    method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: file,
  });
  if (result.needsCleaning) {
    const bytes = Uint8Array.from(atob(result.source.base64), value => value.charCodeAt(0));
    await ui.switchView('clean');
    await ui.chooseCleanSource(new File([bytes], result.source.file));
    status('已载入工程原稿，可按原版重新清洗与编号。');
  } else {
    await ui.refreshBooks(result.id);
    await ui.switchView('number');
    await ui.openNumbered();
    status('已导入工程 ' + result.title + '。');
  }
});

let processing = false;
$('one-click').onclick = () => {
  if (processing) return;
  processing = true;
  $('one-click').disabled = true;
  $('one-click').textContent = '处理进行中…';
  const task = async () => {
    let id = ui.currentBookId();
    if (ui.cleanSource() && (ui.currentView() === 'clean' || !id || id === ui.savedSourceBook())) {
      id = ui.savedSourceBook();
      if (!id) {
        await ui.switchView('clean');
        status('正在执行原版清洗与编号…');
        if (!ui.cleaned()) await ui.runClean();
        if (!ui.cleaned()) throw Error($('cleanStatus').textContent);
        id = await ui.numberCleaned();
        if (!id) throw Error($('cleanStatus').textContent);
      }
    }
    if (!id) throw Error('请先选择小说文件，或选择已编号的书籍');
    let ready = await api(urlWithId('/api/project/status', id));
    if (!ready.scenes) {
      status('正在执行原版场景切分…');
      await ui.switchView('scenesview');
      const result = await ui.runScenes(id);
      if (result.stopped) { status('已停止切分。再次点击可继续。'); return; }
    }
    await ui.switchView('characters');
    if (!ready.characters) {
      status('正在生成角色真名表…');
      const roles = await ui.runCharacters(id);
      if (roles.waiting) { status('已保存当前逐场结果。请先完成剩余场景切分。'); return; }
      ready = await api(urlWithId('/api/project/status', id));
    }
    if (!ready.mentions) {
      status('正在生成场景内人称…');
      await ui.runMentions(id);
    }
    downloadBook(id);
    status('已完成原版四步处理，正在下载工程。');
  };
  task().catch(error => status(error.message, true)).finally(() => {
    processing = false;
    $('one-click').disabled = false;
    $('one-click').textContent = '一键处理并导出';
  });
};

api('/api/config').then(updateModelSummary).catch(() => { $('model-status').textContent = '模型配置读取失败'; });


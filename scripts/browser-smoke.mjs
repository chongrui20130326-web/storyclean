import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { createApp } from '../server.mjs';
import { createAnalyzerApp } from '../analyzer/server.mjs';
import { createLibrary } from '../analyzer/library.mjs';
import { analyzerModel, manuscript } from '../test/fixtures/analyzer.mjs';

const windowsPaths = [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
];
const executable = process.env.CHROME_BIN || windowsPaths.find(existsSync);
if (!executable) {
  console.error('请设置 CHROME_BIN 指向 Chrome 或 Edge 可执行文件');
  process.exit(1);
}

const dir = mkdtempSync(path.join(os.tmpdir(), 'novel-browser-fixture-'));
const profile = path.join(dir, 'profile');
const gateway = createServer(async (req, res) => {
  res.setHeader('Content-Type', 'application/json');
  if (req.url.endsWith('/models')) {
    res.end(JSON.stringify({ data: [{ id: 'browser-fixture' }] }));
    return;
  }
  let body = '';
  for await (const chunk of req) body += chunk;
  if (req.url.endsWith('/embeddings')) {
    const request = JSON.parse(body);
    res.end(JSON.stringify({ model: request.model, data: [{ index: 0, embedding: [0.5, 0.5, 0.5, 0.5] }] }));
    return;
  }
  const content = JSON.parse(body).messages.at(-1).content;
  const value = content.includes('【角色真名】')
    ? { characters: [{ name: '林舟', aliases: [] }, { name: '沈棠', aliases: [] }] }
    : { cuts: [5] };
  res.end(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(value) } }] }));
});
const useAnalyzer = process.argv.includes('--analyzer');
const fixtureModel = analyzerModel();
let releaseFirstRelations;
const firstRelations = new Promise(resolve => { releaseFirstRelations = resolve; });
let interruptedRelations = false;
const modelFactory = options => {
  const model = fixtureModel(options);
  return { ...model, async chat(request) {
    if (!interruptedRelations && request.source === 'build-character-table.mjs' && request.prompt.startsWith('角色表：')) {
      interruptedRelations = true;
      await firstRelations;
      return { ok: false, error: '模型请求超时' };
    }
    return model.chat(request);
  } };
};
const app = useAnalyzer ? createAnalyzerApp({ dataDir: path.join(dir, 'data'), previousConfig: null, modelFactory })
  : createApp({ dataDir: path.join(dir, 'data') });
const fixture = useAnalyzer ? path.join(dir, '下载副本.txt') : fileURLToPath(new URL('../examples/雾港来信.txt', import.meta.url));
if (useAnalyzer) writeFileSync(fixture, manuscript);
let chrome;
let socket;

async function listen(server) {
  await new Promise((resolve, reject) => server.once('error', reject).listen(0, '127.0.0.1', resolve));
  return 'http://127.0.0.1:' + server.address().port;
}

async function until(condition, label) {
  const stop = Date.now() + 12000;
  while (Date.now() < stop) {
    if (await condition()) return;
    await delay(70);
  }
  throw Error('等待超时：' + label);
}

try {
  const [appUrl, gatewayUrl] = await Promise.all([listen(app), listen(gateway)]);
  const config = await fetch(appUrl + '/api/config').then(res => res.json());
  config.stages.scenes.model = 'custom-scenes';
  config.stages.characters.model = 'custom-characters';
  const configured = await fetch(appUrl + '/api/config', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...config, gateway: gatewayUrl + '/v1' }),
  });
  assert.equal(configured.status, 200);
  const portFile = path.join(profile, 'DevToolsActivePort');
  chrome = spawn(executable, [
    '--headless=new', '--user-data-dir=' + profile, '--no-first-run', '--disable-background-networking', '--disable-gpu',
    '--remote-debugging-port=0', '--window-size=1380,940', 'about:blank',
  ], { windowsHide: true, stdio: 'ignore' });
  chrome.on('error', error => console.error(error.message));
  await until(() => existsSync(portFile), 'Chrome 调试端口');
  const port = readFileSync(portFile, 'utf8').trim().split(/\r?\n/)[0];
  const browser = await fetch('http://127.0.0.1:' + port + '/json/version').then(res => res.json());
  socket = new WebSocket(browser.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    socket.addEventListener('open', resolve, { once: true });
    socket.addEventListener('error', reject, { once: true });
  });
  const pending = new Map();
  const pageErrors = [];
  let next = 0;
  let sessionId;
  socket.addEventListener('message', ({ data }) => {
    const event = JSON.parse(data);
    if (event.method === 'Runtime.exceptionThrown') pageErrors.push(event.params.exceptionDetails.exception?.description || event.params.exceptionDetails.text);
    if (!pending.has(event.id)) return;
    const { resolve, reject, timer } = pending.get(event.id);
    pending.delete(event.id);
    clearTimeout(timer);
    if (event.error) reject(Error(event.error.message));
    else resolve(event.result);
  });
  function send(method, params = {}) {
    const id = ++next;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(Error('Chrome 命令超时：' + method));
      }, 10000);
      pending.set(id, { resolve, reject, timer });
      socket.send(JSON.stringify({ id, method, params, sessionId }));
    });
  }
  async function evaluate(expression) {
    const answer = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (answer.exceptionDetails) throw Error(answer.exceptionDetails.exception?.description || answer.exceptionDetails.text);
    return answer.result.value;
  }
  const select = selector => 'document.querySelector(' + JSON.stringify(selector) + ')';
  const ready = (selector, label) => until(() => evaluate('Boolean(' + select(selector) + ')'), label || selector);
  const click = async selector => {
    await ready(selector);
    await evaluate(select(selector) + '.click()');
  };
  const { targetInfos } = await send('Target.getTargets');
  const attachment = await send('Target.attachToTarget', { targetId: targetInfos.find(target => target.type === 'page').targetId, flatten: true });
  sessionId = attachment.sessionId;
  await send('Page.enable');
  await send('Page.navigate', { url: appUrl });
  await send('Runtime.enable');
  if (useAnalyzer) {
    const upload = async (selector, file) => {
      await ready(selector);
      const dom = await send('DOM.getDocument');
      const input = await send('DOM.querySelector', { nodeId: dom.root.nodeId, selector });
      await send('DOM.setFileInputFiles', { nodeId: input.nodeId, files: [file] });
    };
    await ready('#cleanPage:not([hidden])');
    await until(() => evaluate('document.querySelector("#model-status [data-stage=scenes] b")?.textContent === "custom-scenes"'), '原版页面显示当前模型');
    const labels = await evaluate('[...document.querySelectorAll(".viewtab")].map(e=>e.textContent)');
    assert.deepEqual(labels, ['1. 小说清洗', '2. 内容编号', '3. 场景切分', '4. 生成角色', '5. 文件查看']);
    await click('#open-settings');
    await ready('#quick-model option[value="browser-fixture"]', 'LocalAI 下拉框');
    await evaluate(`(() => {
      const field = document.querySelector('#quick-model');
      field.value = 'browser-fixture';
      field.dispatchEvent(new Event('change', { bubbles: true }));
    })()`);
    await click('#settings-form [type=submit]');
    await until(() => evaluate('!document.querySelector("#settings").open && document.querySelector("#model-status [data-stage=structure] b")?.textContent === "browser-fixture"'), '保存并显示模型');
    await click('#open-settings');
    await ready('#settings[open]');
    const stages = { structure: 'manual-clean', body: 'manual-review', scenes: 'manual-scenes', characters: 'manual-roles' };
    for (const [stage, model] of Object.entries(stages)) {
      const field = select('#settings-form input[name="' + stage + '"]');
      assert.ok(await evaluate('Boolean(' + field + '?.getClientRects().length)'), '模型输入框直接可见 ' + stage);
      await evaluate(field + '.focus(); ' + field + '.select(); true');
      await send('Input.insertText', { text: model });
    }
    await evaluate('document.querySelector("input[name=roleEmbeddingModel]").value = "browser-embedding"');
    await click('#test-role-embedding');
    await until(() => evaluate('document.querySelector("#embedding-status").textContent.includes("4 维")'), '向量模型连接测试');
    await click('#settings-form [type=submit]');
    await until(() => evaluate('!document.querySelector("#settings").open'), '保存各步骤手填模型');
    for (const [stage, model] of Object.entries(stages)) {
      assert.equal(await evaluate(select('#model-status [data-stage="' + stage + '"] b') + '.textContent'), model);
    }
    const persisted = await fetch(appUrl + '/api/config').then(res => res.json());
    assert.deepEqual(Object.fromEntries(Object.keys(stages).map(key => [key, persisted.stages[key].model])), stages);
    assert.equal(persisted.roleEmbeddingModel, 'browser-embedding');
    assert.equal(await evaluate('document.querySelector("#model-status [data-stage=role-embedding] b").textContent'), 'browser-embedding');
    await click('#open-settings');
    await ready('#settings[open]');
    assert.equal(await evaluate('document.querySelector("#settings-form input[name=body]").value'), stages.body);
    await click('#close-settings');
    await upload('#cleanFileInput', fixture);
    await click('#cleanRun:not(:disabled)');
    await ready('#cleanNumber:not(:disabled)', '清洗完成可保存');
    assert.equal(await evaluate('document.querySelector("#cleanBookNameOut").textContent'), '星海纪事');
    assert.match(await evaluate('document.querySelector("#cleanTocOut").textContent'), /第2章/);
    assert.match(await evaluate('document.querySelector("#cleanStats").textContent'), /规则修复/);
    await click('#cleanNumber');
    await ready('#numberPage:not([hidden]) .nt-ch', '编号页面与章段句树');
    await until(() => evaluate('document.querySelector("#numberLog").textContent.includes("已更新书籍")'), '保存并编号更新书库');
    await click('#numberTree .nt-ch');
    await ready('#numberTree .nt-p');

    const currentBook = await evaluate('document.querySelector("#book").value');
    const { work } = createLibrary(path.join(dir, 'data')).location(currentBook);
    writeFileSync(path.join(work, 'l2', 'scenes.progress.json'), JSON.stringify({ cursor: 5, nextAt: 5 }));
    writeFileSync(path.join(work, 'l2', 'segmentation.verify.json'), JSON.stringify({
      ok: false, checkedAt: new Date().toISOString(), errors: ['切点 S999 超出本批允许的范围'],
    }));
    await click('[data-view=scenesview]');
    await ready('#svError:not([hidden])', '切分页展示持久化的异常提示');
    assert.match(await evaluate('document.querySelector("#svError").textContent'), /场景切分失败.*S999/s);
    assert.equal(await evaluate('document.querySelector("#svCompletion")?.textContent'), '未完成');
    await click('[data-view=number]');
    await click('[data-view=scenesview]');
    await ready('#svError:not([hidden])', '返回切分页后仍显示上次错误');
    await click('#svImport:not(:disabled)');
    await ready('#svCompletion[data-state=complete]', '最终场景保存后显示已全部完成');
    assert.equal(await evaluate('document.querySelector("#svCompletion").textContent'), '已全部完成');
    assert.match(await evaluate('document.querySelector("#svMeta").textContent'), /1 场.*5\/5 句/);
    await ready('#svError[hidden]', '切分成功后清除异常提示');
    await click('[data-view=number]');
    await click('[data-view=scenesview]');
    await ready('#svCompletion[data-state=complete]', '返回切分页时完成状态仍可见');
    await click('#svList .sv-row');
    assert.match(await evaluate('document.querySelector("#svDetail").textContent'), /S4 ~ S8/);
    await click('[data-view=characters]');
    await click('#chMentionsBtn:not(:disabled)');
    await until(() => evaluate('document.querySelector("#chMentionStatus").textContent.includes("人称预览已生成")'), '真名表完成前可生成人称预览');
    await ready('#chSceneText .ch-hl', '预览高亮在场景原文显示');
    await click('#chReload');
    await until(() => evaluate('document.querySelector("#chMentionStatus").textContent.includes("人称预览已生成")'), '刷新后仍显示已保存的人称预览');
    await click('#chTable:not(:disabled)');
    try {
      await until(() => evaluate('document.querySelector("#chDraft").textContent.includes("确认出场") && document.querySelector("#chDraft").textContent.includes("沈棠") && document.querySelector("#chMentionsBtn").disabled'), '附表完成前显示已确认出场角色');
      const proof = await evaluate('document.querySelector("#chDraft .ch-evidence").textContent.split("S").at(-1)');
      await click('#chDraft .ch-evidence');
      assert.ok(await evaluate(select('#chs-' + proof) + '.classList.contains("flash")'), '点击证据定位原句');
    } finally {
      releaseFirstRelations();
    }
    await until(() => evaluate('document.querySelector("#chTable").textContent.includes("继续") && !document.querySelector("#chTable").disabled'), '附表中断后可续跑');
    await click('[data-view=scenesview]');
    await click('[data-view=characters]');
    assert.ok(await evaluate('document.querySelector("#chCharacters").textContent.includes("沈棠")'));
    await click('#chTable:not(:disabled)');
    await until(() => evaluate('document.querySelector("#chCharacters").textContent.includes("沈棠") && !document.querySelector("#chMentionsBtn").disabled'), '角色真名表');
    assert.ok(await evaluate('document.querySelector("#chDraft").textContent.includes("沈棠") && document.querySelector("#chScenes .ch-status.done").textContent === "已识别"'));
    await click('#chMentionsBtn');
    await until(() => evaluate('document.querySelector("#chMentionStatus").textContent.includes("场景内人称已生成")'), '正式人称表完成反馈');
    await ready('#chSceneText .ch-hl', '原版场景内人称高亮');
    assert.match(await evaluate('document.querySelector("#chMentions").textContent'), /M00000/);
    await click('#chMap:not(:disabled)');
    await until(() => evaluate('document.querySelector("#chMapLog").textContent.includes("人称映射已完成")'), '界面可启动并生成人称映射');
    assert.match(await evaluate('document.querySelector("#chMapLog").textContent'), /代词及称谓已映射 1.*姓名已匹配 2/s);
    await evaluate(`(() => {
      const fetchOriginal = window.fetch;
      window.fetch = async (url, ...args) => {
        const response = await fetchOriginal(url, ...args);
        if (!String(url).startsWith('/api/characters/progress?')) return response;
        window.fetch = fetchOriginal;
        const progress = await response.json();
        return Response.json({ ...progress, running: true,
          mapping: { ...progress.mapping, phase: 'local', complete: false, etaSeconds: 7270,
            work: { done: 3, total: 12, unit: 'batches' } } });
      };
    })()`);
    await click('#chReload');
    await until(() => evaluate('document.querySelector("#chMapLog").textContent.includes("场内映射预计剩余 2h1m10s")'), '显示映射剩余时间和单位');
    assert.match(await evaluate('document.querySelector("#chMapLog").textContent'), /模型批次 3\/12/);
    await click('#chReload');
    await until(() => evaluate('document.querySelector("#chMapLog").textContent.includes("人称映射已完成")'), '结束后清除映射预计时间');
    assert.deepEqual(await evaluate(`(() => {
      const rows = [...document.querySelectorAll('#chMentions .ch-mrow')];
      const hits = [...document.querySelectorAll('#chs-5 .ch-hl')];
      return [getComputedStyle(rows.find(row => row.textContent.includes('他 · S5'))).backgroundColor,
        getComputedStyle(hits.find(hit => hit.firstChild.textContent === '他')).backgroundColor,
        rows.find(row => row.textContent.includes('她 · S5')).classList.contains('mapped')];
    })()`), ['rgb(231, 245, 235)', 'rgb(231, 245, 235)', false]);
    await evaluate(`[...document.querySelectorAll('#chMentions .ch-mrow')].find(row => row.textContent.includes('他 · S5')).click()`);
    await ready('#chMappingEvidence:not([hidden]) .ch-evidence-line', '人称映射显示可定位证据');
    assert.match(await evaluate('document.querySelector("#chMappingEvidence").textContent'), /他 → 林舟.*S5/s);
    await click('#chMappingEvidence .ch-evidence-line');
    assert.ok(await evaluate('document.querySelector("#chs-5").classList.contains("flash")'));
    const current = await evaluate('document.querySelector("#book").value');
    const original = await fetch(appUrl + '/api/book/export?id=' + encodeURIComponent(current)).then(res => res.json());
    assert.equal(original.version, 2);
    assert.equal(original.mentionMapping.phase, 'done');
    await click('[data-view=files]');
    await click('#generatedFiles [data-file="l2/scenes-llm.json"]');
    await until(() => evaluate('document.querySelector("#fileReadable").textContent.includes("SC001")'), '场景文件默认显示可读场景');
    assert.match(await evaluate('document.querySelector("#filePurpose").textContent'), /句号范围/);
    assert.match(await evaluate('document.querySelector("#fileReadable").textContent'), /S4.*S8/s);
    assert.equal(await evaluate('document.querySelector("#fileTree").hidden'), true);
    await click('#fileTreeTab');
    await click('#fileTree [data-pointer="/scenes"] > summary');
    await click('#fileTree [data-pointer="/scenes/0"] > summary');
    await until(() => evaluate('document.querySelector("#fileTree").textContent.includes("SC001")'), '展开场景 JSON 字段');
    await click('#fileContentTab');
    await until(() => evaluate('document.querySelector("#fileContent").textContent.includes("semantic-rolling")'), '打开 JSON 文件内容');
    const displayed = await evaluate('JSON.parse(document.querySelector("#fileContent").textContent)');
    assert.deepEqual(displayed, original.scenes);
    await click('#generatedFiles [data-file="l2/scene-roles.progress.json"]');
    await until(() => evaluate('document.querySelector("#fileReadableTab").getAttribute("aria-pressed") === "true" && document.querySelector("#fileReadable").textContent.includes("确认出场")'), '打开逐场角色文件时回到数据解读');
    assert.match(await evaluate('document.querySelector("#fileReadable").textContent'), /林舟.*沈棠/s);
    await click('#fileReadable .file-record-expand > summary');
    await click('#fileReadable .file-record-expand[open] .file-record-expand > summary');
    await until(() => evaluate('document.querySelector("#fileReadable .file-record-expand[open] .file-record-expand[open] .file-record")'), '展开原文证据');
    assert.match(await evaluate('document.querySelector("#fileReadable .file-record-expand[open]").textContent'), /出场.*S\d+/s);
    await click('#generatedFiles [data-file="l2/mention-mapping.json"]');
    await until(() => evaluate('document.querySelector("#fileReadable").textContent.includes("逐场人称映射")'), '文件查看解读人称映射');

    const downloads = path.join(dir, 'downloads');
    mkdirSync(downloads);
    await send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: downloads });
    await click('[data-view=clean]');
    await upload('#cleanFileInput', fixture);
    await ready('#cleanRun:not(:disabled)');
    await evaluate(`(() => {
      const input = document.querySelector('#cleanBookName');
      input.value = '星海纪事自动验收';
      input.dispatchEvent(new Event('input', { bubbles: true }));
    })()`);
    await click('#one-click');
    await until(() => readdirSync(downloads).some(file => file.endsWith('.project.json')), '自动完整工程下载');
    const exportedPath = path.join(downloads, readdirSync(downloads).find(file => file.endsWith('.project.json')));
    const exported = JSON.parse(readFileSync(exportedPath, 'utf8'));
    assert.equal(exported.book.title, '星海纪事自动验收');
    assert.deepEqual(exported.scenes.scenes.map(scene => [scene.from, scene.to]), [['S4', 'S8']]);
    assert.ok(exported.characters && exported.mentions && exported.sceneRoles?.complete);
    await upload('#import-project', exportedPath);
    await until(async () => {
      const { message, failed } = await evaluate(`(() => {
        const node = document.querySelector('#workspace-status');
        return { message: node.textContent, failed: node.classList.contains('operation-error') };
      })()`);
      if (failed) throw Error(message);
      return message.includes('已导入工程');
    }, '回导工程');
    await click('[data-view=files]');
    await ready('#fileSelected:not([hidden])', '导入后的文件查看');
    for (const [width, height] of [[1380, 940], [390, 844]]) {
      await send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false });
      await delay(120);
      assert.equal(await evaluate('document.documentElement.scrollWidth <= window.innerWidth'), true, width + ' px 横向溢出');
      await click('[data-view=characters]');
      await ready('#chDraft .ch-evidence', '回导工程可查看逐场证据');
      assert.equal(await evaluate('document.documentElement.scrollWidth <= window.innerWidth'), true, width + ' px 角色页横向溢出');
      await click('[data-view=files]');
    }
    const post = async (route, data) => {
      const response = await fetch(appUrl + route, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data),
      });
      const result = await response.json();
      assert.equal(response.status, 200, result.error);
      return result;
    };
    const contents = ['第一章 出发', ...Array.from({ length: 44 }, (_, i) => '第' + (i + 1) + '处灯亮了。')].join('\n');
    const long = await post('/api/number/run', { name: '分页验收.txt', content: contents });
    const paged = await post('/api/number/import', { numbered: long.numbered, title: '分页验收' });
    await evaluate('window.analyzerUI.refreshBooks(' + JSON.stringify(paged.id) + ')');
    await click('#generatedFiles [data-file="initial.json"]');
    const numbered = '#fileReadable .file-record-group:has(h4)';
    const locateNumbered = `[...document.querySelectorAll(${JSON.stringify(numbered)})].find(node => node.querySelector("h4").textContent.includes("编号原句"))`;
    await until(() => evaluate(locateNumbered + '?.querySelector(".file-record h5")?.textContent === "S1"'), '编号原句第一页');
    await evaluate(locateNumbered + '.querySelector(".file-record-nav button:last-child").click()');
    await until(() => evaluate(locateNumbered + '.querySelector(".file-record h5").textContent === "S21"'), '编号原句下一页');
    assert.deepEqual(pageErrors, []);
    console.log(JSON.stringify({ originalFourTabs: true, fileViewer: true, manualWorkflow: true, modelDisplay: true,
      oneClickDownload: true, reimport: true, layouts: [1380, 390] }));
  } else {
  await ready('#welcome:not([hidden])', '空书架');
  await until(() => evaluate('document.querySelector("#configured-models [data-stage=scenes] dd")?.textContent === "custom-scenes"'), '首页显示当前场景模型');
  assert.equal(await evaluate('document.querySelector("#configured-models [data-stage=characters] dd")?.textContent'), 'custom-characters');
  const dom = await send('DOM.getDocument');
  const input = await send('DOM.querySelector', { nodeId: dom.root.nodeId, selector: '#import' });
  await send('DOM.setFileInputFiles', { nodeId: input.nodeId, files: [fixture] });
  await until(() => evaluate('document.querySelector("#book-title").textContent === "雾港来信"'), 'TXT 导入');

  await evaluate('document.querySelector("#clean-form [name=merges]").value="10"');
  await click('[data-action=preview]');
  await ready('#clean-preview:not([hidden])');
  await click('[data-action=save-clean]');
  await until(() => evaluate('document.querySelector("#notice").textContent.includes("清洗已保存")'), '保存清洗');

  await click('[data-action=step][data-value="1"]');
  await click('[data-action=number]');
  await until(() => evaluate('document.querySelector("#view-result").textContent.includes("雨还没有停，他把信交给沈棠。")'), '编号正文');
  await click('#open-settings');
  await ready('#settings[open]');
  assert.match(await evaluate('document.querySelector("#open-settings").textContent'), /LocalAI/);
  await ready('#workflow-model option[value="browser-fixture"]', '打开配置时自动加载 LocalAI 模型');
  assert.equal(await evaluate('document.querySelector("#workflow-model").selectedOptions[0].textContent'), '沿用分阶段设置');
  await evaluate(`(() => {
    const field = document.querySelector('#workflow-model');
    field.value = 'browser-fixture';
    field.dispatchEvent(new Event('change', { bubbles: true }));
  })()`);
  await click('#config [type=submit]');
  await until(() => evaluate('!document.querySelector("#settings").open && document.querySelector("#notice").textContent.includes("模型设置已保存")'), '保存模型');
  const persisted = await fetch(appUrl + '/api/config').then(res => res.json());
  assert.equal(persisted.stages.scenes.model, 'browser-fixture');
  assert.equal(persisted.stages.characters.model, 'browser-fixture');
  assert.equal(persisted.stages.structure.model, '');
  assert.equal(await evaluate('document.querySelector("#configured-models [data-stage=scenes] dd")?.textContent'), 'browser-fixture');
  assert.equal(await evaluate('document.querySelector("#configured-models [data-stage=characters] dd")?.textContent'), 'browser-fixture');

  await click('[data-action=step][data-value="2"]');
  await click('[data-action=start][data-value=scenes]');
  await ready('[data-action=scene][data-value=SC002]', '场景输出');
  await click('[data-action=step][data-value="3"]');
  await click('[data-action=start][data-value=characters]');
  await until(() => evaluate('document.querySelector("#notice").textContent.includes("角色真名已完成")'), '角色表');
  await click('[data-action=step][data-value="4"]');
  await click('[data-action=mentions]');
  await until(() => evaluate('document.querySelector("#notice").textContent.includes("人称已保存")'), '人称表');
  await click('[data-action=scene][data-value=SC001]');
  await ready('.mark.pronoun', '人称高亮');
  assert.equal(await evaluate('document.querySelector(".mark.pronoun").textContent'), '你');
  const exportUrl = await evaluate('document.querySelector("#export").href');
  const project = await fetch(exportUrl).then(res => res.json());
  assert.equal(project.scenes.rows.length, 2);
  assert.equal(project.mentions.rows[0].characterId, 'CH01');
  const copy = await fetch(appUrl + '/api/books?name=roundtrip.json', {
    method: 'POST', body: JSON.stringify(project), headers: { 'Content-Type': 'application/json' },
  }).then(res => res.json());
  assert.equal(copy.counts.mentions, project.mentions.rows.length);

  const screenshotDir = process.env.NOVEL_SCREENSHOT_DIR;
  for (const [width, height] of [[1380, 940], [390, 844]]) {
    await send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false });
    await delay(150);
    const fits = await evaluate('document.documentElement.scrollWidth <= window.innerWidth');
    assert.equal(fits, true, width + ' px 页面出现横向溢出');
    if (screenshotDir && existsSync(screenshotDir)) {
      const { data } = await send('Page.captureScreenshot', { format: 'png' });
      writeFileSync(path.join(screenshotDir, 'novel-cleaning-' + width + '.png'), Buffer.from(data, 'base64'));
    }
  }
  const originalId = new URL(exportUrl).pathname.split('/')[3];
  await fetch(appUrl + '/api/books?name=第二本.txt', {
    method: 'POST', body: '另一艘船到岸了。', headers: { 'Content-Type': 'application/octet-stream' },
  });
  await send('Page.reload');
  await until(() => evaluate('document.querySelector("#book-title")?.textContent === "第二本"'), '第二本书');
  await click('[data-action=step][data-value="1"]');
  await evaluate(`(function () {
    const actual = window.fetch;
    window.fetch = async (url, options) => {
      const response = await actual(url, options);
      if (String(url).endsWith('/number')) await new Promise(r => { window.releaseNumber = r; });
      return response;
    };
  })()`);
  await click('[data-action=number]');
  await until(() => evaluate('Boolean(window.releaseNumber)'), '编号请求在返回前暂停');
  await click('[data-action=book][data-value="' + originalId + '"]');
  await until(() => evaluate('document.querySelector("#book-title")?.textContent === "雾港来信"'), '返回初始书');
  await evaluate('window.releaseNumber()');
  await delay(200);
  assert.equal(await evaluate('document.querySelector("#book-title").textContent'), '雾港来信', '旧书响应改变了当前书籍');

  const downloads = path.join(dir, 'downloads');
  mkdirSync(downloads);
  await send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: downloads });
  const fresh = await fetch(appUrl + '/api/books?name=雾港来信-一键.txt', {
    method: 'POST', body: readFileSync(fixture), headers: { 'Content-Type': 'application/octet-stream' },
  }).then(res => res.json());
  await send('Page.reload');
  await ready('[data-action=book][data-value="' + fresh.id + '"][aria-current="true"]');
  await ready('#process:not(:disabled)');
  await until(() => evaluate('document.querySelector("#source-meta").textContent.includes("雾港来信-一键.txt")'), '一键测试书');
  await click('#process');
  await until(() => readdirSync(downloads).some(file => file.endsWith('.project.json')), '一键处理自动下载');
  const downloaded = JSON.parse(readFileSync(path.join(downloads, readdirSync(downloads).find(file => file.endsWith('.project.json'))), 'utf8'));
  assert.equal(downloaded.source.file, '雾港来信-一键.txt');
  assert.ok(downloaded.numbered && downloaded.scenes && downloaded.characters && downloaded.mentions);
  assert.deepEqual(downloaded.characters.rows.map(row => row.name).sort(), ['林舟', '沈棠']);

  assert.deepEqual(pageErrors, []);
  console.log(JSON.stringify({ browser: path.basename(executable), layouts: [1380, 390], fullWorkflow: true, highlights: true,
    exportImport: true, oneClickDownload: true, sentences: project.numbered.sentences.length, scenes: project.scenes.rows.length,
    characters: project.characters.rows.length, mentions: project.mentions.rows.length }));
  }
} finally {
  socket?.close();
  if (chrome && chrome.exitCode === null && chrome.signalCode === null && chrome.pid) {
    const exiting = once(chrome, 'exit');
    chrome.kill();
    await exiting;
  }
  await app.pauseJobs();
  for (const server of [app, gateway]) {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
  try { rmSync(dir, { recursive: true, force: true, maxRetries: 4, retryDelay: 150 }); }
  catch { console.error('浏览器测试临时目录仍被占用：' + dir); }
}


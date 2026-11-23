import { decodeNovel } from '/novel-encoding.js';

const $ = (id) => document.getElementById(id);
const panels = { clean: 'cleanPage', number: 'numberPage', scenesview: 'scenesViewPage', characters: 'charactersPage', files: 'filesPage' };
const bookSelects = ['book', 'numberBookSel', 'svBookSel', 'chBookSel'];
const sceneRule = '按情节滚动切分 · 每批约 5000 字完整句 · 每场至少 20 句';
const sceneCompletionLabels = { complete: '已全部完成', incomplete: '未完成', running: '未完成 · 切分中',
  loading: '正在读取状态', unknown: '无法读取状态', empty: '未选择书籍' };
const cleanState = { file: null, source: null, result: null, titleEdited: false, saved: null };
const numberState = { file: null, pending: null, displayedBook: '', busy: false };
const sceneState = { book: '', selected: '', timer: null, active: new Set() };
const characterState = { book: '', selected: '', filter: '', active: new Set() };
let activeView = 'clean';

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function button(className, text, activate) {
  const node = el('button', className, text);
  node.type = 'button';
  node.addEventListener('click', activate);
  return node;
}

function empty(id, message) {
  $(id).replaceChildren(el('div', 'number-empty', message));
}

function status(id, message, failed = false) {
  const node = $(id);
  node.textContent = message;
  node.classList.toggle('operation-error', failed);
  if (id === 'workspace-status') node.hidden = !message;
}

async function api(path, body) {
  const response = await fetch(path, body === undefined ? undefined : {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  const data = await response.json().catch(() => null);
  if (!response.ok || !data || data.ok === false) {
    const error = new Error(data?.error || `请求失败（HTTP ${response.status}）`);
    error.status = response.status;
    throw error;
  }
  return data;
}

const bookUrl = (path, id) => `${path}?id=${encodeURIComponent(id)}`;
const currentBookId = () => $('book').value;
const isCurrent = (view, id) => activeView === view && currentBookId() === id;
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function selectBook(id) {
  for (const select of bookSelects.map($)) select.value = id;
  $('book-export').disabled = !id;
  $('numberOpenBook').disabled = !id || numberState.busy;
  document.dispatchEvent(new CustomEvent('analyzer:bookchange', { detail: { id, bookId: id } }));
}

async function refreshBooks(preferredId) {
  const list = await api('/api/books');
  const id = [preferredId, currentBookId()].find((value) => list.some((book) => book.id === value)) || list[0]?.id || '';
  for (const select of bookSelects.map($)) {
    select.replaceChildren(...(list.length
      ? list.map((book) => new Option(book.title || book.id, book.id))
      : [new Option('暂无书籍', '')]));
  }
  selectBook(id);
  if (activeView === 'scenesview') await refreshScenes();
  if (activeView === 'characters') await loadCharacters();
  return list;
}

function switchView(view) {
  if (!panels[view]) return Promise.resolve();
  activeView = view;
  for (const [name, id] of Object.entries(panels)) $(id).hidden = name !== view;
  for (const tab of document.querySelectorAll('.viewtab')) {
    const active = tab.dataset.view === view;
    tab.classList.toggle('active', active);
    if (active) tab.setAttribute('aria-current', 'step');
    else tab.removeAttribute('aria-current');
  }
  clearTimeout(sceneState.timer);
  document.dispatchEvent(new CustomEvent('analyzer:viewchange', { detail: { view } }));
  if (view === 'scenesview') return refreshScenes();
  if (view === 'characters') return loadCharacters();
  return Promise.resolve();
}

async function readNovel(file) {
  const bytes = new Uint8Array(await file.arrayBuffer());
  const decoded = decodeNovel(bytes);
  const chunks = [];
  for (let start = 0; start < bytes.length; start += 8192) {
    chunks.push(String.fromCharCode(...bytes.subarray(start, start + 8192)));
  }
  if (!decoded.text.trim()) throw new Error('小说文件没有可处理的正文');
  return {
    name: file.name, content: decoded.text, bytesBase64: btoa(chunks.join('')),
    encoding: decoded.encoding, encodingLabel: decoded.encodingLabel,
  };
}

function trackButton(id, handler, logId) {
  $(id).addEventListener('click', () => {
    Promise.resolve().then(handler).catch((error) => status(logId, error.message, true));
  });
}

function resetCleanResult() {
  cleanState.result = null;
  cleanState.saved = null;
  for (const [id, value] of Object.entries({ cleanBookNameOut: '—', cleanTocOut: '—', cleanTocCount: '',
    cleanBodyOut: '（尚未清洗）', cleanBodyCount: '', cleanStats: '—', cleanIssues: '' })) {
    $(id).textContent = value;
  }
  $('cleanNumber').disabled = true;
}

function paintCleanResult(data) {
  const doc = data.cleanDoc || {};
  const toc = doc['目录'] || [];
  const body = String(doc['正文'] || data.structuredText || data.text || '');
  const s = data.summary?.stats || data.summary || {};
  $('cleanBookNameOut').textContent = doc['书名'] || data.bookName || '—';
  $('cleanTocOut').textContent = toc.length ? toc.join('\n') : '（没有识别到章节）';
  $('cleanTocCount').textContent = toc.length ? `（${data.chapterCount ?? toc.length} 章 / ${toc.length} 项）` : '';
  $('cleanBodyOut').textContent = body.slice(0, 40000) || '（空）';
  $('cleanBodyCount').textContent = body ? `（${body.length} 字）` : '';
  $('cleanStats').textContent = [
    `字数 ${s.charsBefore ?? '—'} → ${s.charsAfter ?? '—'}（删 ${s.removedChars ?? 0}）`,
    `段落 ${s.paragraphsIn ?? '—'} → ${s.paragraphsOut ?? '—'}`,
    `章 ${s.chapters ?? data.chapterCount ?? 0}`,
    `规则修复 ${s.ruleApplied ?? 0} 处，模型复核 ${s.aiApplied ?? 0} 处`,
    `问题 ${data.issueCount ?? 0} 条`,
    `章节模型确认 ${data.chapterValidation?.modelChapters ?? 0} 个`,
    data.chapterValidation?.strategy === 'model-approved-template'
      ? `目录策略 模型确认格式＋全量模板匹配，逐条复核 ${data.chapterValidation.reviewed ?? 0} 项`
      : '目录策略 逐条语义识别',
  ].join('\n');
  const issues = (data.chapterWarnings || []).map((warning) => ({ title: '章节', detail: warning }))
    .concat(data.issues || []);
  $('cleanIssues').replaceChildren(...issues.map((issue) => {
    const row = el('div', 'clean-issue');
    row.append(el('strong', '', issue.title || issue.label || issue.kind || '问题'), ` ${issue.detail || issue.message || ''}`);
    return row;
  }));
  if (!issues.length) $('cleanIssues').textContent = '没有发现问题';
  status('cleanStatus', `清洗完成 · ${data.issueCount ?? 0} 条问题${body.length > 40000 ? '（左侧预览前 4 万字）' : ''}`);
}

async function runClean() {
  if (!cleanState.source || $('cleanRun').disabled) return;
  const source = cleanState.source;
  resetCleanResult();
  $('cleanRun').disabled = true;
  status('cleanStatus', '正在用模型识别书名和章节，随后清洗正文…');
  try {
    const data = await api('/api/clean/run', {
      ...source, ai: $('cleanAi').checked,
      bookName: cleanState.titleEdited ? $('cleanBookName').value.trim() : '',
    });
    if (source !== cleanState.source) return;
    cleanState.result = data;
    if (!cleanState.titleEdited && data.bookName) $('cleanBookName').value = data.bookName;
    paintCleanResult(data);
    $('cleanNumber').disabled = false;
    return data;
  } catch (error) {
    if (source === cleanState.source) status('cleanStatus', `清洗失败：${error.message}`, true);
  } finally {
    if (source === cleanState.source) $('cleanRun').disabled = false;
  }
}

function renderNumberResult(data, sourceLabel) {
  $('numberFile').textContent = sourceLabel;
  const ratio = data.coverage ? `${(data.coverage.ratio * 100).toFixed(2)}%` : '—';
  status('numberLog', [
    `章 ${data.chapters} · 段 ${data.paragraphs} · 句 ${data.sentences}`,
    `原文覆盖率 ${ratio}`,
    data.warnings?.length ? `⚠ ${data.warnings.join('\n⚠ ')}` : '✓ 未发现遗漏或重复',
  ].join('\n'));
  renderNumberView(data.doc);
}

function updateNumberButtons() {
  $('numberRun').disabled = !numberState.file || numberState.busy;
  $('numberImport').disabled = !numberState.pending || numberState.busy;
  $('numberOpenBook').disabled = !currentBookId() || numberState.busy;
  $('numberPick').disabled = numberState.busy;
  $('cleanNumber').disabled = !cleanState.result || numberState.busy;
}

async function numberNovel(payload, name, title, save) {
  if (numberState.busy) return;
  numberState.busy = true;
  numberState.pending = null;
  numberState.displayedBook = '';
  updateNumberButtons();
  status(save ? 'cleanStatus' : 'numberLog', '编号中…');
  try {
    const data = await api('/api/number/run', { examples: [], ...payload });
    numberState.pending = {
      numbered: data.numbered, numberRunId: data.numberRunId ?? data.runId,
      cleanRunId: payload.cleanRunId, title: title || data.doc?.bookName || '',
    };
    renderNumberResult(data, name);
    if (save) {
      await switchView('number');
      const id = await persistNumbered();
      status('cleanStatus', `已保存并编号：${title}`);
      return id;
    }
  } catch (error) {
    if (save) status('cleanStatus', `保存并编号失败：${error.message}`, true);
    status('numberLog', `编号或保存失败：${error.message}`, true);
  } finally {
    numberState.busy = false;
    updateNumberButtons();
  }
}

async function persistNumbered() {
  const pending = numberState.pending;
  if (!pending) return;
  const saved = await api('/api/number/import', pending);
  numberState.pending = null;
  const id = saved.id || saved.bookId || saved.book?.id || String(saved.work || '').split(/[\\/]/).pop();
  numberState.displayedBook = id;
  status('numberLog', [`已更新书籍：${saved.book?.title || pending.title || id}`, ...(saved.log || [])].join('\n'));
  await refreshBooks(id);
  return id;
}

async function openNumbered() {
  const id = currentBookId();
  if (!id || numberState.busy) return;
  status('numberLog', '读取编号结构…');
  try {
    const doc = await api(bookUrl('/api/book/numbered', id));
    if (id !== currentBookId()) return;
    $('numberFile').textContent = doc.bookName || id;
    numberState.pending = null;
    numberState.displayedBook = id;
    updateNumberButtons();
    status('numberLog', `已打开：${doc.bookName || id}\n章 ${doc.chapters.length} · 段 ${doc.paragraphs.length} · 句 ${doc.sentences.length}`);
    renderNumberView(doc);
  } catch (error) {
    if (id !== currentBookId()) return;
    status('numberLog', error.message, true);
    throw error;
  }
}

function sentenceNumber(id) {
  return Number(String(id ?? '').match(/(\d+)$/)?.[1]);
}

function renderNumberView(doc) {
  const tree = $('numberTree');
  const text = $('numberContent');
  const paragraphs = new Map(doc.paragraphs.map((para) => [para.id, para]));
  const sentences = new Map(doc.sentences.map((sentence) => [sentenceNumber(sentence.id), sentence]));
  const chapters = doc.chapters.length ? doc.chapters : [{ id: 'C1', title: doc.bookName || '全文', paragraphs: [...paragraphs.keys()] }];
  const treeNodes = document.createDocumentFragment();
  const textNodes = document.createDocumentFragment();

  function focus(row, target, chapter = false) {
    text.querySelector('.hl, .nb-ch.active')?.classList.remove('hl', 'active');
    tree.querySelector('.active')?.classList.remove('active');
    row.classList.add('active');
    target.classList.add(chapter ? 'active' : 'hl');
    target.scrollIntoView({ behavior: 'smooth', block: chapter ? 'start' : 'center' });
  }

  for (const chapter of chapters) {
    const heading = el('div', 'nb-ch', `${chapter.id} · ${chapter.title}`);
    const chapterGroup = el('div', 'nt-group');
    chapterGroup.hidden = true;
    const caret = el('span', 'nt-caret', '▸');
    const chapterRow = button('nt-ch', undefined, () => {
      if (!chapterGroup.childNodes.length) makeParagraphs();
      chapterGroup.hidden = !chapterGroup.hidden;
      chapterRow.setAttribute('aria-expanded', String(!chapterGroup.hidden));
      caret.textContent = chapterGroup.hidden ? '▸' : '▾';
      focus(chapterRow, heading, true);
    });
    chapterRow.setAttribute('aria-expanded', 'false');
    chapterRow.append(caret, `${chapter.id} · ${chapter.title}`);
    treeNodes.append(chapterRow, chapterGroup);
    textNodes.append(heading);
    const chapterParagraphs = [];
    for (const pid of chapter.paragraphs) {
      const para = paragraphs.get(pid);
      if (!para) continue;
      const paraNode = el('div', 'nb-p');
      const children = [];
      for (let n = sentenceNumber(para.from); n <= sentenceNumber(para.to); n += 1) {
        const sentence = sentences.get(n);
        if (!sentence) continue;
        const node = el('span', 'nb-s');
        node.append(el('span', 'nb-id', sentence.id), sentence.text);
        paraNode.append(node);
        children.push({ sentence, node });
      }
      textNodes.append(paraNode);
      chapterParagraphs.push({ para, paraNode, children });
    }

    function makeParagraphs() {
      for (const { para, paraNode, children } of chapterParagraphs) {
        const group = el('div', 'nt-group');
        group.hidden = true;
        const row = button('nt-p', undefined, () => {
          if (!group.childNodes.length) {
            for (const { sentence, node } of children) {
              const sentenceRow = button('nt-s', undefined, () => {
                focus(sentenceRow, node);
                void showSentenceMentions(sentenceRow, sentence.id, numberState.displayedBook);
              });
              sentenceRow.append(el('span', 'nt-tip', 'ⓘ'), sentence.id);
              sentenceRow.title = sentence.text.slice(0, 40);
              group.append(sentenceRow);
            }
          }
          group.hidden = !group.hidden;
          row.setAttribute('aria-expanded', String(!group.hidden));
          focus(row, paraNode);
        });
        row.setAttribute('aria-expanded', 'false');
        row.append(el('span', 'nt-tip', 'ⓘ'), `${para.id} · ${para.chars} 字`);
        row.title = children.slice(0, 3).map(({ sentence }) => sentence.text).join('').slice(0, 40);
        chapterGroup.append(row, group);
      }
    }
  }
  tree.replaceChildren(treeNodes);
  text.replaceChildren(textNodes);
}

async function showSentenceMentions(row, sentenceId, book) {
  if (!book) return;
  let box = row.nextElementSibling;
  if (!box?.classList.contains('nt-mbox')) {
    box = el('div', 'nt-mbox');
    box.hidden = true;
    row.after(box);
  }
  box.hidden = !box.hidden;
  if (box.hidden) return;
  box.replaceChildren(el('div', 'nt-mtext', '加载中…'));
  try {
    const data = await api(`${bookUrl('/api/mention/sentence', book)}&s=${sentenceNumber(sentenceId)}`);
    if (data.missing) {
      box.replaceChildren(el('div', 'nt-mtext', '请先生成场景内人称'));
      return;
    }
    const text = data.text || '';
    const line = el('div', 'nt-mtext', text);
    const chips = el('div', 'nt-mchips');
    for (const mention of data.mentions || []) {
      const surface = mention.text ?? mention.surface ?? '';
      const offset = Number(mention.offset ?? mention.start);
      const chip = button('nt-mchip', `${mention.id} · ${surface}`, () => {
        chips.querySelector('.active')?.classList.remove('active');
        chip.classList.add('active');
        if (Number.isInteger(offset) && offset >= 0 && offset + surface.length <= text.length) {
          line.replaceChildren(text.slice(0, offset), el('mark', 'nt-mmark', text.slice(offset, offset + surface.length)), text.slice(offset + surface.length));
        }
      });
      chips.append(chip);
    }
    if (!chips.childNodes.length) chips.append(el('span', 'ch-meta', '本句没有人称'));
    box.replaceChildren(chips, line);
  } catch (error) {
    box.replaceChildren(el('div', 'nt-mtext operation-error', error.message));
  }
}

function progressBar(id, percent = 0) {
  const bar = $(id);
  const value = Math.max(0, Math.min(100, Number(percent) || 0));
  bar.querySelector('i').style.width = `${value}%`;
  bar.setAttribute('aria-valuenow', String(value));
}

function formatRemainingTime(seconds) {
  const total = Math.max(0, Math.floor(seconds));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor(total / 60) % 60;
  const remainder = total % 60;
  return ((hours ? hours + 'h' : '') + (minutes ? minutes + 'm' : '') + (remainder ? remainder + 's' : '')) || '0s';
}

function timing(data) {
  const job = data.job || data;
  const elapsed = job.elapsedSeconds ?? data.elapsedSeconds;
  const average = job.averageSeconds ?? data.averageSeconds;
  const eta = job.etaSeconds ?? data.etaSeconds;
  return [elapsed == null ? '' : `用时 ${elapsed} 秒`, average == null ? '' : `平均 ${average} 秒`,
    Number.isFinite(eta) ? `预计剩余 ${formatRemainingTime(eta)}` : ''].filter(Boolean).map((value) => ` · ${value}`).join('');
}

function showSceneFailure(message) {
  $('svErrorReason').textContent = message;
  $('svError').hidden = !message;
}

function setSceneCompletion(state) {
  const label = $('svCompletion');
  label.dataset.state = state;
  label.textContent = sceneCompletionLabels[state];
}

function paintSceneProgress(id, progress, doc, error) {
  if (!isCurrent('scenesview', id)) return;
  const running = Boolean(progress.running);
  const job = progress.job || {};
  const failure = !running && (progress.error || error || (job.phase === 'failed' ? job.error || '任务异常结束' : ''));
  showSceneFailure(failure || '');
  const done = progress.done ?? 0;
  const total = progress.total ?? 0;
  const percent = progress.percent ?? 0;
  const complete = progress.doneFile && !doc?.partial && doc?.scenes?.length > 0 && total > 0 && done === total;
  const completion = !id ? 'empty' : error ? 'unknown' : running ? 'running' : complete ? 'complete' : 'incomplete';
  setSceneCompletion(completion);
  $('svImport').disabled = !id || running || sceneState.active.has(id);
  const canContinue = doc?.partial || job.phase === 'stopped' || (done > 0 && done < total);
  $('svImport').textContent = running ? '切分中…' : complete ? '重新切分' : canContinue ? '继续切分' : '开始切分';
  $('svStop').hidden = !running;
  if (!running) $('svStop').disabled = false;
  progressBar('svBar', percent);
  const partial = doc?.partial ? ` · 已保存 ${doc.scenes?.length ?? 0} 场` : '';
  const next = progress.nextSentence ? ' · 下批起点 ' + progress.nextSentence : '';
  const count = `${done.toLocaleString('zh-CN')}/${total.toLocaleString('zh-CN')} 句`;
  const detail = `${percent}%（已检查 ${count}）${partial}${next}${timing(progress)}`;
  let message = sceneRule;
  if (running) message = detail;
  else if (complete) {
    const warning = doc.strategy !== 'semantic-rolling' ? '旧规则结果，可重新切分应用新规则' : doc.warnings?.[0];
    message = `100% · ${doc.scenes.length} 场 · 覆盖 ${count}${warning ? ' · ' + warning : ''}`;
  } else if (error) message = '可刷新重试';
  else if (canContinue) message = `可继续切分 · ${detail}`;
  else if (failure) message = '可重试场景切分';
  else if (id && total) message = `0%（已检查 ${count}） · ${sceneRule}`;
  status('svMeta', message);
}

function paintScenes(id, doc) {
  if (sceneState.book !== id) {
    sceneState.book = id;
    sceneState.selected = '';
    sceneState.signature = '';
  }
  const scenes = doc?.scenes || [];
  const signature = JSON.stringify(scenes.map((scene) => [scene.sceneId, scene.from, scene.to, scene.preview, scene.source]));
  if (signature === sceneState.signature && scenes.length) return;
  sceneState.signature = signature;
  const list = $('svList');
  const detail = $('svDetail');
  if (!scenes.length) {
    empty('svList', doc?.partial ? '已保存进度，尚无完整闭合的场景' : '这本书还没有切分结果');
    empty('svDetail', '选择一个场景查看句子范围与正文');
    return;
  }
  const rows = scenes.map((scene) => {
    const chapter = scene.endChapterId && scene.endChapterId !== scene.chapterId
      ? `${scene.chapterId}～${scene.endChapterId}` : scene.chapterId;
    const range = `${scene.from} ~ ${scene.to}（${scene.sentences} 句，${scene.chars} 字）`;
    const row = button('sv-row', undefined, () => {
      sceneState.selected = scene.sceneId;
      list.querySelector('.active')?.classList.remove('active');
      row.classList.add('active');
      const content = el('div', 'sv-text');
      if (scene.lines?.length) {
        for (const line of scene.lines) content.append(el('span', 'sv-line', `S${line.n} ${line.text}`));
      } else content.textContent = scene.text || scene.preview || '';
      const source = scene.source === 'model' ? '模型' : scene.source === 'rule' ? '规则' : scene.source;
      detail.replaceChildren(el('div', 'sv-title2', `${scene.sceneId} · ${scene.chapterTitle || scene.chapterId}`),
        el('div', 'sv-range', `${range}${source ? ` · 来源 ${source}` : ''}`), content);
      detail.scrollTop = 0;
    });
    row.append(`${scene.sceneId} · ${chapter}`, el('small', '', range), el('span', 'sv-prev', scene.preview || ''));
    return row;
  });
  list.replaceChildren(...rows);
  const selected = scenes.findIndex((scene) => scene.sceneId === sceneState.selected);
  if (selected >= 0) rows[selected].click();
  else empty('svDetail', '选择一个场景查看句子范围与正文');
}

async function readScenes(id) {
  const progress = await api(bookUrl('/api/scenes/progress', id));
  const doc = await api(bookUrl('/api/scenes/llm', id)).catch(error => {
    if (error.status !== 404) throw error;
    return null;
  });
  if (isCurrent('scenesview', id)) {
    paintScenes(id, doc);
    paintSceneProgress(id, progress, doc);
  }
  return { progress, doc };
}

async function refreshScenes() {
  clearTimeout(sceneState.timer);
  const id = currentBookId();
  if (!id) {
    paintScenes('', null);
    paintSceneProgress('', {});
    return;
  }
  if (sceneState.book !== id) {
    setSceneCompletion('loading');
    status('svMeta', '');
    showSceneFailure('');
    progressBar('svBar', 0);
    $('svImport').disabled = true;
  }
  try {
    const { progress } = await readScenes(id);
    if (progress.running && !sceneState.active.has(id) && isCurrent('scenesview', id)) {
      sceneState.timer = setTimeout(refreshScenes, 3000);
    }
  } catch (error) {
    if (isCurrent('scenesview', id)) paintSceneProgress(id, {}, null, error.message);
  }
}

async function runScenes(id = currentBookId()) {
  if (!id) throw new Error('请先选择已编号的书籍');
  if (sceneState.active.has(id)) throw new Error('这本书正在切分');
  sceneState.active.add(id);
  if (isCurrent('scenesview', id)) {
    $('svImport').disabled = true;
    showSceneFailure('');
    setSceneCompletion('running');
    status('svMeta', '正在启动场景切分…');
  }
  try {
    const started = await api('/api/scenes/segment', { id });
    for (;;) {
      const { progress, doc } = await readScenes(id);
      if (!progress.running) {
        if (progress.job?.phase === 'stopped' || progress.job?.state === 'stopped') return { stopped: true };
        if (progress.job?.error || progress.error || doc?.progress?.error) {
          throw new Error(progress.job?.error || progress.error || doc.progress.error);
        }
        if (!doc?.scenes?.length || doc.partial) throw new Error('场景切分尚未完成，可以继续切分');
        return { ...started, ...doc };
      }
      await pause(2000);
    }
  } finally {
    sceneState.active.delete(id);
    if (isCurrent('scenesview', id)) await refreshScenes();
  }
}

async function stopScenes() {
  const id = currentBookId();
  if (!id) return;
  $('svStop').disabled = true;
  status('svMeta', '正在停止，已保存的切分进度可继续使用…');
  try {
    await api('/api/scenes/stop', { id });
    if (isCurrent('scenesview', id)) await refreshScenes();
  } finally {
    if (isCurrent('scenesview', id)) $('svStop').disabled = false;
  }
}

async function chooseCleanSource(file) {
  if (!file) return;
  cleanState.file = file;
  cleanState.source = null;
  cleanState.titleEdited = false;
  $('cleanRun').disabled = true;
  resetCleanResult();
  const source = await readNovel(file);
  if (cleanState.file !== file) return;
  cleanState.source = source;
  $('cleanFileName').textContent = `${source.name}（${source.content.length} 字 · ${source.encodingLabel}）`;
  $('cleanBookName').value = source.name.replace(/\.[^.]+$/, '')
    .replace(/[_\-\s]*(清洗后|清洗|校对|整理|副本)[_\-\s]*\d{6,8}$/, '').replace(/[_\-\s]*\d{8}$/, '').trim();
  $('cleanRun').disabled = false;
  status('cleanStatus', '已选择：' + source.name);
}

async function numberCleaned() {
  const clean = cleanState.result;
  if (!clean) throw Error('请先完成清洗');
  const title = $('cleanBookName').value.trim();
  if (!title) throw Error('请先填写书名');
  const cleanRunId = clean.cleanRunId ?? clean.runId;
  const id = await numberNovel({
    name: title + '.txt', cleanDoc: { ...clean.cleanDoc, 书名: title }, cleanRunId,
  }, '清洗结果', title, true);
  if (id) cleanState.saved = { id, title, cleanRunId };
  return id;
}

const mappedRoleIds = mention => mention.mapping?.characterIds || [mention.characterId];

function mentionTarget(mention, names, mappingInProgress = false) {
  if (!mention.mapping) {
    if (mappingInProgress && !mention.characterId) return '待处理';
    return mention.inDialog ? '对白' : mention.name ? mention.characterId + ' ' + mention.name : '未对应';
  }
  if (mention.mapping.status === 'pending') return '待确认';
  if (mention.mapping.status === 'nonperson') return '非人物';
  return mappedRoleIds(mention).map(id => names.get(id) || id).join('、');
}

function paintMappingEvidence(data, mention, names) {
  const panel = $('chMappingEvidence');
  panel.hidden = !mention?.mapping;
  panel.replaceChildren();
  if (panel.hidden) return;
  const { evidence, method } = mention.mapping;
  const source = { exact: '真名表匹配', local: '场景原句', retrieval: '跨场检索' }[method];
  panel.append(el('strong', '', `${mention.surface} → ${mentionTarget(mention, names)}`));
  if (source) panel.append(el('div', 'ch-meta', source));
  for (const fact of evidence) panel.append(button('ch-evidence-line', `S${fact.sentence} · ${fact.surface}`,
    () => openRoleProof(data, fact.sentence)));
}

function paintRoleScene(data) {
  const selected = data.scenes.find(scene => scene.sceneId === characterState.selected);
  const sceneView = $('chSceneText');
  const nameMap = new Map(data.characters.map(role => [role.id, role.name]));
  const mappingInProgress = Boolean(data.mapping?.phase && !data.mapping.complete);
  const matching = characterState.filter
    ? data.mentions.filter(m => mappedRoleIds(m).includes(characterState.filter)).slice(0, 300)
    : data.mentions.filter(m => m.sceneId === selected?.sceneId);
  paintMappingEvidence(data, matching.find(m => m.id === characterState.focusedMention), nameMap);
  if (selected) {
    const bySentence = new Map();
    for (const m of data.mentions) {
      if (m.sceneId !== selected.sceneId) continue;
      if (!bySentence.has(m.sentence)) bySentence.set(m.sentence, []);
      bySentence.get(m.sentence).push(m);
    }
    sceneView.replaceChildren(...selected.text.map(row => {
      const sentence = el('span', 'ch-sent');
      sentence.id = 'chs-' + row.n;
      sentence.append(el('small', 'ch-meta', 'S' + row.n + ' '));
      let cursor = 0;
      const hits = (bySentence.get(row.n) || []).sort((a, b) => a.start - b.start);
      for (const m of hits) {
        if (!Number.isInteger(m.start) || m.start < cursor || m.end > row.text.length) continue;
        const node = el('span', 'ch-hl' + (m.inDialog ? ' dialog' : ''), row.text.slice(m.start, m.end));
        node.classList.toggle('mapped', m.mapping?.status === 'mapped');
        node.title = m.id + ' · ' + mentionTarget(m, nameMap, mappingInProgress);
        node.append(el('sup', 'ch-sup', String(m.id).replace(/^M0*/, '')));
        sentence.append(row.text.slice(cursor, m.start), node);
        cursor = m.end;
      }
      sentence.append(row.text.slice(cursor));
      return sentence;
    }));
  } else empty('chSceneText', '点上面的场景');
  const nodes = matching.map(m => {
    const row = button('ch-mrow ' + (m.inDialog ? 'dialog' : mappedRoleIds(m).some(Boolean) ? '' : 'unresolved'), undefined, () => {
      characterState.focusedMention = m.id;
      if (m.sceneId && m.sceneId !== characterState.selected) {
        characterState.selected = m.sceneId;
        paintCharacters(data);
      }
      paintMappingEvidence(data, m, nameMap);
      focusRoleSentence(m.sentence);
    });
    row.classList.toggle('mapped', m.mapping?.status === 'mapped');
    row.append(el('span', '', m.id), el('span', 'ch-surface', m.surface + ' · S' + m.sentence),
      el('span', 'ch-link', mentionTarget(m, nameMap, mappingInProgress)));
    return row;
  });
  if (characterState.filter) {
    const clear = button('ghost', '清除', () => { characterState.filter = ''; paintCharacters(data); });
    const filter = el('div', 'ch-filter', nameMap.get(characterState.filter) || characterState.filter);
    filter.append(clear);
    nodes.unshift(filter);
  }
  $('chMentions').replaceChildren(...(nodes.length ? nodes
    : [el('div', 'number-empty', !selected ? '请先到第 3 步切分场景'
      : data.mentionsReady ? '这个场景未命中人称' : '点「生成场景内人称」')]));
  paintSceneRoles(data, selected);
}

function focusRoleSentence(sentence) {
  const target = $('chs-' + sentence);
  if (!target) return;
  target.scrollIntoView({ block: 'center' });
  target.classList.add('flash');
  setTimeout(() => target.classList.remove('flash'), 1600);
}

function openRoleProof(data, sentence) {
  const containing = data.scenes.find(scene => Number(scene.from.slice(1)) <= sentence && Number(scene.to.slice(1)) >= sentence);
  if (!containing) return;
  if (characterState.selected !== containing.sceneId) {
    characterState.selected = containing.sceneId;
    paintCharacters(data);
  }
  focusRoleSentence(sentence);
}

const evidenceLabels = { name: '姓名', presence: '出场', mention: '提及', address: '本场称呼', identity: '身份对应', alias: '别名' };

function paintSceneRoles(data, selected) {
  const panel = $('chDraft');
  const sameScene = panel.dataset.scene === selected?.sceneId;
  const expanded = new Set(sameScene ? [...panel.querySelectorAll('details[open]')].map(detail => detail.dataset.role) : []);
  const scroll = sameScene ? panel.scrollTop : 0;
  panel.dataset.scene = selected?.sceneId || '';
  $('chDraftTitle').textContent = selected ? selected.sceneId + ' 本场角色' : '本场角色';
  const saved = characterState.sceneResults.get(selected?.sceneId);
  if (!saved) {
    const analyzing = selected?.sceneId === characterState.checkpoint?.currentScene;
    empty('chDraft', selected ? (analyzing ? '本场正在核对原文' : '本场等待识别') : '请先切分场景');
    return;
  }
  const groups = new Map([['present', []], ['mentioned', []], ['uncertain', []]]);
  for (const record of saved.roles) {
    const person = characterState.scenePeople.get(record.roleId);
    if (!person) continue;
    const kind = person.name ? record.status : 'uncertain';
    const display = person.name || record.evidence.find(row => row.kind === 'address')?.surface || person.label || '未具名人物';
    const row = el('div', 'ch-role-card');
    const proof = record.evidence.find(item => item.kind === (record.status === 'present' ? 'presence' : 'mention')) || record.evidence[0];
    const heading = el('div', 'ch-role-card-title');
    heading.append(el('b', '', display), button('ch-evidence', '证据 S' + proof.sentence, () => focusRoleSentence(proof.sentence)));
    row.append(heading);
    if (!person.name && record.status !== 'uncertain') row.append(el('small', 'ch-meta', record.status === 'present' ? '已确认出场，姓名待确认' : '仅被提及，姓名待确认'));
    const details = document.createElement('details');
    details.dataset.role = record.roleId;
    details.open = expanded.has(record.roleId);
    details.append(el('summary', '', '查看原文和本场称呼'));
    for (const item of record.evidence) {
      details.append(button('ch-evidence-line', `${evidenceLabels[item.kind]} · S${item.sentence} · ${item.surface}`,
        () => focusRoleSentence(item.sentence)));
    }
    const nameProof = person.evidence.find(item => item.kind === 'name' && item.surface === person.name);
    if (nameProof && !record.evidence.some(item => item.kind === 'name' && item.surface === person.name)) {
      details.append(button('ch-evidence-line', '姓名证据 · S' + nameProof.sentence, () => openRoleProof(data, nameProof.sentence)));
    }
    for (const { mention, proof: identity, bridge } of person.identityLinks || []) {
      if (!record.evidence.some(item => item.kind === 'address' && item.sentence === mention.sentence && item.start === mention.start)) continue;
      if (bridge) details.append(button('ch-evidence-line', `本场动作证据 · S${bridge.sentence} · ${bridge.surface}`,
        () => openRoleProof(data, bridge.sentence)));
      details.append(button('ch-evidence-line', `跨场身份依据 · S${identity.sentence} · ${identity.surface}`,
        () => openRoleProof(data, identity.sentence)));
    }
    row.append(details);
    groups.get(kind).push(row);
  }
  const headings = { present: '确认出场', mentioned: '仅被提及', uncertain: '待确认' };
  const sections = [];
  for (const [kind, rows] of groups) {
    if (!rows.length) continue;
    const section = el('section', 'ch-role-group');
    section.append(el('h3', '', headings[kind] + '（' + rows.length + '）'), ...rows);
    sections.push(section);
  }
  panel.replaceChildren(...(sections.length ? sections : [el('div', 'number-empty', '本场已核对，未发现具体人物')]));
  panel.scrollTop = scroll;
}

function roleStatus(progress) {
  const saved = progress.checkpoint;
  if (progress.step === 'mapping') return '';
  const error = progress.error || (!progress.running ? saved.error : '');
  if (progress.step === 'mentions' && progress.error) return progress.error;
  if (saved.stale) return error || '场景范围已变化。可重新逐场生成，原结果会归档。';
  if (progress.running && progress.step === 'mentions') return '正在生成场景内人称…';
  const count = `已核对 ${saved.done}/${saved.total} 场`;
  const retrieval = saved.retrieval;
  const rag = retrieval?.mode === 'fallback' ? ' · 向量暂不可用，已用原句检索'
    : retrieval?.mode === 'hybrid' ? ' · 已使用混合检索' : '';
  const current = saved.currentScene || (saved.done < saved.total ? 'SC' + String(saved.done + 1).padStart(3, '0') : '');
  const next = saved.phase === 'relations' ? '角色关系附表' : saved.phase === 'review' ? '待确认身份' : current;
  if (progress.running && retrieval?.mode === 'indexing' && saved.phase === 'review') {
    return count + ` · 正在建立向量索引 ${retrieval.done}/${retrieval.total} 段`;
  }
  if (progress.running) return count + ' · 正在处理 ' + (next || (progress.reviewOnly ? '待确认身份' : '逐场角色'))
    + (saved.split ? '（已缩小输入）' : '') + timing(progress);
  if (saved.complete) return error || count + ' · 角色真名表已完成' + rag;
  if (!saved.total) return '请先到第 3 步切分场景';
  if (saved.waiting) return count + ' · 到第 3 步继续切分后，可处理新增场景' + rag;
  if (error) return [error, count, next && '续跑位置 ' + next].filter(Boolean).join(' · ');
  if (saved.started) return count;
  return progress.legacy ? '旧版断点已保留，可在「文件查看」查看。' : '';
}

function estimateFromSavedMapping(data, progress, mapping) {
  if (!data || !progress.startedAt) return null;
  const stage = mapping.indexing ? 'index' : mapping.phase;
  let total = mapping.indexing?.total ?? mapping.total;
  let done = mapping.indexing?.done ?? mapping.reviewed;
  if (stage === 'local') {
    const targets = new Map();
    for (const mention of data.mentions) {
      if (mention.cls === 'name' && mention.characterId) continue;
      targets.set(mention.sceneId, (targets.get(mention.sceneId) || 0) + 1);
    }
    const batches = data.scenes.map(scene => Math.ceil((targets.get(scene.sceneId) || 0) / 14));
    total = batches.reduce((sum, count) => sum + count, 0);
    done = batches.slice(0, mapping.done).reduce((sum, count) => sum + count, 0);
  }
  if (!total || done >= total) return 0;
  const key = `${progress.bookId}:${progress.startedAt}:${stage}`;
  const at = stage === 'index' ? Date.now() : Date.parse(mapping.at);
  if (!Number.isFinite(at)) return null;
  const storageKey = 'novel-mapping-eta';
  let sample = characterState.mappingEstimate;
  if (sample?.key !== key) {
    try { sample = JSON.parse(sessionStorage.getItem(storageKey)); } catch { /* Optional refresh history. */ }
  }
  let changed = sample?.key !== key || done < sample.done;
  if (changed) sample = { key, done, at, lastDone: done, eta: null };
  if (done > sample.lastDone && at > sample.at) {
    sample.lastDone = done;
    sample.eta = Math.max(1, Math.ceil((at - sample.at) / 1000 / (done - sample.done) * (total - done)));
    changed = true;
  }
  characterState.mappingEstimate = sample;
  if (changed) {
    try { sessionStorage.setItem(storageKey, JSON.stringify(sample)); } catch { /* Keep the sample in memory. */ }
  }
  return sample.eta;
}

function paintMappingProgress(data, progress, busy) {
  const running = progress.running && progress.step === 'mapping';
  const mapping = (running && progress.mapping) || data?.mapping;
  const ready = data?.mentionsReady && !data.mentionsPreview && data.characters.length > 0;
  const control = $('chMap');
  control.disabled = busy || !ready || mapping?.complete;
  control.textContent = running ? '映射中…' : mapping?.complete ? '人称映射已完成' : mapping?.phase ? '继续人称映射' : '开始人称映射';
  $('chMapStop').hidden = !running;
  $('chMapRestart').hidden = !mapping?.phase;
  $('chMapRestart').disabled = busy || !ready;
  const error = !running && ((progress.step === 'mapping' && progress.phase === 'failed' && progress.error) || mapping?.error);
  const saved = data?.mapping;
  const mappedReferences = saved?.phase ? data.mentions.filter(mention => mention.cls !== 'name' && mention.mapping?.status === 'mapped').length : 0;
  const counts = saved?.phase && `代词及称谓已映射 ${mappedReferences} · 姓名已匹配 ${saved.mapped - mappedReferences} · 待确认 ${saved.pending} · 非人物 ${saved.nonperson}`;
  let message = ready ? '' : '生成正式人称表和真名表后，可开始人称映射。';
  if (mapping?.stale) message = '场景、人称或真名表已更新，请重新开始映射。';
  if (mapping?.phase) {
    message = (mapping.indexing ? `正在建立向量索引 ${mapping.indexing.done}/${mapping.indexing.total} 段`
      : mapping.complete ? '人称映射已完成'
        : mapping.phase === 'review' ? `跨场复核 ${mapping.reviewed}/${mapping.total} 场` : `本场映射 ${mapping.done}/${mapping.total} 场`)
      + (counts ? ' · ' + counts : '');
    if (mapping.retrieval === 'fallback') message += ' · 向量暂不可用，已使用原句检索';
    if (running) {
      const remaining = Object.hasOwn(mapping, 'etaSeconds') ? mapping.etaSeconds : estimateFromSavedMapping(data, progress, mapping);
      if (mapping.work?.unit === 'batches' && mapping.work.total) message += ` · 模型批次 ${mapping.work.done}/${mapping.work.total}`;
      const estimateLabel = mapping.indexing ? '向量索引预计剩余' : mapping.phase === 'local' ? '场内映射预计剩余' : '预计剩余';
      message += Number.isFinite(remaining) ? ` · ${estimateLabel} ${formatRemainingTime(remaining)}` : ` · ${estimateLabel}计算中`;
      if (mapping.phase === 'local' || mapping.indexing) message += '（跨场复核待估）';
    }
    if (!running && !mapping.complete && !busy) message += ' · 已保存，可继续';
  }
  if (running && !mapping?.phase) message = '正在启动人称映射…';
  status('chMapLog', [error, message].filter(Boolean).join(' · '), Boolean(error));
}

function applyRoleProgress(data, progress) {
  const previous = characterState.checkpoint;
  const saved = progress.checkpoint;
  characterState.checkpoint = saved;
  characterState.sceneResults = new Map(saved.scenes.map(scene => [scene.sceneId, scene]));
  characterState.scenePeople = new Map(saved.people.map(person => [person.id, person]));
  const busy = progress.running || characterState.active.has(characterState.book);
  paintMappingProgress(data, progress, busy);
  $('chTable').disabled = busy || !saved.total || saved.complete || saved.waiting || saved.stale;
  $('chTable').textContent = progress.running && progress.step === 'table' ? '正在逐场识别…'
    : saved.complete ? '真名表已完成' : saved.started ? '继续逐场生成' : '按场景生成真名表';
  $('chRestart').hidden = !saved.stale || !saved.total;
  $('chRestart').disabled = busy;
  $('chReview').hidden = !progress.embeddingConfigured || saved.stale || (!saved.complete && !saved.waiting) || !saved.people.some(row => !row.name);
  $('chReview').disabled = busy;
  const mentionsButton = $('chMentionsBtn');
  mentionsButton.disabled = busy || !data?.scenes.length;
  mentionsButton.title = busy ? '已有任务正在处理此书' : !data?.scenes.length ? '请先到第 3 步切分出至少一个场景'
    : !data.rosterReady || data.scenesPartial ? '可以先扫描已切分场景，生成预览' : '';
  status('chStepLog', roleStatus(progress), Boolean(progress.error || (!progress.running && saved?.error)));
  const mapping = progress.step === 'mapping' && progress.running && progress.mapping;
  const percent = mapping?.total ? 50 * (mapping.done + mapping.reviewed) / mapping.total : saved.total ? 100 * saved.done / saved.total : 0;
  progressBar('chBar', percent);
  if (!data) return;
  for (const badge of $('chScenes').querySelectorAll('[data-role-scene]')) {
    const done = characterState.sceneResults.has(badge.dataset.roleScene);
    badge.textContent = done ? '已识别' : '待识别';
    badge.className = 'ch-status ' + (done ? 'done' : 'todo');
  }
  if (saved.at !== previous?.at || !previous) {
    paintSceneRoles(data, data.scenes.find(scene => scene.sceneId === characterState.selected));
    paintRoleTable(data);
  }
}

function paintRoleTable(data) {
  const { characters, scenes, mentions } = data;
  const checkpoint = characterState.checkpoint;
  const pending = !data.rosterReady;
  const names = pending ? (checkpoint?.stale ? [] : checkpoint?.people.filter(role => role.name) || []) : characters;
  $('chCharactersTitle').textContent = pending && names.length ? '角色真名表 · 已确认姓名'
    : !checkpoint?.started && data.rosterReady ? '旧版角色真名表' : '角色真名表';
  $('chMeta').textContent = `${data.scenesPartial ? '已切分场景' : '场景'} ${scenes.length} · 人称 ${mentions.length} · 具名角色 ${names.length}`;
  $('chMentionStatus').textContent = data.mentionsPreview ? `人称预览已生成 · ${scenes.length} 场 · 命中 ${mentions.length} 处`
    : data.mentionsReady ? `场景内人称已生成 · 命中 ${mentions.length} 处`
      : scenes.length && (data.scenesPartial || !data.rosterReady) ? '可先预览已切分场景的人称' : '';
  const table = $('chCharacters');
  const scroll = table.scrollTop;
  table.replaceChildren(...(names.length ? names.map(role => {
    const row = pending ? el('div', 'ch-char ch-char-draft')
      : button('ch-char' + (role.id === characterState.filter ? ' active' : ''), undefined, () => {
        characterState.filter = characterState.filter === role.id ? '' : role.id;
        paintCharacters(data);
      });
    row.append(el('b', '', role.id));
    row.append(el('span', '', role.name), el('small', '', (role.aliases || []).join(' / ')));
    return row;
  }) : [el('div', 'number-empty', data.rosterReady ? '没有确认姓名的角色' : '确认姓名后会自动列在这里')]));
  table.scrollTop = scroll;
}

function paintCharacters(data) {
  const { characters, scenes, mentions, relations } = data;
  if (!scenes.some(scene => scene.sceneId === characterState.selected)) characterState.selected = scenes[0]?.sceneId || '';
  if (!characters.some(row => row.id === characterState.filter)) characterState.filter = '';
  const counts = new Map();
  for (const item of mentions) counts.set(item.sceneId, (counts.get(item.sceneId) || 0) + 1);
  const sceneNodes = scenes.map(scene => {
    const row = button('ch-scene' + (scene.sceneId === characterState.selected ? ' active' : ''), undefined, () => {
      characterState.selected = scene.sceneId;
      paintCharacters(data);
    });
    row.dataset.scene = scene.sceneId;
    const title = scene.chapterTitle || scene.chapterId;
    const top = el('div', 'ch-scene-top', title ? scene.sceneId + ' · ' + title : scene.sceneId);
    const badge = el('span', 'ch-status todo');
    badge.dataset.roleScene = scene.sceneId;
    const done = characterState.sceneResults.has(scene.sceneId);
    badge.textContent = done ? '已识别' : '待识别';
    if (done) badge.className = 'ch-status done';
    top.append(badge);
    row.append(top,
      el('small', '', `${scene.from}~${scene.to} · 人称 ${counts.get(scene.sceneId) || 0}`));
    return row;
  });
  $('chScenes').replaceChildren(...(sceneNodes.length ? sceneNodes : [el('div', 'number-empty', '还没有场景')]));
  paintRoleTable(data);
  $('chRelations').replaceChildren(...(relations.length ? relations.map(relation => el('div', 'ch-rel',
    `${relation.fromName} ${relation.type} → ${relation.toName}`)) : [el('div', 'number-empty', '—')]));
  $('chRelCount').textContent = relations.length ? '(' + relations.length + ')' : '';
  paintRoleScene(data);
}

async function loadCharacters() {
  const id = currentBookId();
  if (!id) {
    for (const zone of ['chScenes', 'chSceneText', 'chCharacters', 'chRelations', 'chMentions', 'chDraft']) empty(zone, '请先选择书籍');
    $('chCharactersTitle').textContent = '角色真名表';
    $('chTable').disabled = true;
    $('chRestart').hidden = true;
    $('chReview').hidden = true;
    $('chMentionsBtn').disabled = true;
    $('chMap').disabled = true;
    $('chMapStop').hidden = true;
    $('chMapRestart').hidden = true;
    $('chMappingEvidence').hidden = true;
    status('chMapLog', '');
    $('chMentionStatus').textContent = '';
    return;
  }
  const [data, progress] = await Promise.all([
    api(bookUrl('/api/characters', id)), api(bookUrl('/api/characters/progress', id)),
  ]);
  if (!isCurrent('characters', id)) return;
  if (characterState.book !== id) {
    characterState.book = id;
    characterState.selected = '';
    characterState.filter = '';
    characterState.focusedMention = '';
  }
  characterState.data = data;
  applyRoleProgress(data, progress);
  paintCharacters(data);
  if (progress.running && !characterState.active.has(id)) {
    clearTimeout(characterState.timer);
    characterState.timer = setTimeout(() => { if (isCurrent('characters', id)) loadCharacters().catch(() => {}); }, 1800);
  }
}

async function runRoleStep(route, label, id = currentBookId(), options = {}) {
  if (!id) throw Error('请先选择已编号的书籍');
  if (characterState.active.has(id)) throw Error('已有角色任务正在运行');
  characterState.active.add(id);
  if (isCurrent('characters', id)) {
    $('chTable').disabled = true;
    $('chReview').disabled = true;
    $('chMentionsBtn').disabled = true;
    $('chMap').disabled = true;
    $('chMapRestart').disabled = true;
    status(route === '/api/mentions/mapping' ? 'chMapLog' : 'chStepLog', label + '中…');
  }
  try {
    await api(route, { id, ...options });
    for (;;) {
      const progress = await api(bookUrl('/api/characters/progress', id));
      if (!progress.running) {
        if (progress.step === 'mapping' && progress.phase === 'stopped') return progress;
        if (progress.code !== 0) throw Error(progress.error || roleStatus(progress) || label + '未完成');
        return progress;
      }
      if (isCurrent('characters', id)) {
        if (progress.step === 'mapping' || (progress.checkpoint.phase === 'relations' && !characterState.data?.rosterReady)) await loadCharacters();
        else applyRoleProgress(characterState.data, progress);
      }
      await pause(1200);
    }
  } finally {
    characterState.active.delete(id);
    if (isCurrent('characters', id)) await loadCharacters();
  }
}

const runCharacters = id => runRoleStep('/api/characters/table', '生成角色真名表', id);
const runMentions = id => runRoleStep('/api/mentions/table', '生成场景内人称', id);
const runMapping = (restart = false) => runRoleStep('/api/mentions/mapping', '人称映射', currentBookId(), { restart });

$('cleanPick').onclick = () => $('cleanFileInput').click();
$('numberPick').onclick = () => $('numberFileInput').click();
$('cleanBookName').oninput = () => { cleanState.titleEdited = true; };
$('cleanFileInput').onchange = event => {
  const file = event.target.files[0];
  event.target.value = '';
  chooseCleanSource(file).catch(error => status('cleanStatus', error.message, true));
};
$('numberFileInput').onchange = event => {
  const file = event.target.files[0];
  if (!file) return;
  event.target.value = '';
  numberState.file = file;
  numberState.pending = null;
  $('numberFile').textContent = file.name;
  updateNumberButtons();
  status('numberLog', '已选择：' + file.name);
};
for (const name of bookSelects) $(name).onchange = event => {
  selectBook(event.target.value);
  switchView(activeView).catch(error => status('workspace-status', error.message, true));
};
for (const tab of document.querySelectorAll('.viewtab')) tab.onclick = () =>
  switchView(tab.dataset.view).catch(error => status('workspace-status', error.message, true));

trackButton('cleanRun', runClean, 'cleanStatus');
trackButton('cleanNumber', numberCleaned, 'cleanStatus');
trackButton('numberRun', async () => numberNovel(await readNovel(numberState.file), numberState.file.name, '', false), 'numberLog');
trackButton('numberImport', async () => { await persistNumbered(); updateNumberButtons(); }, 'numberLog');
trackButton('numberOpenBook', openNumbered, 'numberLog');
trackButton('svImport', async () => {
  const id = currentBookId();
  try { await runScenes(id); }
  catch (error) { if (isCurrent('scenesview', id)) showSceneFailure(error.message); }
}, 'svMeta');
trackButton('svStop', stopScenes, 'svMeta');
trackButton('svReload', refreshScenes, 'svMeta');
trackButton('chTable', () => runCharacters(), 'chStepLog');
trackButton('chReview', () => runRoleStep('/api/characters/table', '复核待确认身份', currentBookId(), { reviewOnly: true }), 'chStepLog');
document.addEventListener('analyzer:modelschange', () => {
  if (activeView === 'characters') loadCharacters().catch(error => status('chStepLog', error.message, true));
});
trackButton('chRestart', () => {
  if (window.confirm('归档当前逐场结果，并使用第 3 步保存的场景重新生成？')) {
    return runRoleStep('/api/characters/table', '重新逐场生成', currentBookId(), { resume: false });
  }
}, 'chStepLog');
trackButton('chMentionsBtn', () => runMentions(), 'chStepLog');
trackButton('chMap', () => runMapping(), 'chMapLog');
trackButton('chMapRestart', () => {
  if (window.confirm('备份现有映射，并按当前模型和提示词重新生成？')) return runMapping(true);
}, 'chMapLog');
trackButton('chMapStop', async () => {
  $('chMapStop').disabled = true;
  try { await api('/api/mentions/mapping/stop', { id: currentBookId() }); }
  finally { $('chMapStop').disabled = false; }
}, 'chMapLog');
trackButton('chReload', loadCharacters, 'chStepLog');

window.analyzerUI = {
  refreshBooks, currentBookId, switchView, runClean, numberCleaned, runScenes, runCharacters, runMentions, openNumbered, chooseCleanSource,
  currentView: () => activeView,
  cleanSource: () => cleanState.source, cleaned: () => cleanState.result,
  savedSourceBook: () => cleanState.saved?.title === $('cleanBookName').value.trim() ? cleanState.saved.id : '',
};
void switchView('clean');
refreshBooks().catch(error => status('workspace-status', error.message, true));

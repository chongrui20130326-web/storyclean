import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { runClean } from './clean-core/pipeline.mjs';
import { OllamaClient } from './clean-core/ai.mjs';
import { buildChapterIndex } from './chapter-index.mjs';
import { numberText } from './number.mjs';
import { writeJsonAtomic } from '../../core/atomic-json.mjs';
import { normalizeNovelContent } from './source-text.mjs';
import {scanInvisible} from './clean-core/invisible.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(here, '..', '..');

function normalizeIndexHeadings(index){
  if(!index)return index;const replacements=new Map();
  for(const section of index.sections){const previous=section.heading;section.heading=scanInvisible(previous).cleaned.replace(/\s+/g,' ').trim();replacements.set(previous.trim(),section.heading);}
  index.cleanDoc['目录']=index.sections.map(section=>section.heading);
  index.cleanDoc['正文']=index.cleanDoc['正文'].split('\n').map(line=>replacements.get(line.trim())??line).join('\n');
  return index;
}

class ConsoleCleanClient extends OllamaClient {
  constructor(modelConsole, model) { super({ model }); this.modelConsole = modelConsole; }
  async health() { return { ok: this.modelConsole?.state?.enabled !== false, model: this.model, error: '模型控制台已关闭' }; }
  async gatewayJson(url, options) {
    if (!url.endsWith('/chat/completions')) throw new Error('清洗模型只能通过模型控制台调用');
    const body = JSON.parse(options.body || '{}');
    const response = await this.modelConsole.chat({
      model: body.model || this.model,
      system: body.messages?.find((item) => item.role === 'system')?.content || '',
      prompt: body.messages?.filter((item) => item.role === 'user').map((item) => item.content).join('\n') || '',
      maxTokens: body.max_tokens, temperature: body.temperature, json: true, source: 'clean-number',
    });
    return { choices: [{ message: { content: response.content }, finish_reason: 'stop' }], usage: response.usage || {} };
  }
}

export function createCleanNumberTool({ root = 'work', modelConsole = null } = {}) {
  const base = path.resolve(root);
  return {
    async clean(body = {}) {
      const name = String(body.name || '未命名.txt');
      const content = normalizeNovelContent(String(body.content || '')
        .replace(/&#x20;/gi, ' ').replace(/&nbsp;|&#160;/gi, ' ').replace(/&#12288;/g, '\u3000')
        .replace(/&#10;|&#xA;/gi, '\n').replace(/&#9;|&#x9;/gi, '\t')
        .replace(/&quot;|&#34;/gi, '"').replace(/&#39;|&apos;/gi, "'")
        .replace(/&lt;/gi, '<').replace(/&gt;/gi, '>').replace(/&amp;/gi, '&'));
      if (!content.trim()) throw new Error('没有收到正文');
      const model = String(body.model || modelConsole?.state?.last?.model || '');
      const aiClient = body.ai && modelConsole ? new ConsoleCleanClient(modelConsole, body.bodyModel || model) : null;
      // 章节识别属于清洗的必经步骤；ai 只控制额外的正文合并/删除复核。
      const chat = modelConsole ? (input) => modelConsole.chat(input) : null;
      const index = normalizeIndexHeadings(chat ? await buildChapterIndex(content.replace(/\r\n?/g, '\n'), name.replace(/\.[^.]+$/, ''), model, chat, { sourceText: content, bookName: String(body.bookName || '').trim(), strategy: String(body.strategy || 'auto') }) : null);
      const result = await runClean({ buffer: Buffer.from(index?.cleanDoc['正文'] || content, 'utf8'), name, options: { ai: Boolean(aiClient), indent: 5, bookName: index?.bookName || String(body.bookName || '').trim(), chapterSections: index?.sections }, aiClient, onProgress: () => {} });
      const structured = index || normalizeIndexHeadings(await buildChapterIndex(result.text, name.replace(/\.[^.]+$/, ''), model, null, { sourceText: content, bookName: String(body.bookName || '').trim() }));
      if(!index)result.text=structured.cleanDoc['正文'];
      structured.cleanDoc['正文'] = result.text;
      const renderedLines=new Set(result.text.split('\n').map(line=>line.trim()));
      const missingChapters=structured.chapters.filter(chapter=>!renderedLines.has(chapter.heading));
      if(missingChapters.length)throw Error('清洗后章节边界丢失，已阻止输出错误目录：'+missingChapters[0].raw);
      const cleaningAudit={removedParagraphs:result.blocks.filter(block=>block.deleted).map(block=>({line:block.lineNo,text:block.original,reason:block.deleteReason})),inlineRemovals:result.issues.filter(issue=>issue.mode==='inline'&&issue.applied).map(issue=>({line:issue.lineNo,text:issue.before,reason:issue.title}))};
      structured.structured = `书名《${structured.bookName}》\n\n共 ${structured.chapterCount} 章\n\n清洗后目录：\n${structured.cleanDoc['目录'].join('\n')}\n\n清洗正文：\n\n${result.text}`;
      return { ok: true, name, bookName: structured.bookName, chapterCount: structured.chapterCount, chapterWarnings: structured.warnings || [], chapters: structured.chapters, sections: structured.sections, chapterValidation: structured.validation, cleaningAudit, structuredText: structured.structured, cleanDoc: structured.cleanDoc, summary: result.summary, issues: (result.issues || []).slice(0, 200), issueCount: (result.issues || []).length, text: result.text };
    },
    number(body = {}) {
      const content = body.cleanDoc ? String(body.cleanDoc['正文'] || '') : String(body.content || (body.file ? fs.readFileSync(String(body.file), 'utf8') : ''));
      if (!content.trim()) throw new Error('没有收到文本内容');
      const name = String(body.name || body.cleanDoc?.['书名'] || (body.file ? path.basename(String(body.file)) : 'upload.txt'));
      const doc = numberText(content, { name, examples: Array.isArray(body.examples) ? body.examples : [], chapterHeadings: Array.isArray(body.cleanDoc?.['目录']) ? body.cleanDoc['目录'].filter((s) => /^《[^》]+》[（(]第\d+章/.test(s)) : null });
      if(body.cleanDoc&&doc.totals.chapters!==body.cleanDoc['目录'].filter(s=>/^《[^》]+》[（(]第\d+章/.test(s)).length)throw Error('编号与已确认目录的章节数不一致，已停止保存');
      const outDir = path.join(base, '.numbered');
      fs.mkdirSync(outDir, { recursive: true });
      const file = path.join(outDir, path.basename(name).replace(/[^\p{L}\p{N}._-]/gu, '_').replace(/\.[^.]+$/, '') + '.bottomup.json');
      writeJsonAtomic(file, doc, 0);
      return { ok: true, numbered: file, chapters: doc.totals.chapters, paragraphs: doc.totals.paragraphs, sentences: doc.totals.sentences, coverage: doc.coverage, warnings: doc.warnings, doc: { chapters: doc.chapters, paragraphs: doc.paragraphs, sentences: doc.sentences, schema: doc.schema }, log: [] };
    },
    importNumbered({ numbered, title = '' } = {}) {
      const file = path.resolve(String(numbered || ''));
      if (!fs.existsSync(file)) throw new Error('找不到编号文件');
      const safeTitle = String(title || path.basename(file).replace(/\.(numbered|bottomup)\.json$/i, '')).replace(/[\\/:*?"<>|]/g, '_').trim();
      if (!safeTitle || safeTitle === '.' || safeTitle === '..') throw new Error('书名不合法');
      const workDir = path.join(base, safeTitle);
      const result = spawnSync(process.execPath, [path.join(projectRoot, 'tools', 'import-bottomup.mjs'), file, workDir], { cwd: projectRoot, encoding: 'utf8', timeout: 300000 });
      if (result.status !== 0) throw new Error((result.stderr || result.stdout || '导入失败').slice(-300));
      return { ok: true, work: workDir, updated: false, log: (result.stdout || '').trim().split('\n') };
    },
  };
}

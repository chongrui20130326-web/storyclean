import fs from 'node:fs';
import path from 'node:path';
import { BaseRetriever } from '@langchain/core/retrievers';
import { Document } from '@langchain/core/documents';
import { OpenAIEmbeddings } from '@langchain/openai';
import { sha256 } from './files.mjs';
import { isTitleSentence } from './lexicon.mjs';

export const hybridRetrievalVersion = 'book-hybrid-v1';
const batchSize = 8;
const poolSize = 8;
const outputSize = 4;
const numberOf = id => Number(id.slice(1));

export function createRoleEmbeddings(config, signal) {
  const model = config.roleEmbeddingModel;
  if (!model) throw Error('请填写向量模型 ID');
  const baseURL = config.gateway;
  const client = new OpenAIEmbeddings({
    model, apiKey: config.apiKey || 'localai', batchSize, maxConcurrency: 1, maxRetries: 0,
    timeout: Math.min(config.timeoutMs || 25000, 25000), stripNewLines: false,
    configuration: {
      baseURL, fetch: (input, options = {}) => fetch(input, {
        ...options, redirect: 'error',
        signal: signal && options.signal ? AbortSignal.any([signal, options.signal]) : signal || options.signal,
      }),
    },
  });
  return { model, key: sha256(JSON.stringify([baseURL, model, hybridRetrievalVersion])), client };
}

function normalized(values) {
  if (!Array.isArray(values) || !values.length || !values.every(Number.isFinite)) throw Error('网关未返回有效文本向量');
  const norm = Math.sqrt(values.reduce((sum, value) => sum + value * value, 0));
  if (!Number.isFinite(norm) || norm === 0) throw Error('网关返回了零向量或无效向量');
  return Float32Array.from(values, value => value / norm);
}

export async function checkRoleEmbeddings(embedding) {
  const vector = normalized(await embedding.client.embedQuery('人物身份检索测试'));
  return { model: embedding.model, dimensions: vector.length };
}

export function rolePassages(rows, scenes) {
  const first = rows[0]?.n;
  return scenes.flatMap(scene => {
    const selected = rows.slice(numberOf(scene.from) - first, numberOf(scene.to) - first + 1)
      .filter(row => !isTitleSentence(row.text));
    const passages = [];
    for (let start = 0; start < selected.length;) {
      let end = start, size = 0;
      while (end < selected.length && end - start < 6
        && (end === start || size + selected[end].text.length <= (end - start < 3 ? 800 : 350))) {
        size += selected[end].text.length;
        end += 1;
      }
      const slice = selected.slice(start, end);
      passages.push({ sceneId: scene.sceneId, from: slice[0].n, to: slice.at(-1).n,
        text: slice.map(row => row.text).join('\n') });
      if (end === selected.length) break;
      start = Math.max(start + 1, end - 1);
    }
    return passages;
  });
}

const blob = vector => Buffer.from(vector.buffer, vector.byteOffset, vector.byteLength);
const decode = value => new Float32Array(Uint8Array.from(value).buffer);

function atomic(db, action) {
  db.exec('BEGIN IMMEDIATE');
  try { action(); db.exec('COMMIT'); }
  catch (error) { db.exec('ROLLBACK'); throw error; }
}

function wordQueries(words) {
  return [...new Set(words.flatMap(word => word.match(/[\p{L}\p{N}]+/gu) || []))]
    .filter(word => Array.from(word).length >= 3).slice(0, 12).map(word => '"' + word + '"').join(' OR ');
}

function dot(left, right) {
  if (left.length !== right.length) throw Error('向量维度发生变化，请使用新的模型 ID');
  let score = 0;
  for (let i = 0; i < left.length; i += 1) score += left[i] * right[i];
  return score;
}

class BookRoleRetriever extends BaseRetriever {
  lc_namespace = ['novel-cleaning', 'role-retrieval'];

  constructor({ rows, keywords, db, embed, signal }) {
    super();
    Object.assign(this, { rows, keywords, db, embed, signal });
  }

  async _getRelevantDocuments(query) {
    this.signal?.throwIfAborted();
    const scored = new Map();
    const rank = (ids, method) => ids.forEach((id, position) => {
      const current = scored.get(id) || { score: 0, methods: [] };
      current.score += (method === 'exact' ? 2 : 1) / (60 + position);
      current.methods.push(method);
      scored.set(id, current);
    });
    const exact = this.rows.filter(row => this.keywords.some(word => word && row.text.includes(word))).map(row => row.id);
    rank(exact.slice(0, poolSize), 'exact');
    const match = wordQueries(this.keywords);
    if (match) {
      const words = this.db.prepare('SELECT passage_fts.rowid AS id FROM passage_fts JOIN active_scope ON active_scope.id = passage_fts.rowid'
        + ' WHERE passage_fts MATCH ? ORDER BY bm25(passage_fts), passage_fts.rowid LIMIT ?').all(match, poolSize);
      rank(words.map(row => row.id), 'keywords');
    }
    const vector = await this.embed(query);
    const nearest = this.rows.map(row => ({ id: row.id, score: dot(vector, row.vector) }))
      .sort((a, b) => b.score - a.score || a.id - b.id).slice(0, poolSize);
    rank(nearest.map(row => row.id), 'semantic');
    const byId = new Map(this.rows.map(row => [row.id, row]));
    return [...scored].sort((a, b) => b[1].score - a[1].score).slice(0, outputSize).map(([id, { methods }]) => {
      const item = byId.get(id);
      return new Document({ pageContent: item.text, metadata: { sceneId: item.sceneId, from: item.from, to: item.to, methods } });
    });
  }
}

export async function withBookRoleSearch({ work, rows, scenes, sourceHash, embedding, signal, onIndex = () => {} }, action) {
  const { DatabaseSync } = await import('node:sqlite');
  const dir = path.join(work, 'l2');
  fs.mkdirSync(dir, { recursive: true });
  const db = new DatabaseSync(path.join(dir, 'role-retrieval.sqlite'));
  try {
    db.exec(`
      PRAGMA busy_timeout = 2000;
      CREATE TABLE IF NOT EXISTS passages (id INTEGER PRIMARY KEY, key TEXT UNIQUE NOT NULL, vector BLOB);
      CREATE TABLE IF NOT EXISTS queries (key TEXT PRIMARY KEY, vector BLOB NOT NULL);
      CREATE VIRTUAL TABLE IF NOT EXISTS passage_fts USING fts5(text, tokenize='trigram');
      CREATE TEMP TABLE active_scope (id INTEGER PRIMARY KEY);
    `);
    const passages = rolePassages(rows, scenes);
    const select = db.prepare('SELECT id, vector FROM passages WHERE key = ?');
    const insert = db.prepare('INSERT INTO passages (key) VALUES (?)');
    const indexText = db.prepare('INSERT INTO passage_fts (rowid, text) VALUES (?, ?)');
    const scope = db.prepare('INSERT INTO active_scope (id) VALUES (?)');
    const profile = [sourceHash, embedding.key, hybridRetrievalVersion];
    const selected = [];
    atomic(db, () => {
      for (const passage of passages) {
        const key = sha256(JSON.stringify([...profile, passage.sceneId, passage.from, passage.to, passage.text]));
        const saved = select.get(key);
        const id = saved?.id ?? Number(insert.run(key).lastInsertRowid);
        if (!saved) indexText.run(id, passage.text);
        scope.run(id);
        selected.push({ ...passage, id, vector: saved?.vector ? decode(saved.vector) : null });
      }
    });
    const missing = selected.filter(passage => !passage.vector);
    const update = db.prepare('UPDATE passages SET vector = ? WHERE id = ?');
    let indexed = selected.length - missing.length;
    onIndex(indexed, selected.length);
    const client = embedding.client || (await embedding.load()).client;
    for (let offset = 0; offset < missing.length; offset += batchSize) {
      signal?.throwIfAborted();
      const batch = missing.slice(offset, offset + batchSize);
      const vectors = await client.embedDocuments(batch.map(row => row.text));
      signal?.throwIfAborted();
      if (!Array.isArray(vectors) || vectors.length !== batch.length) throw Error('向量数量与索引片段不一致');
      const parsed = vectors.map(normalized);
      atomic(db, () => batch.forEach((item, index) => {
        item.vector = parsed[index];
        update.run(blob(item.vector), item.id);
      }));
      indexed += batch.length;
      onIndex(indexed, selected.length);
    }
    const findQuery = db.prepare('SELECT vector FROM queries WHERE key = ?');
    const saveQuery = db.prepare('INSERT INTO queries VALUES (?, ?)');
    const embed = async text => {
      const key = sha256(JSON.stringify([...profile, text]));
      const saved = findQuery.get(key);
      if (saved) return decode(saved.vector);
      const prompt = /qwen3[-_ ]?embedding/i.test(embedding.model)
        ? 'Instruct: 检索能核对同一小说人物身份与姓名的原文。\nQuery: ' + text : text;
      const vector = normalized(await client.embedQuery(prompt));
      signal?.throwIfAborted();
      saveQuery.run(key, blob(vector));
      return vector;
    };
    return await action((query, keywords) => new BookRoleRetriever({ rows: selected, keywords, db, embed, signal }).invoke(query));
  } finally {
    db.close();
  }
}

import { writeJsonAtomic } from '../core/atomic-json.mjs';
import { readJson, sha256, writeJsonLines } from './files.mjs';

const relationTypes = '丈夫、妻子、父亲、母亲、儿子、女儿、兄弟、姐妹、上司、下属、朋友、仇人、主人、性奴、性伴、调教者、被调教者、债主、债务人';
const allowedTypes = new Set(relationTypes.split('、'));
export const relationPrompt = [
  '下面每行是同句中出现的多个角色。请只判断每句里这几个角色之间确认的关系。',
  '关系类型只能用 ' + relationTypes + '。',
  '同一句可以给多条关系（例如既是上司又是主人），但每条都要能从这句读出来；看不出来就跳过。',
  '',
  '只返回 JSON：{"relations":[{"句子":1,"甲":"CH13","类型":"丈夫","乙":"CH01"}]}（句子=上面每行的序号，必填）',
].join('\n');

function candidatePairs(rows, nameList) {
  const result = [];
  for (const row of rows) {
    const ids = [...new Set(nameList.filter(candidate => row.text.includes(candidate.name)).map(candidate => candidate.id))];
    if (ids.length < 2) continue;
    result.push({ sentence: row.n, line: row.text.slice(0, 120), ids, raw: row.text.slice(0, 200) });
    if (result.length === 8) break;
  }
  return result;
}

export async function buildCharacterRelations({
  book, rows, document, relationOut, relationProgress, relationPartial, template, ask, report, signal,
}) {
  const characterHash = sha256(JSON.stringify(document.characters));
  const previous = readJson(relationProgress, null);
  const current = previous?.characterHash === characterHash
    && previous.sourceHash === document.sourceHash && previous.templateHash === document.templateHash
    && previous.model === document.model;
  const chapters = new Set(current ? previous.chapters : []);
  const keyOf = relation => relation.from + '>' + relation.type + '>' + relation.to;
  const relations = new Map((current ? previous.relations : []).map(row => [keyOf(row), row]));
  const nameList = document.characters.flatMap(character => [character.name, ...character.aliases]
    .map(name => ({ id: character.id, name })));
  const names = new Map(document.characters.map(character => [character.id, character.name]));
  const byChapter = new Map();
  for (const row of rows) {
    if (!byChapter.has(row.chapterId)) byChapter.set(row.chapterId, []);
    byChapter.get(row.chapterId).push(row);
  }
  const save = () => {
    const snapshot = [...relations.values()];
    const now = new Date().toISOString();
    writeJsonAtomic(relationProgress, {
      chapters: [...chapters], at: now, characterHash, model: document.model,
      sourceHash: document.sourceHash, templateHash: document.templateHash, relations: snapshot,
    });
    writeJsonLines(relationPartial, snapshot);
    writeJsonAtomic(relationOut, {
      generatedAt: now, method: '同句共现 + 模型判定',
      totals: { relations: snapshot.length, chapters: chapters.size }, relations: snapshot,
    });
  };
  if (current) report(chapters.size);
  for (const chapter of book.chapters) {
    if (chapters.has(chapter.id)) continue;
    signal?.throwIfAborted();
    const pairs = candidatePairs(byChapter.get(chapter.id) || [], nameList);
    if (pairs.length) {
      const prompt = [
        '角色表：', nameList.map(row => row.id + ' ' + row.name).join(' / '), '',
        template, '',
        ...pairs.map((pair, i) => (i + 1) + '. ' + pair.line + '（' + pair.ids.join('、') + '）'),
      ].join('\n');
      const found = await ask(prompt, value => {
        if (!Array.isArray(value?.relations)) throw Error('关系响应缺少 relations 数组');
        return value.relations;
      });
      for (const result of found) {
        const from = String(result?.甲 ?? '').trim(), to = String(result?.乙 ?? '').trim();
        const type = String(result?.类型 ?? '').trim();
        const pair = pairs[Number(result?.句子) - 1];
        if (!pair || from === to || !pair.ids.includes(from) || !pair.ids.includes(to) || !allowedTypes.has(type)) continue;
        const evidence = { sentence: pair.sentence, text: pair.raw };
        const relation = { from, fromName: names.get(from), type, to, toName: names.get(to), chapter: chapter.id, evidence: [evidence] };
        const key = keyOf(relation), previous = relations.get(key);
        if (!previous) relations.set(key, relation);
        else if (!previous.evidence.some(row => row.sentence === evidence.sentence)) previous.evidence.push(evidence);
      }
    }
    chapters.add(chapter.id);
    save();
    report(chapters.size);
  }
  // A run can restart after the final chapter checkpoint but before publishing the table.
  save();
}

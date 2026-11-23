import { limitSceneCuts, toSceneRanges, validateSceneCuts } from './vendor/scene-boundaries.mjs';

export const MAX_SCENE_CHARS = 5000;

export function makeScenes(sentences, semanticCuts) {
  const allowed = new Set(sentences.slice(0, -1).map(s => s.n));
  validateSceneCuts({ cuts: semanticCuts }, allowed);
  const semantic = new Set(semanticCuts);
  const cuts = limitSceneCuts(sentences, semanticCuts, MAX_SCENE_CHARS);
  return toSceneRanges({}, sentences, cuts).map((row, i) => {
    const end = Number(row.to.slice(1));
    const boundary = semantic.has(end) ? 'model' : end === sentences.at(-1).n ? 'end' : 'length-limit';
    return { ...row, source: 'sentence-boundaries', sceneId: 'SC' + String(i + 1).padStart(3, '0'), boundary };
  });
}

const LEXICON = {
  pronoun: '他 她 它 我 你 您 自己 咱 妳 俺 别人 他人 彼此',
  kinship: '丈夫 妻子 老公 老婆 太太 夫人 父亲 母亲 爸爸 妈妈 爸 妈 儿子 女儿 哥哥 姐姐 弟弟 妹妹 岳父 岳母 公公 婆婆 情人 爱人',
  role: '男人 女人 少妇 老人 年轻人 男孩 女孩 少年 少女 主人 老大 大哥',
  collective: '他们 她们 它们 我们 你们 咱们 俺们 您们 妳们 他俩 她俩 它俩 我俩 你俩 您俩 咱俩 妳俩 俺俩 他们俩 她们俩 它们俩 我们俩 你们俩 咱们俩 你我 大家 众人 人群 对方 所有人 其他人',
};

const lexicon = new Map(Object.entries(LEXICON).flatMap(([category, words]) => words.split(' ').map(word => [word, category])));

function nameWord(value) {
  return typeof value === 'string' && /^[\p{Letter}\p{Mark}][\p{Letter}\p{Mark}·・'’-]{0,23}$/u.test(value) && !lexicon.has(value)
    && !/^[我你您他她它咱妳俺](?:们)?(?:的.*|俩|本人|两人|三人|几人|各自|一行|一群|等)$/.test(value);
}

function wordBuckets(words) {
  const buckets = new Map();
  for (const word of words) {
    const key = word[0];
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key).push(word);
  }
  for (const list of buckets.values()) list.sort((a, b) => b.length - a.length);
  return buckets;
}

function evidenceByWord(sentences, words) {
  const buckets = wordBuckets(words);
  const found = new Map();
  for (const s of sentences) {
    for (let i = 0; i < s.text.length; i += 1) {
      for (const word of buckets.get(s.text[i]) || []) {
        if (!s.text.startsWith(word, i)) continue;
        if (!found.has(word)) found.set(word, []);
        const rows = found.get(word);
        if (rows.length < 3 && rows.at(-1)?.sentenceId !== s.id) {
          rows.push({ sentenceId: s.id, start: i, end: i + word.length, surface: word });
        }
      }
    }
  }
  return found;
}

export function characterCandidates(value, sentences) {
  if (!Array.isArray(value?.characters) || value.characters.length > 250) throw Error('角色列表格式无效');
  const words = new Set();
  const candidates = [];
  for (const candidate of value.characters) {
    if (typeof candidate?.name !== 'string' || !Array.isArray(candidate.aliases) || candidate.aliases.length > 50
      || candidate.aliases.some(alias => typeof alias !== 'string')) throw Error('角色必须含 name 和 aliases');
    const name = candidate.name.trim();
    if (!nameWord(name)) continue;
    const aliases = [...new Set(candidate.aliases.map(a => a.trim()).filter(a => a !== name && nameWord(a)))];
    candidates.push({ name, aliases });
    words.add(name);
    for (const alias of aliases) words.add(alias);
  }
  const evidence = evidenceByWord(sentences, words);
  const grounded = candidates.filter(row => evidence.has(row.name)).map(row => ({
    name: row.name, aliases: row.aliases.filter(alias => evidence.has(alias)),
  }));
  if (value.characters.length && !grounded.length) throw Error('模型返回的人名无可核对的原句证据');
  return grounded;
}

export function makeCharacters(sentences, entries) {
  const names = new Map();
  const words = new Set();
  for (const row of entries) {
    if (!nameWord(row.name)) continue;
    if (!names.has(row.name)) names.set(row.name, new Set());
    words.add(row.name);
    for (const alias of row.aliases) {
      if (!nameWord(alias) || alias === row.name) continue;
      words.add(alias);
      names.get(row.name).add(alias);
    }
  }
  const evidence = evidenceByWord(sentences, words);
  const characters = [];
  for (const [name, aliases] of names) {
    const occurrences = evidence.get(name);
    if (!occurrences) continue;
    const aliasesInText = [...aliases].filter(alias => evidence.has(alias)).sort();
    characters.push({
      name, aliases: aliasesInText, firstSeen: occurrences[0].sentenceId,
      evidence: [...occurrences, ...aliasesInText.flatMap(alias => evidence.get(alias).slice(0, 1))],
    });
  }
  characters.sort((a, b) => Number(a.firstSeen.slice(1)) - Number(b.firstSeen.slice(1))
    || a.evidence[0].start - b.evidence[0].start || (a.name < b.name ? -1 : Number(a.name !== b.name)));
  return characters.map((row, index) => ({ id: 'CH' + String(index + 1).padStart(2, '0'), ...row }));
}

const openToClose = new Map([['“', '”'], ['‘', '’'], ['「', '」'], ['『', '』'], ['"', '"']]);

export function makeMentions(sentences, scenes, characters) {
  const characterIds = new Map();
  for (const role of characters) {
    for (const word of [role.name, ...role.aliases]) {
      if (lexicon.has(word)) continue;
      if (!characterIds.has(word)) characterIds.set(word, []);
      characterIds.get(word).push(role.id);
    }
  }
  const buckets = wordBuckets(new Set([...lexicon.keys(), ...characterIds.keys()]));
  const output = [];
  const quote = [];
  let sceneIndex = 0;
  let previousChapter;
  for (const s of sentences) {
    if (previousChapter !== s.chapterId) quote.length = 0;
    previousChapter = s.chapterId;
    while (s.n > Number(scenes[sceneIndex].to.slice(1))) sceneIndex += 1;
    for (let start = 0; start < s.text.length;) {
      const word = (buckets.get(s.text[start]) || []).find(value => s.text.startsWith(value, start));
      if (word) {
        const end = start + word.length;
        const candidateIds = characterIds.get(word) || [];
        output.push({
          id: 'M' + String(output.length + 1).padStart(6, '0'), surface: word,
          cls: lexicon.get(word) || 'name', chapterId: s.chapterId, sceneId: scenes[sceneIndex].sceneId,
          sentence: s.n, sentenceId: s.id, start, end, inDialog: quote.length > 0,
          characterId: candidateIds.length === 1 ? candidateIds[0] : '', candidateIds,
          source: candidateIds.length > 1 ? 'ambiguous-literal' : candidateIds.length === 1 ? 'literal-name' : 'lexicon',
        });
        start = end;
      } else {
        const ch = s.text[start++];
        if (ch === quote.at(-1)) quote.pop();
        else if (openToClose.has(ch)) quote.push(openToClose.get(ch));
      }
    }
  }
  return output;
}


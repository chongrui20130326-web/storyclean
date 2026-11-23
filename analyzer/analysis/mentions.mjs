import path from 'node:path';
import { writeJsonAtomic } from '../core/atomic-json.mjs';
import { loadBook, readJson, sentenceRows } from './files.mjs';
import { genericPronouns, isTitleSentence, lexicon } from './lexicon.mjs';

export const mentionPreviewFile = 'scene-mentions.preview.json';

function sceneBySentence(rows, scenes, prefixOnly) {
  const lookup = new Map();
  if (!scenes.length) return lookup;
  let cursor = 0;
  for (const scene of scenes) {
    const from = Number(String(scene.from).slice(1));
    const to = Number(String(scene.to).slice(1));
    const span = to - from + 1;
    if (!scene.sceneId || !Number.isSafeInteger(span) || span < 1 || from !== rows[cursor]?.n || to !== rows[cursor + span - 1]?.n) {
      throw Error('场景范围与句子编号不一致，请重新执行场景切分');
    }
    for (let i = cursor; i < cursor + span; i += 1) lookup.set(rows[i].n, scene.sceneId);
    cursor += span;
  }
  if (!prefixOnly && cursor !== rows.length) throw Error('场景未覆盖所有句子，请重新执行场景切分');
  return lookup;
}

export function scanMentions(book, scenes, characters, { prefixOnly = false } = {}) {
  const rows = sentenceRows(book);
  const sceneOfSentence = sceneBySentence(rows, scenes, prefixOnly);
  const names = new Map();
  for (const character of characters) {
    for (const word of [character.name, ...(character.aliases || [])]) {
      if (!word || genericPronouns.has(word)) continue;
      if (!names.has(word)) names.set(word, new Set());
      names.get(word).add(character.id);
    }
  }
  const words = new Map();
  for (const [word, ids] of names) {
    words.set(word, { word, cls: 'name', characterId: ids.size === 1 ? ids.values().next().value : '' });
  }
  for (const [cls, items] of Object.entries(lexicon)) {
    for (const word of items) {
      if (!words.get(word)?.characterId) words.set(word, { word, cls, characterId: '' });
    }
  }
  const byInitial = new Map();
  for (const item of [...words.values()].sort((a, b) => b.word.length - a.word.length)) {
    const initial = item.word[0];
    if (!byInitial.has(initial)) byInitial.set(initial, []);
    byInitial.get(initial).push(item);
  }
  const mentions = [];
  const stats = { pronoun: 0, kinship: 0, role: 0, collective: 0, name: 0 };
  for (const { n, text, chapterId } of rows) {
    if (prefixOnly && !sceneOfSentence.has(n)) break;
    if (isTitleSentence(text)) continue;
    let inDialog = false;
    for (let i = 0; i < text.length;) {
      const hit = byInitial.get(text[i])?.find(item => text.startsWith(item.word, i));
      const end = i + (hit?.word.length || 1);
      if (hit) {
        stats[hit.cls] += 1;
        mentions.push({
          id: 'M' + String(mentions.length + 1).padStart(6, '0'),
          surface: hit.word, cls: hit.cls, chapterId, sentence: n, start: i, end,
          characterId: hit.characterId, inDialog, sceneId: sceneOfSentence.get(n) || '',
        });
      }
      // Match the original scanner's quote parity, evaluating exactly the characters before each hit.
      for (let at = i; at < end; at += 1) {
        if ('“「『"'.includes(text[at])) inDialog = !inDialog;
      }
      i = end;
    }
  }
  return { totals: { mentions: mentions.length, characters: characters.length, ...stats }, mentions };
}

export function runMentions({ work, preview }) {
  const { book, l2, sourceHash } = loadBook(work);
  const characters = preview || readJson(path.join(l2, 'characters.json'), { characters: [] });
  const scenes = preview || readJson(path.join(l2, 'scenes-llm.json'), { scenes: [] });
  if ((characters.sourceHash && characters.sourceHash !== sourceHash) || (scenes.sourceHash && scenes.sourceHash !== sourceHash)) {
    throw Error('角色或场景结果使用了旧的内容编号，请重新生成');
  }
  const doc = {
    generatedAt: new Date().toISOString(), method: '词表扫描（无模型）', sourceHash,
    ...(preview && { previewKey: preview.key, scenes: scenes.scenes.length }),
    ...scanMentions(book, scenes.scenes, characters.characters, { prefixOnly: Boolean(preview) }),
  };
  writeJsonAtomic(path.join(l2, preview ? mentionPreviewFile : 'mention-table.json'), doc);
  return doc;
}

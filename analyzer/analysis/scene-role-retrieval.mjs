import { sha256 } from './files.mjs';
import { genericPronouns, isTitleSentence, lexicon } from './lexicon.mjs';
import { evidenceKey, identityCue } from './scene-role-evidence.mjs';

export const roleRetrievalVersion = 'book-quotes-v1';
const genericTitle = /^(?:教授|老师|先生|女士|小姐|同学|同事|主任|主席|同志|师傅|医生|护士|父亲|母亲|老人|孩子|男人|女人|书记|警察)$/;
const genericWords = new Set([...genericPronouns, ...lexicon.kinship, ...lexicon.role]);
const normalize = surface => surface.replace(/^(?:这|那|某|另)(?:一)?(?:位|个|名)|^(?:他的|她的|我的|你的)/u, '');
const usable = label => label.length >= 2 && label.length <= 32 && !genericWords.has(label) && !genericTitle.test(label);
const clauseBreak = /[。！？!?；;：:「」“”]/;
const doubtful = /并非|不是|未必|不一定|也许|可能|听说|传闻|据说|有人怀疑|怀疑|难道|冒充|假装|谎称|吗[。！？?？]?$|[?？]/;
export function isDoubtfulIdentity(text, start, end) {
  const prefix = text.slice(Math.max(0, start - 24), start).split(clauseBreak).at(-1);
  const suffix = text.slice(end, end + 12).split(/[。！；;]/)[0];
  return doubtful.test(prefix + text.slice(start, end) + suffix);
}

function occurrences(text, value) {
  const indices = [];
  for (let offset = text.indexOf(value); offset !== -1; offset = text.indexOf(value, offset + value.length)) indices.push(offset);
  return indices;
}

function identityQuote(text, label, name, startOfName) {
  for (const startOfLabel of occurrences(text, label)) {
    const [left, right] = startOfLabel < startOfName ? [[startOfLabel, label], [startOfName, name]]
      : [[startOfName, name], [startOfLabel, label]];
    const between = text.slice(left[0] + left[1].length, right[0]);
    if (right[0] < left[0] + left[1].length || between.length > 34 || clauseBreak.test(between) || !identityCue.test(between)) continue;
    const end = right[0] + right[1].length;
    if (isDoubtfulIdentity(text, left[0], end)) continue;
    return { start: left[0], end, surface: text.slice(left[0], end), kind: 'identity' };
  }
  return null;
}

function bigrams(text) {
  const runs = text.match(/[\p{L}\p{N}]+/gu) || [];
  const terms = new Set();
  for (const run of runs) {
    const chars = Array.from(run);
    for (let i = 0; i + 1 < chars.length; i += 1) terms.add(chars[i] + chars[i + 1]);
  }
  return terms;
}

function nearbyText(lines, n, start, end) {
  const previous = lines.get(n - 1)?.text || '';
  const current = lines.get(n)?.text.slice(Math.max(0, start - 120), end + 130) || '';
  const following = lines.get(n + 1)?.text || '';
  return [previous.slice(-110), current, following.slice(0, 110)].filter(Boolean).join('\n');
}

export function retrieveIdentityCandidates(people, rows, through, checked = {}) {
  const lines = new Map(rows.filter(row => row.n <= through && !isTitleSentence(row.text)).map(row => [row.n, row]));
  const pending = people.filter(person => !person.name).map(person => {
    const claims = person.evidence.filter(item => item.kind === 'address' && lines.has(item.sentence));
    const terms = [...new Set(claims.flatMap(item => [item.surface, normalize(item.surface)]))].filter(usable);
    const contexts = new Map(claims.map(item => {
      const excerpt = nearbyText(lines, item.sentence, item.start, item.end);
      return [item, { excerpt, terms: bigrams(excerpt) }];
    }));
    return { person, claims, terms, contexts };
  }).filter(row => row.terms.length);
  if (!pending.length) return [];

  const idsByName = new Map();
  for (const person of people.filter(row => row.name)) {
    for (const name of new Set([person.name, ...person.aliases])) {
      if (!idsByName.has(name)) idsByName.set(name, []);
      idsByName.get(name).push(person);
    }
  }
  const possible = [...lines.values()].filter(row => identityCue.test(row.text)).flatMap(row => {
    const hits = [...idsByName.entries()].filter(([name]) => row.text.includes(name)).flatMap(([name, owners]) =>
      occurrences(row.text, name).map(start => ({ name, start, owners })));
    return hits.length ? [{ row, hits }] : [];
  });
  const items = [];
  for (const { person, claims, terms, contexts } of pending) {
    // A description shared by two unresolved people is not distinctive enough to make a link.
    const distinctive = terms.filter(term => !pending.some(other => other.person.id !== person.id && other.terms.includes(term)));
    if (!distinctive.length) continue;
    const best = new Map();
    for (const { row, hits } of possible) {
      for (const label of distinctive) {
        if (!row.text.includes(label)) continue;
        for (const hit of hits) {
          if (hit.owners.length !== 1 || hits.some(other => other !== hit && other.name.length > hit.name.length
            && other.start <= hit.start && other.start + other.name.length >= hit.start + hit.name.length)) continue;
          const proof = identityQuote(row.text, label, hit.name, hit.start);
          if (!proof) continue;
          for (const claim of claims.filter(item => item.surface === label || normalize(item.surface) === label)) {
            if (claim.sentence === row.n) continue;
            const local = contexts.get(claim);
            const related = nearbyText(lines, row.n, proof.start, proof.end);
            const overlap = [...bigrams(related)].filter(term => local.terms.has(term)).length;
            const personHit = hit.owners[0];
            const score = (label === claim.surface ? 20 : 10) + (hit.name === personHit.name ? 10 : 0)
              + Math.min(overlap, 30) - Math.log2(1 + Math.abs(row.n - claim.sentence));
            const candidate = { to: personHit.id, name: personHit.name, quote: proof.surface, identitySentence: row.n,
              proof: { sentence: row.n, ...proof }, mention: claim, excerpt: local.excerpt, context: related, score };
            if (!best.has(personHit.id) || best.get(personHit.id).score < score) best.set(personHit.id, candidate);
          }
        }
      }
    }
    // Leave competing identity claims unresolved.
    if (best.size !== 1) continue;
    const [target] = best.values();
    const key = sha256(JSON.stringify([person.id, target.to, evidenceKey(target.mention), evidenceKey(target.proof)]));
    if (checked[person.id] === key) continue;
    items.push({ from: person.id, label: target.mention.surface, key, ...target });
  }
  return items;
}

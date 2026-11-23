import { sha256 } from './files.mjs';
import { evidenceKey, identityCue } from './scene-role-evidence.mjs';
import { isDoubtfulIdentity } from './scene-role-retrieval.mjs';
import { withBookRoleSearch } from './role-hybrid-search.mjs';
import { isTitleSentence } from './lexicon.mjs';

const backwardReference = /刚才|方才|先前|此前|之前|适才|当时/gu;
const breakBeforeName = /[。！？!?；;：:]/u;
const lastSentence = scenes => Number(scenes.at(-1).to.slice(1));

function namedOwners(people) {
  const names = new Map();
  for (const person of people.filter(row => row.name)) {
    for (const surface of new Set([person.name, ...person.aliases])) {
      if (!names.has(surface)) names.set(surface, []);
      names.get(surface).push(person);
    }
  }
  return [...names].sort((a, b) => b[0].length - a[0].length);
}

function identityReferences(lines, owners) {
  const references = [];
  for (const row of lines) {
    if (!identityCue.test(row.text)) continue;
    for (const reference of row.text.matchAll(backwardReference)) {
      const start = reference.index;
      const predicate = row.text.slice(start + reference[0].length, start + 96).split(breakBeforeName)[0];
      const frame = [];
      for (const [name, people] of owners) {
        const relative = predicate.indexOf(name);
        if (relative === -1 || frame.some(hit => relative >= hit.relative && relative + name.length <= hit.relative + hit.name.length)) continue;
        const lead = predicate.slice(0, relative);
        if (!identityCue.test(lead) || /另一(?:位|名|个|人)|另有一(?:位|名|个)|其他(?:人|那位)/.test(lead)) continue;
        const end = start + reference[0].length + relative + name.length;
        if (isDoubtfulIdentity(row.text, start, end)) continue;
        frame.push({ name, relative, people, row, lead, proof: { sentence: row.n, start, end, surface: row.text.slice(start, end), kind: 'identity' } });
      }
      references.push(...frame);
    }
  }
  return references;
}

function sharedAction(local, mention, precedingName) {
  for (const match of local.surface.matchAll(/[\p{L}\p{N}]+/gu)) {
    for (let length = Math.min(match[0].length, 30); length >= 4; length -= 1) {
      for (let offset = 0; offset + length <= match[0].length; offset += 1) {
        const surface = match[0].slice(offset, offset + length);
        if (!precedingName.includes(surface)) continue;
        const start = local.start + match.index + offset;
        if (local.sentence === mention.sentence && start < mention.end && start + surface.length > mention.start) continue;
        return { kind: 'presence', sentence: local.sentence, start, end: start + surface.length, surface };
      }
    }
  }
  return null;
}

const isAnchored = (lines, item) => lines.get(item.sentence)?.text.slice(item.start, item.end) === item.surface;

export async function findHybridReviewCandidates({ work, sourceHash, people, rows, scenes, embedding, exact, checked, signal, onIndex }) {
  if (!scenes.length) return [];
  const through = lastSentence(scenes);
  const lines = new Map(rows.filter(row => row.n <= through && !isTitleSentence(row.text)).map(row => [row.n, row]));
  const exactIds = new Set(exact.map(row => row.from));
  const pending = new Set(people.filter(person => !person.name && !exactIds.has(person.id)).map(person => person.id));
  if (!pending.size) return [];
  const observations = scenes.flatMap(scene => scene.roles.flatMap(role => {
    if (!pending.has(role.roleId) || role.status !== 'present') return [];
    const mention = role.evidence.find(item => item.kind === 'address' && isAnchored(lines, item));
    const actions = role.evidence.filter(item => item.kind === 'presence' && isAnchored(lines, item));
    return mention && actions.length ? [{ from: role.roleId, mention, actions }] : [];
  }));
  if (!observations.length) return [];
  const references = identityReferences([...lines.values()], namedOwners(people));
  const plans = observations.flatMap(observation => {
    const matches = references.flatMap(reference => {
      for (const action of observation.actions) {
        if (action.sentence >= reference.row.n) continue;
        const bridge = sharedAction(action, observation.mention, reference.lead);
        if (bridge && !observations.some(other => other.from !== observation.from
          && other.actions.some(item => item.surface.includes(bridge.surface)))) return [{ reference, bridge, action }];
      }
      return [];
    });
    const targets = new Set(matches.flatMap(match => match.reference.people.map(person => person.id)));
    return targets.size === 1 ? [{ ...observation, matches, target: [...targets][0] }] : [];
  });
  if (!plans.length) return [];
  const peopleById = new Map(people.map(person => [person.id, person]));
  return withBookRoleSearch({ work, rows, scenes, sourceHash, embedding, signal, onIndex }, async search => {
    const results = new Map();
    for (const { from, mention, matches, target } of plans) {
      signal?.throwIfAborted();
      if (results.has(from)) continue;
      const excerpt = lines.get(mention.sentence).text.slice(Math.max(0, mention.start - 100), mention.end + 180);
      const action = matches[0].action.surface;
      const person = peopleById.get(target);
      const retrieved = await search([mention.surface, action, excerpt].join('\n'), [mention.surface, action]);
      const selected = retrieved.flatMap(doc => matches.filter(match => match.reference.row.n >= doc.metadata.from
        && match.reference.row.n <= doc.metadata.to).map(match => ({ ...match, methods: doc.metadata.methods })))[0];
      if (!selected) continue;
      const { reference, bridge, methods } = selected;
      const proof = reference.proof;
      const key = sha256(JSON.stringify([from, target, evidenceKey(mention), evidenceKey(bridge), evidenceKey(proof)]));
      if (checked[from] === key) continue;
      results.set(from, { from, to: target, key, mention, bridge, proof, methods, label: mention.surface, name: person.name,
        identitySentence: proof.sentence, quote: proof.surface, excerpt, context: reference.row.text.slice(Math.max(0, proof.start - 100), proof.end + 120) });
    }
    return [...results.values()];
  });
}

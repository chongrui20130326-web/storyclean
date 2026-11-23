import { genericPronouns, isTitleSentence } from './lexicon.mjs';
import { createRoleNameClassifier, roleEvidenceKind } from './scene-role-names.mjs';

export const SCENE_ROLE_STRATEGY = 'scene-evidence-v1';
export const roleStatuses = new Set(['present', 'mentioned', 'uncertain']);
export const evidenceKinds = new Set(['name', 'presence', 'mention', 'address', 'identity', 'alias']);
export const identityCue = /就是|正是|原来是|其实是|姓(?:名)?|名叫|真名|本名|原名|又名|也叫|又叫|别名|外号|绰号|化名|自称|曾用名/;
const aliasCue = /又名|又叫|也叫|别名|外号|绰号|化名|自称|曾用名|本名|真名|原名/;

const previousSceneRolePrompt = [
  '只核对本场编号原文中具体的人物。分开标记实际出场 present、仅被提及 mentioned、是否出场不明 uncertain。',
  '实际出场须引用本场动作、发言或明确在场的原文，证据 kind 为 presence。只被谈及、回忆、转述时使用 mention。',
  '姓名 name 只填原文实际写出的专名，另外提交对应的 name 证据；只有姓氏、身份、关系、评价、代词时姓名留空。',
  '具体人物虽然没有姓名也可收录，给出原文中的具体称呼 address。给出有关人物的原文称呼和出现位置，避免抄录其他人的称呼。',
  '已知人物列表只供身份核对。有明确上下文证明同一人才填写 knownId，并引用本场 identity 证据。称谓相同或相邻出现不足以证明。',
  '确为稳定的专属别名时才填写 aliases，同时引用一句明确说明姓名和别名关系的正文；职业、亲属、姓氏和评价只作本场称呼。',
  'sentence 是原文的全书句号编号。surface、quote 必须逐字摘录。所有证据必须来自本次输入，不要补写或推测。',
  '只返回 JSON。例：{"roles":[{"name":"陈清","knownId":"","status":"present","evidence":[{"sentence":7,"surface":"陈清","kind":"name"},{"sentence":7,"surface":"陈清走进门","kind":"presence"}],"aliases":[]}]}。',
  '本段无具体人物时返回 {"roles":[]}。',
].join('\n');

const previousIdentityReviewPrompt = [
  '复核下列待确认身份，只核对给出的关系候选与对应原文。',
  '只有前场称呼与后场明确揭示姓名指同一人物且无歧义时才确认。称谓相同而身份不明确，或不能确定前后场是同一个人时跳过。',
  '只返回 JSON：{"links":[{"from":"CH01","to":"CH02","earlier":1,"later":2,"quote":"逐字抄录给出的后场身份证据"}]}。没有足够证据时返回空数组。',
].join('\n');

export const previousRolePrompts = [previousSceneRolePrompt, previousIdentityReviewPrompt];
export const sceneRolePrompt = previousSceneRolePrompt + '\n'
  + '先从输入复制短证据，再填写人物。不要从 1 重新编号。若原文只写职称或亲属关系，name 留空，逐字复制该称呼为 address。'
  + '姓名与动作可来自同一个原文片段。没有可复制的证据时省略这条。';
export const identityReviewPrompt = [
  '复核下列同一本书的原文检索结果。mention 是某场人物称呼的原文编号与片段，targets 是身份候选及其揭示姓名的证据。',
  '仅在原先的称呼和检索到的身份句可确定是同一人时确认。职业、亲属称呼相同或语义相似本身不足，遇到歧义就跳过。',
  '只返回 JSON：{"links":[{"from":"CH01","to":"CH02","mentionSentence":1,"identitySentence":2,"quote":"逐字抄录候选中的身份片段"}]}。证据不足时返回 {"links":[]}。',
].join('\n');

const sentenceNumber = value => typeof value === 'string' && /^S?[1-9]\d*$/i.test(value.trim())
  ? Number(value.trim().replace(/^S/i, '')) : value;

function locate(rows, sentence, surface, kind) {
  if (typeof surface !== 'string') return null;
  const quote = surface.trim();
  if (!quote || quote.length > 300) return null;
  const preferred = sentenceNumber(sentence);
  const matches = [];
  let ambiguous = false;
  for (const row of rows) {
    if (isTitleSentence(row.text)) continue;
    const index = row.text.indexOf(quote);
    if (index < 0) continue;
    const start = (row.offset || 0) + index;
    const proof = { sentence: row.n, surface: quote, start, end: start + quote.length, kind };
    if (row.n === preferred) return proof;
    ambiguous ||= row.text.indexOf(quote, index + 1) !== -1;
    matches.push(proof);
  }
  return matches.length === 1 && !ambiguous ? matches[0] : null;
}

function useSubquote(evidence, surface, kind) {
  if (!surface) return null;
  for (const item of evidence) {
    const relative = item.surface.indexOf(surface);
    if (relative < 0 || item.kind === 'identity') continue;
    const start = item.start + relative;
    return { sentence: item.sentence, surface, start, end: start + surface.length, kind };
  }
  return null;
}

export const evidenceKey = item => item.sentence + ':' + item.start + ':' + item.end + ':' + item.kind;
export function combineEvidence(target, additions) {
  const keys = new Set(target.map(evidenceKey));
  for (const item of additions) {
    const key = evidenceKey(item);
    if (keys.has(key)) continue;
    target.push(item);
    keys.add(key);
  }
}

export function readSceneFindings(value, rows, knownIds = new Set()) {
  if (!Array.isArray(value?.roles)) throw Error('场景角色响应缺少 roles 数组');
  const classify = createRoleNameClassifier(rows);
  const found = [];
  let ignored = 0;
  for (const item of value.roles) {
    const status = ({ 出场: 'present', 实际出场: 'present', 仅被提及: 'mentioned', 待确认: 'uncertain' })[item?.status] || item?.status;
    if (!roleStatuses.has(status) || !Array.isArray(item.evidence)) continue;
    const evidence = [];
    for (const fact of item.evidence) {
      const kind = ({ 姓名: 'name', 出场: 'presence', 提及: 'mention', 称呼: 'address', 本场称呼: 'address', 身份对应: 'identity' })[fact?.kind] || fact?.kind;
      if (!evidenceKinds.has(kind) || kind === 'alias') continue;
      const anchored = locate(rows, fact.sentence, fact.surface ?? fact.quote, kind);
      if (anchored) combineEvidence(evidence, [anchored]);
    }
    const proposed = typeof item.name === 'string' ? item.name.trim() : '';
    const kindOf = word => classify(word, evidence);
    const proposedKind = kindOf(proposed);
    const address = evidence.filter(row => row.kind === 'address');
    const labelProof = address.find(row => !genericPronouns.has(row.surface) && kindOf(row.surface) !== 'nonperson');
    if ((proposedKind === 'nonperson' && useSubquote(evidence, proposed, 'address'))
      || (!proposed && !labelProof && address.some(row => kindOf(row.surface) === 'nonperson'))) {
      ignored += 1;
      continue;
    }
    for (const fact of evidence) fact.kind = roleEvidenceKind(fact, kindOf);
    let name = '', label = labelProof?.surface || evidence.find(row => row.kind === 'address' && kindOf(row.surface) === 'address')?.surface || '';
    if (proposedKind === 'name') {
      const nameProof = evidence.find(row => row.kind === 'name' && row.surface === proposed) || useSubquote(evidence, proposed, 'name');
      if (nameProof) {
        name = proposed;
        combineEvidence(evidence, [nameProof]);
      }
    } else if (!label && proposedKind === 'address') {
      const address = useSubquote(evidence, proposed, 'address');
      if (address) {
        label = proposed;
        combineEvidence(evidence, [address]);
      }
    }
    const knownId = knownIds.has(item.knownId)
      && evidence.some(row => row.kind === 'identity') ? item.knownId : '';
    if (!name && !label && !knownId) continue;
    const hasProof = status === 'present' ? evidence.some(row => row.kind === 'presence' && row.surface !== name && row.surface !== label)
      : status === 'mentioned' && evidence.some(row => ['mention', 'name', 'address'].includes(row.kind));
    const aliases = [];
    for (const alias of Array.isArray(item.aliases) ? item.aliases : []) {
      if (!name || typeof alias?.name !== 'string' || alias.name === name || typeof alias.quote !== 'string'
        || !aliasCue.test(alias.quote) || !alias.quote.includes(name) || !alias.quote.includes(alias.name)
        || name.includes(alias.name) || alias.name.includes(name)) continue;
      const support = locate(rows, alias.sentence, alias.quote, 'identity');
      const token = locate(rows, alias.sentence, alias.name, 'alias');
      if (!support || !token || classify(alias.name, [support, token]) !== 'name') continue;
      aliases.push(alias.name);
      combineEvidence(evidence, [support, token]);
    }
    found.push({ name, label, knownId, aliases, status: hasProof ? status : 'uncertain', evidence });
  }
  if (value.roles.length && !found.length && ignored !== value.roles.length) throw Error('返回的人物缺少可核对的姓名或称呼证据');
  return found;
}

export function validateSceneRoleLayer(doc, lines, sceneTable, characterTable) {
  if (doc.strategy !== SCENE_ROLE_STRATEGY || typeof doc.complete !== 'boolean'
    || typeof doc.rosterReady !== 'boolean' || typeof doc.model !== 'string' || !doc.model
    || !Number.isSafeInteger(doc.nextId) || doc.nextId < 1
    || !/^[a-f0-9]{64}$/.test(doc.sourceHash) || !/^[a-f0-9]{64}$/.test(doc.templateHash)
    || !Array.isArray(doc.people) || !Array.isArray(doc.scenes)) throw Error('逐场角色结果格式不正确');
  const verifyEvidence = ({ sentence, surface, start, end, kind }, first, last) => {
    const text = lines.get(sentence)?.text;
    if (typeof surface !== 'string' || !surface.length || !evidenceKinds.has(kind) || !Number.isInteger(start)
      || start < 0 || sentence < first || sentence > last || end !== start + surface.length || text?.slice(start, end) !== surface) {
      throw Error('逐场角色的证据句或原文位置不一致');
    }
  };
  const people = new Map();
  for (const person of doc.people) {
    if (!/^CH\d+$/.test(person.id) || Number(person.id.slice(2)) >= doc.nextId || people.has(person.id)
      || typeof person.name !== 'string' || typeof person.label !== 'string'
      || !Array.isArray(person.aliases) || !Array.isArray(person.evidence) || !person.evidence.length
      || !Number.isInteger(person.firstSeen) || !Number.isInteger(person.lastSeen) || person.firstSeen > person.lastSeen
      || (person.name && !person.evidence.some(row => row.kind === 'name' && row.surface === person.name))
      || person.aliases.some(alias => typeof alias !== 'string' || !person.evidence.some(row => row.kind === 'alias' && row.surface === alias))) {
      throw Error('逐场角色编号或姓名证据不正确');
    }
    person.evidence.forEach(row => verifyEvidence(row, person.firstSeen, person.lastSeen));
    people.set(person.id, person);
  }
  const starts = lines.keys();
  let next = starts.next().value;
  const found = new Set();
  const localMentions = new Map();
  const localActions = new Map();
  for (const [index, scene] of doc.scenes.entries()) {
    const to = /^S[1-9]\d*$/.test(scene.to) ? Number(scene.to.slice(1)) : 0;
    const linked = sceneTable?.[index];
    if (scene.sceneId !== 'SC' + String(index + 1).padStart(3, '0') || scene.from !== 'S' + next || to < next || !lines.has(to)
      || (sceneTable && (scene.sceneId !== linked?.sceneId || scene.from !== linked.from || scene.to !== linked.to))
      || !Array.isArray(scene.roles)) throw Error('逐场角色的场景编号或范围不一致');
    const used = new Set();
    for (const role of scene.roles) {
      if (!people.has(role.roleId) || used.has(role.roleId) || !roleStatuses.has(role.status)
        || !Array.isArray(role.evidence) || !role.evidence.length
        || (role.status === 'present' && !role.evidence.some(row => row.kind === 'presence'))) throw Error('逐场角色的角色引用或出场证据不一致');
      role.evidence.forEach(row => verifyEvidence(row, next, to));
      if (!localMentions.has(role.roleId)) localMentions.set(role.roleId, new Set());
      for (const item of role.evidence.filter(row => row.kind === 'address')) localMentions.get(role.roleId).add(evidenceKey(item));
      if (!localActions.has(role.roleId)) localActions.set(role.roleId, []);
      for (const item of role.evidence.filter(row => row.kind === 'presence')) localActions.get(role.roleId).push(item);
      used.add(role.roleId);
      found.add(role.roleId);
    }
    next = to + 1;
  }
  for (const person of doc.people.filter(row => row.identityLinks !== undefined)) {
    if (!person.name || !Array.isArray(person.identityLinks)) throw Error('跨场身份记录格式不正确');
    for (const { mention, proof, bridge } of person.identityLinks) {
      const linkExists = mention && proof && mention.kind === 'address' && proof.kind === 'identity'
        && mention.sentence !== proof.sentence && localMentions.get(person.id)?.has(evidenceKey(mention))
        && person.evidence.some(item => evidenceKey(item) === evidenceKey(proof) && item.surface === proof.surface);
      if (!linkExists) throw Error('跨场身份记录与本场称呼或身份原句不一致');
      verifyEvidence(mention, person.firstSeen, next - 1);
      verifyEvidence(proof, person.firstSeen, next - 1);
      if (bridge !== undefined) {
        verifyEvidence(bridge, person.firstSeen, next - 1);
        if (bridge.kind !== 'presence' || bridge.surface.length < 4 || !proof.surface.includes(bridge.surface)
          || !localActions.get(person.id)?.some(row => row.sentence === bridge.sentence && row.start <= bridge.start && row.end >= bridge.end)) {
          throw Error('混合检索的动作证据与角色出场原句不一致');
        }
      }
    }
  }
  if (people.size !== found.size || (doc.complete && !doc.rosterReady)
    || (doc.rosterReady && (!sceneTable || doc.scenes.length !== sceneTable.length || characterTable?.strategy !== SCENE_ROLE_STRATEGY))) {
    throw Error('逐场角色的覆盖范围不一致');
  }
  if (characterTable?.strategy === SCENE_ROLE_STRATEGY) {
    const named = doc.people.filter(person => person.name);
    if (named.length !== characterTable.characters.length || characterTable.characters.some(person =>
      people.get(person.id)?.name !== person.name || JSON.stringify(people.get(person.id).aliases) !== JSON.stringify(person.aliases))) {
      throw Error('逐场角色与真名表不一致');
    }
  }
}

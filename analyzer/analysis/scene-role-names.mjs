import { genericPronouns, lexicon } from './lexicon.mjs';

const descriptions = new Set([
  ...lexicon.kinship, ...lexicon.role,
  '孩子', '老者', '中年人', '年轻男子', '上帝', '教皇', '骑士', '卫士', '武士', '旗手',
  '轻转兵', '译员', '审问者', '取信人', '组织者', '追随者', '幸存者', '陌生人', '来访者',
]);
const titleSuffixes = [
  '警察', '军人', '罪犯', '囚犯', '犯人', '嫌疑人', '犯罪者', '被告', '犯嫌', '警官', '警卫', '保安',
  '军官', '士兵', '骑兵', '哨兵', '战士', '士官', '上校', '中校', '少校', '上尉', '中尉', '少尉', '将军',
  '首长', '统帅', '司令', '指挥官', '信号官', '指导员', '政委', '参谋', '连长', '排长', '分队长',
  '司机', '医生', '护士', '医师', '警员', '记者', '学者', '作家', '专家', '科学家', '天文学家', '哲学家', '数学家', '物理学家',
  '教授', '老师', '教师', '先生', '女士', '小姐', '院士', '同志', '主席', '主任', '同学', '同事', '叔叔', '阿姨',
  '父亲', '母亲', '舅舅', '舅妈', '对象', '分子', '敌人', '权威', '领导', '领袖', '部长', '局长', '所长', '队长', '厂长',
  '校长', '站长', '会长', '国王', '皇帝', '大臣', '总裁', '总经理', '董事长', '顾问', '秘书长', '秘书', '元首', '执政官',
  '工程师', '技术员', '管理员', '操作员', '记录员', '协调员', '负责人', '博士生', '研究生', '研究员', '学生',
  '保姆', '长老', '和尚', '僧人', '修士', '农民', '知青', '工人', '员工', '人员', '红卫兵', '天才',
  '男孩', '女孩', '妇女', '妇人', '少妇', '女人', '男人', '老人', '年轻人', '中年人', '孩子',
  '西洋人', '欧洲人', '亚洲人', '地球人', '三体人',
];
const nonPeople = new Set([
  ...lexicon.collective, '绿军装', '操场', '三体教', '基督教', '伊斯兰教', '拯救派', '降临派', '幸存派',
  '地球三体叛军降临派', '地铁人',
]);
const ordinaryNouns = new Set([
  '书房', '客厅', '卧室', '厨房', '走廊', '会场', '台球桌', '餐桌', '书桌', '讲台', '巨摆', '电话', '电脑',
  '原子', '宏原子', '智子', '宇宙', '宏宇宙', '低维度', '物理学', '空气回力', '会议', '作战中心',
]);
const group = /^(?:(?:另外|另有)?[一二两三四五六七八九十百几数〇零]+(?:多|余)?(?:群|伙|队|批)|(?:两|三|四|五|六|七|八|九|十|几|数|二|几十|数十|数百)[名个位口])|(?:们|老两口|许多人|的几十位农民)$/u;
const place = /(?:组织|模型|基地|天文台|政府|使馆|派出所|机构|研究所|委员会|办公室|(?:会议|实验|控制|阅览|值班|审讯|指挥)室|公司|叛军|军队|部队|舰队|联盟|运动|阵营|世界|文明|教会)$/u;
const facilitySuffix = /^(?:加速器|天文台|发射场|天线阵列|观测站|试验场)/u;
const credit = /^(?:《[^》]+》\s*)?(?:作者|译者|校对|排版)[：:]\s*[\p{L}·・ ]{2,40}[。.]?$/u;
const humanNameCue = /(?:[他她我你]|此人|(?:这|那)(?:个|位)(?:人|女孩|男孩|男子|女子|姑娘|孩子|角色))(?:的)?(?:名字(?:是|叫(?:作|做)?)|(?:本名|真名|原名|姓名|外号|绰号|化名)(?:是|叫(?:作|做)?)?|名叫|叫(?:作|做)?|自称)\s*[“「『"']?$/u;
const endOfName = /^(?:$|[。！？；，、.!?;,:：”」』"'\s])/u;

function roleNameKind(value) {
  if (typeof value !== 'string' || !value) return 'unknown';
  if (nonPeople.has(value) || group.test(value) || place.test(value)) return 'nonperson';
  if (genericPronouns.has(value)) return 'unknown';
  if (descriptions.has(value) || titleSuffixes.some(title => value.endsWith(title))
    || /^(?:这|那|某|一|另一)(?:位|个|名)|^\p{Script=Han}[父母]$|的(?:人|一对)?$/u.test(value)) return 'address';
  return /^[\p{L}·・]{2,40}$/u.test(value) ? 'name' : 'unknown';
}

export function createRoleNameClassifier(rows = []) {
  const bySentence = new Map();
  for (const row of rows) {
    if (!bySentence.has(row.n)) bySentence.set(row.n, []);
    bySentence.get(row.n).push(row);
  }
  return (word, evidence = []) => {
    const kind = roleNameKind(word);
    if (kind !== 'name') return kind;
    let appearsAsNonRole = false;
    let appearsInOtherContext = false;
    for (const fact of evidence) {
      const rows = bySentence.get(fact.sentence) || [];
      const source = rows.find(row => {
        const offset = row.offset || 0;
        return fact.start >= offset && row.text.slice(fact.start - offset, fact.end - offset) === fact.surface;
      });
      if (!source) continue;
      const quoteStart = fact.start - (source.offset || 0);
      const line = source.text.trim();
      for (let relative = fact.surface.indexOf(word); relative >= 0; relative = fact.surface.indexOf(word, relative + word.length)) {
        const from = quoteStart + relative;
        const before = source.text.slice(Math.max(0, from - 36), from);
        const after = source.text.slice(from + word.length);
        if (humanNameCue.test(before) && endOfName.test(after)) return 'name';
        if (credit.test(line) || facilitySuffix.test(after)) appearsAsNonRole = true;
        else if (line !== word) appearsInOtherContext = true;
      }
    }
    return ordinaryNouns.has(word) || (appearsAsNonRole && !appearsInOtherContext) ? 'nonperson' : kind;
  };
}

export function roleEvidenceKind(fact, classify) {
  if (fact.kind !== 'name' && fact.kind !== 'alias') return fact.kind;
  const kind = classify(fact.surface);
  if (kind === 'name') return fact.kind;
  return kind === 'address' ? 'address' : 'mention';
}

export function applyRoleNamePolicy(state, rows) {
  const classify = createRoleNameClassifier(rows);
  const removed = new Set();
  const scenesOnly = new Map();
  const used = new Set();
  let demoted = 0, aliases = 0, changed = false;
  const repairEvidence = (evidence, corroboration = evidence) => {
    for (const item of evidence) {
      const kind = roleEvidenceKind(item, word => classify(word, corroboration));
      if (kind !== item.kind) {
        item.kind = kind;
        changed = true;
      }
    }
  };
  const repairPerson = (person, kind = classify(person.name || person.label, person.evidence)) => {
    if (kind === 'nonperson') return false;
    if (person.name && kind === 'address') {
      person.label = person.name;
      person.name = '';
      delete person.identityLinks;
      demoted += 1;
      changed = true;
    }
    const cleanAliases = person.name ? person.aliases.filter(alias => classify(alias, person.evidence) === 'name') : [];
    if (cleanAliases.length !== person.aliases.length) {
      aliases += person.aliases.length - cleanAliases.length;
      person.aliases = cleanAliases;
      changed = true;
    }
    repairEvidence(person.evidence);
    return true;
  };
  state.people = state.people.filter(person => {
    const kind = classify(person.name || person.label, person.evidence);
    if (person.name && kind === 'address') scenesOnly.set(person.id, person);
    if (repairPerson(person, kind)) return true;
    removed.add(person.id);
    changed = true;
    return false;
  });
  const people = new Map(state.people.map(person => [person.id, person]));
  for (const scene of state.scenes) {
    scene.roles = scene.roles.filter(role => !removed.has(role.roleId));
    for (const role of scene.roles) {
      repairEvidence(role.evidence, [...role.evidence, ...(people.get(role.roleId)?.evidence || [])]);
      const description = scenesOnly.get(role.roleId);
      if (!description) continue;
      const sentences = role.evidence.map(item => item.sentence);
      const scope = { evidence: [...role.evidence], firstSeen: Math.min(...sentences), lastSeen: Math.max(...sentences) };
      if (!used.has(role.roleId)) {
        used.add(role.roleId);
        Object.assign(description, scope);
      } else {
        const id = 'CH' + String(state.nextId++).padStart(2, '0');
        state.people.push({ ...description, ...scope, id });
        role.roleId = id;
      }
    }
  }
  if (state.draft) {
    state.draft.findings = state.draft.findings.filter(fact => {
      if (!repairPerson(fact)) { changed = true; return false; }
      if (removed.has(fact.knownId) || scenesOnly.has(fact.knownId)) {
        fact.knownId = '';
        changed = true;
      }
      return true;
    });
  }
  if (changed) delete state.review;
  return { changed, demoted, removed: removed.size, aliases };
}

export const lexicon = {
  pronoun: ['他', '她', '它', '我', '你', '您'],
  kinship: ['丈夫', '妻子', '老公', '老婆', '太太', '夫人', '父亲', '母亲', '爸爸', '妈妈', '儿子', '女儿', '哥哥', '姐姐', '弟弟', '妹妹', '岳父', '岳母', '公公', '婆婆', '情人', '爱人'],
  role: ['男人', '女人', '少妇', '老人', '年轻人', '男孩', '女孩', '少年', '少女'],
  collective: ['他们', '她们', '它们', '我们', '你们', '咱们', '大家', '众人', '人群', '对方', '所有人', '其他人'],
};

export const genericPronouns = new Set([
  ...lexicon.pronoun, ...lexicon.collective,
  '自己', '本人', '人家', '别人', '彼此', '咱', '其', '此人', '有人',
]);

export const isTitleSentence = text => /^《.+?》（第[0-9]+章/.test(text.trim());

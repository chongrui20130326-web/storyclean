export const manuscript = '《星海纪事》\r\n序章\r\n我在旧城。\r\n\r\n1.初航\r\n\r\n林舟见到沈棠，他&#x20;朝她走来。\r\n\r\n最新网址https://example.com/\r\n\r\n2.归途\r\n“她来了！”他说。\r\n';
export const input = { name: '下载副本.txt', content: manuscript, bytesBase64: Buffer.from(manuscript, 'utf8').toString('base64') };

export function analyzerModel(calls = []) {
  return ({ model }) => ({ state: { enabled: true, last: { model } }, async chat({ source, prompt }) {
    calls.push({ source, prompt });
    let value;
    switch (source) {
      case 'clean-chapters': value = { rows: [{ index: 4, kind: 'chapter', number: 1 }] }; break;
      case 'clean-chapter-coverage': value = { rows: [{ index: 10, kind: 'chapter', number: 2 }] }; break;
      case 'clean-chapter-review': value = { reject: [] }; break;
      case 'clean-supplementary': value = { rows: [{ index: 1, kind: 'preface' }] }; break;
      case 'segment-scenes-llm.mjs':
        value = { checks: prompt.includes('林舟见到沈棠') ? [{ cut: 5, next: 6, change: '时间', newScene: true }] : [] };
        break;
      case 'mention-mapping.mjs': {
        const targets = JSON.parse(prompt.split('目标人称：')[1].split('\n')[0]);
        value = { mappings: targets.filter(row => row.sentence === 5 && row.surface === '他').map(row => ({
          mentionId: row.id, status: 'mapped', characterIds: ['CH01'], evidence: [{ sentence: 5, quote: '林舟见到沈棠' }],
        })) };
        break;
      }
      case 'build-character-table.mjs':
        if (prompt.startsWith('角色表：')) value = { relations: [] };
        else if (prompt.includes('【待核对身份】')) value = { links: [] };
        else if (prompt.includes('编号原文】')) {
          const line = /^(\d+)\. .*林舟见到沈棠/m.exec(prompt);
          value = { roles: line ? ['林舟', '沈棠'].map(name => ({
            name, status: 'present', evidence: [
              { sentence: Number(line[1]), surface: name, kind: 'name' },
              { sentence: Number(line[1]), surface: '林舟见到沈棠', kind: 'presence' },
            ],
          })) : [] };
        } else value = { characters: [{ 姓名: '林舟', 别名: [] }, { 姓名: '沈棠', 别名: [] }] };
        break;
      default: throw Error('未预期的模型步骤 ' + source);
    }
    return { ok: true, content: JSON.stringify(value) };
  } });
}

